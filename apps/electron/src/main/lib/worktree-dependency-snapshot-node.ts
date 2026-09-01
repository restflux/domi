import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  inspectBunDependencySnapshotProfile,
  type BunDependencySnapshotProfile,
  type InspectBunDependencySnapshotProfileInput,
} from './worktree-dependency-snapshot.ts'

const SNAPSHOT_CONTAINER_NAME = '.domi-dependency-snapshots'
const SNAPSHOT_VERSION_DIR = 'v1'
const DEFAULT_MAX_SNAPSHOTS_PER_REPOSITORY = 2
const DEFAULT_STALE_STAGING_MS = 24 * 60 * 60 * 1000
const ROBOCOPY_TIMEOUT_MS = 5 * 60 * 1000
const SNAPSHOT_KEY_PATTERN = /^[a-f0-9]{64}$/
const STAGING_PREFIXES = ['.publishing-', '.materializing-', '.invalid-'] as const

export interface DependencySnapshotRuntime {
  platform: NodeJS.Platform
  arch: string
  bunVersion: string
  installEnvHash: string
  shellKind?: 'git-bash' | 'wsl'
}

export interface DependencySnapshotTreeStats {
  fileCount: number
  totalBytes: number
  directoryCount: number
}

export interface DependencySnapshotDirectoryInspection {
  tree: DependencySnapshotTreeStats
  skippedDirectoryCount: number
}

export interface DependencySnapshotCopyDirectoryInput {
  source: string
  destination: string
  excludedDirectories: string[]
  signal?: AbortSignal
}

export type DependencySnapshotCopyDirectory = (
  input: DependencySnapshotCopyDirectoryInput,
) => Promise<DependencySnapshotDirectoryInspection>

export type DependencySnapshotInspectDirectory = (
  input: { source: string; signal?: AbortSignal },
) => Promise<DependencySnapshotDirectoryInspection>

export interface WorktreeDependencySnapshotInput {
  projectRoot: string
  localRoot: string
  runtime: DependencySnapshotRuntime
  signal?: AbortSignal
}

export type WorktreeDependencyPrepareResult =
  | { status: 'ready'; durationMs: number; key: string }
  | { status: 'existing'; durationMs: number }
  | { status: 'miss'; durationMs: number; reason?: string }
  | { status: 'skipped'; durationMs: number; reason: string }
  | { status: 'cancelled'; durationMs: number }
  | { status: 'unavailable'; durationMs: number; reason: string }

export type WorktreeDependencyCaptureResult =
  | { status: 'published'; durationMs: number; key: string }
  | { status: 'existing'; durationMs: number; key: string }
  | { status: 'skipped'; durationMs: number; reason: string }
  | { status: 'cancelled'; durationMs: number }
  | { status: 'unavailable'; durationMs: number; reason: string }

interface DependencySnapshotReceipt {
  schemaVersion: 1
  key: string
  profile: BunDependencySnapshotProfile
  tree: DependencySnapshotTreeStats
  createdAt: number
}

export interface WorktreeDependencySnapshotServiceOptions {
  copyDirectory?: DependencySnapshotCopyDirectory
  inspectDirectory?: DependencySnapshotInspectDirectory
  createId?: () => string
  now?: () => number
  maxSnapshotsPerRepository?: number
  staleStagingMs?: number
  disabled?: boolean
  log?: (message: string, error?: unknown) => void
}

interface SnapshotLocation {
  managedGitRoot: string
  containerRoot: string
  versionRoot: string
  repositoryRoot: string
  snapshotRoot: string
}

function elapsed(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt)
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError'
}

async function pathType(path: string): Promise<'missing' | 'directory' | 'symlink' | 'other'> {
  try {
    const value = await lstat(path)
    if (value.isSymbolicLink()) return 'symlink'
    if (value.isDirectory()) return 'directory'
    return 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = resolve(left).replace(/\\/g, '/')
  const normalizedRight = resolve(right).replace(/\\/g, '/')
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

async function canonicalPathsEqual(left: string, right: string): Promise<boolean> {
  try {
    return pathsEqual(await realpath(left), await realpath(right))
  } catch {
    return false
  }
}

function repositoryKey(localRoot: string): string {
  const normalized = resolve(localRoot).replace(/\\/g, '/').toLowerCase()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 24)
}

async function findManagedGitRoot(projectRoot: string): Promise<string | undefined> {
  let current = resolve(projectRoot)
  for (let depth = 0; depth < 32; depth += 1) {
    const gitMarker = join(current, '.git')
    try {
      const marker = await lstat(gitMarker)
      if (marker.isFile() && !marker.isSymbolicLink()) return current
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

async function resolveSnapshotLocation(
  projectRoot: string,
  localRoot: string,
  profileKey: string,
): Promise<SnapshotLocation | undefined> {
  const managedGitRoot = await findManagedGitRoot(projectRoot)
  if (!managedGitRoot) return undefined
  const containerRoot = join(dirname(managedGitRoot), SNAPSHOT_CONTAINER_NAME)
  const versionRoot = join(containerRoot, SNAPSHOT_VERSION_DIR)
  const repoRoot = join(versionRoot, repositoryKey(localRoot))
  return {
    managedGitRoot,
    containerRoot,
    versionRoot,
    repositoryRoot: repoRoot,
    snapshotRoot: join(repoRoot, profileKey),
  }
}

async function ensurePlainDirectory(path: string): Promise<void> {
  let type = await pathType(path)
  if (type === 'missing') {
    try {
      await mkdir(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    type = await pathType(path)
  }
  if (type !== 'directory') throw new Error('unsafe_cache_directory')
}

async function ensureSnapshotRepository(location: SnapshotLocation): Promise<void> {
  await ensurePlainDirectory(location.containerRoot)
  await ensurePlainDirectory(location.versionRoot)
  await ensurePlainDirectory(location.repositoryRoot)
}

function treeStatsEqual(left: DependencySnapshotTreeStats, right: DependencySnapshotTreeStats): boolean {
  return left.fileCount === right.fileCount
    && left.totalBytes === right.totalBytes
    && left.directoryCount === right.directoryCount
}

function isReceipt(value: unknown): value is DependencySnapshotReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const receipt = value as Partial<DependencySnapshotReceipt>
  const tree = receipt.tree as Partial<DependencySnapshotTreeStats> | undefined
  return receipt.schemaVersion === 1
    && typeof receipt.key === 'string'
    && !!receipt.profile
    && typeof receipt.profile === 'object'
    && receipt.profile.schemaVersion === 1
    && receipt.profile.key === receipt.key
    && !!tree
    && Number.isSafeInteger(tree.fileCount) && tree.fileCount! >= 0
    && Number.isSafeInteger(tree.totalBytes) && tree.totalBytes! >= 0
    && Number.isSafeInteger(tree.directoryCount) && tree.directoryCount! >= 0
    && typeof receipt.createdAt === 'number'
}

async function readReceipt(snapshotRoot: string): Promise<DependencySnapshotReceipt | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(snapshotRoot, 'receipt.json'), 'utf8'))
    return isReceipt(value) ? value : undefined
  } catch {
    return undefined
  }
}

function profileInput(input: WorktreeDependencySnapshotInput): InspectBunDependencySnapshotProfileInput {
  return {
    projectRoot: input.projectRoot,
    platform: input.runtime.platform,
    arch: input.runtime.arch,
    bunVersion: input.runtime.bunVersion,
    installEnvHash: input.runtime.installEnvHash,
  }
}

function workspaceLinkPath(nodeModulesRoot: string, packageName: string): string {
  return join(nodeModulesRoot, ...packageName.split('/'))
}

async function verifyWorkspaceLinks(
  projectRoot: string,
  profile: BunDependencySnapshotProfile,
): Promise<boolean> {
  for (const workspace of profile.workspaceLinks) {
    const link = workspaceLinkPath(join(projectRoot, 'node_modules'), workspace.name)
    const expectedTarget = join(projectRoot, workspace.relativePath)
    if (await pathType(link) !== 'symlink' || !await canonicalPathsEqual(link, expectedTarget)) return false
  }
  return true
}

async function createWorkspaceLinks(
  projectRoot: string,
  nodeModulesRoot: string,
  profile: BunDependencySnapshotProfile,
): Promise<void> {
  for (const workspace of profile.workspaceLinks) {
    const target = join(projectRoot, workspace.relativePath)
    const link = workspaceLinkPath(nodeModulesRoot, workspace.name)
    const linkParent = dirname(link)
    await mkdir(linkParent, { recursive: true })
    if (await pathType(link) !== 'missing') throw new Error(`workspace_link_collision:${workspace.name}`)
    if (await pathType(target) !== 'directory') throw new Error(`workspace_target_missing:${workspace.relativePath}`)
    await symlink(target, link, 'junction')
    if (!await canonicalPathsEqual(link, target)) throw new Error(`workspace_link_mismatch:${workspace.name}`)
  }
}

function robocopyArgs(input: DependencySnapshotCopyDirectoryInput, listOnly = false): string[] {
  return [
    input.source,
    input.destination,
    '/E',
    ...(listOnly ? ['/L'] : ['/COPY:DAT', '/DCOPY:DAT', '/MT:32']),
    '/BYTES',
    '/R:0',
    '/W:0',
    '/XJ',
    '/NFL',
    '/NDL',
    '/NJH',
    '/NP',
    ...(input.excludedDirectories.length > 0 ? ['/XD', ...input.excludedDirectories] : []),
  ]
}

/** Parse Robocopy's locale-independent numeric summary rows: directories, files, bytes. */
export function parseRobocopyDirectoryInspection(output: string): DependencySnapshotDirectoryInspection {
  const rows = output
    .split(/\r?\n/)
    .map((line) => line.match(/\d+/g)?.map(Number))
    .filter((row): row is number[] => row?.length === 6 && row.every(Number.isSafeInteger))
  if (rows.length < 3) throw new Error('robocopy_summary_missing')
  const [directories, files, bytes] = rows
  return {
    tree: {
      directoryCount: directories![1]!,
      fileCount: files![1]!,
      totalBytes: bytes![1]!,
    },
    skippedDirectoryCount: directories![2]!,
  }
}

async function runRobocopy(
  input: DependencySnapshotCopyDirectoryInput,
  listOnly: boolean,
): Promise<DependencySnapshotDirectoryInspection> {
  if (input.signal?.aborted) throw abortError()
  if (!listOnly) await mkdir(dirname(input.destination), { recursive: true })
  return new Promise<DependencySnapshotDirectoryInspection>((resolvePromise, reject) => {
    const child = spawn('robocopy.exe', robocopyArgs(input, listOnly), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const chunks: Buffer[] = []
    let capturedBytes = 0
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const capture = (chunk: Buffer): void => {
      if (capturedBytes >= 64 * 1024) return
      chunks.push(chunk)
      capturedBytes += chunk.byteLength
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    const finish = (operation: () => void): void => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      input.signal?.removeEventListener('abort', onAbort)
      operation()
    }
    const onAbort = (): void => {
      child.kill()
      finish(() => reject(abortError()))
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(() => {
      child.kill()
      finish(() => reject(new Error('robocopy_timeout')))
    }, ROBOCOPY_TIMEOUT_MS)
    child.once('error', (error) => finish(() => reject(error)))
    child.once('close', (code) => {
      if (input.signal?.aborted) {
        finish(() => reject(abortError()))
      } else if (code !== null && code >= 0 && code < 8) {
        finish(() => {
          try {
            resolvePromise(parseRobocopyDirectoryInspection(Buffer.concat(chunks).toString('utf8')))
          } catch (error) {
            reject(error)
          }
        })
      } else {
        finish(() => reject(new Error(`robocopy_failed:${code ?? 'null'}`)))
      }
    })
  })
}

/** Windows private copy; Robocopy exit codes 0-7 are successful states. */
export const copyDependencyDirectoryWithRobocopy: DependencySnapshotCopyDirectory = async (input) => (
  runRobocopy(input, false)
)

/** Read-only structural inspection without walking every file through Node stat calls. */
export const inspectDependencyDirectoryWithRobocopy: DependencySnapshotInspectDirectory = async ({ source, signal }) => (
  runRobocopy({
    source,
    destination: join(dirname(source), `.domi-dependency-inspect-${randomUUID()}`),
    excludedDirectories: [],
    signal,
  }, true)
)

async function removeOwnedEntry(path: string): Promise<void> {
  const type = await pathType(path)
  if (type === 'missing') return
  if (type === 'symlink' || type === 'other') {
    await unlink(path)
    return
  }
  await rm(path, { recursive: true, force: true })
}

export class WorktreeDependencySnapshotService {
  private readonly copyDirectory: DependencySnapshotCopyDirectory
  private readonly inspectDirectory: DependencySnapshotInspectDirectory
  private readonly createId: () => string
  private readonly now: () => number
  private readonly maxSnapshotsPerRepository: number
  private readonly staleStagingMs: number
  private readonly disabled: boolean
  private readonly log: (message: string, error?: unknown) => void
  private readonly captureLocks = new Map<string, Promise<WorktreeDependencyCaptureResult>>()
  private readonly activeSnapshotReaders = new Map<string, number>()

  constructor(options: WorktreeDependencySnapshotServiceOptions = {}) {
    this.copyDirectory = options.copyDirectory ?? copyDependencyDirectoryWithRobocopy
    this.inspectDirectory = options.inspectDirectory ?? inspectDependencyDirectoryWithRobocopy
    this.createId = options.createId ?? randomUUID
    this.now = options.now ?? Date.now
    this.maxSnapshotsPerRepository = options.maxSnapshotsPerRepository ?? DEFAULT_MAX_SNAPSHOTS_PER_REPOSITORY
    this.staleStagingMs = options.staleStagingMs ?? DEFAULT_STALE_STAGING_MS
    this.disabled = options.disabled ?? process.env.DOMI_DISABLE_WORKTREE_DEPENDENCY_SNAPSHOTS === '1'
    this.log = options.log ?? ((message, error) => console.warn(message, error ?? ''))
  }

  async prepare(input: WorktreeDependencySnapshotInput): Promise<WorktreeDependencyPrepareResult> {
    const startedAt = performance.now()
    if (this.disabled) return { status: 'skipped', durationMs: elapsed(startedAt), reason: 'disabled' }
    if (input.runtime.shellKind === 'wsl') {
      return { status: 'skipped', durationMs: elapsed(startedAt), reason: 'unsupported_wsl' }
    }
    const existingNodeModulesType = await pathType(join(input.projectRoot, 'node_modules'))
    if (existingNodeModulesType === 'directory') {
      return { status: 'existing', durationMs: elapsed(startedAt) }
    }
    if (existingNodeModulesType !== 'missing') {
      return { status: 'unavailable', durationMs: elapsed(startedAt), reason: 'unsafe_existing_node_modules' }
    }

    let stagingRoot: string | undefined
    let activeSnapshotRoot: string | undefined
    try {
      if (input.signal?.aborted) throw abortError()
      const inspection = await inspectBunDependencySnapshotProfile(profileInput(input))
      if (inspection.status !== 'ready') {
        return { status: 'skipped', durationMs: elapsed(startedAt), reason: inspection.reason }
      }
      const location = await resolveSnapshotLocation(input.projectRoot, input.localRoot, inspection.profile.key)
      if (!location) {
        return { status: 'skipped', durationMs: elapsed(startedAt), reason: 'managed_git_root_missing' }
      }
      await ensureSnapshotRepository(location)
      await this.cleanupStaleStaging(location.repositoryRoot)
      if (await pathType(location.snapshotRoot) === 'missing') {
        return { status: 'miss', durationMs: elapsed(startedAt) }
      }
      activeSnapshotRoot = location.snapshotRoot
      this.retainSnapshotReader(activeSnapshotRoot)
      const receipt = await this.validateSnapshot(location.snapshotRoot, inspection.profile, input.signal)
      if (!receipt) {
        await this.quarantineInvalidSnapshot(location.snapshotRoot, location.repositoryRoot)
        return { status: 'miss', durationMs: elapsed(startedAt), reason: 'corrupt_snapshot' }
      }

      stagingRoot = join(location.repositoryRoot, `.materializing-${this.createId()}`)
      const stagingNodeModules = join(stagingRoot, 'node_modules')
      await mkdir(stagingRoot, { recursive: false })
      const copied = await this.copyDirectory({
        source: join(location.snapshotRoot, 'node_modules'),
        destination: stagingNodeModules,
        excludedDirectories: [],
        signal: input.signal,
      })
      if (copied.skippedDirectoryCount !== 0 || !treeStatsEqual(copied.tree, receipt.tree)) {
        throw new Error('materialized_tree_mismatch')
      }
      await createWorkspaceLinks(input.projectRoot, stagingNodeModules, inspection.profile)
      if (await pathType(join(input.projectRoot, 'node_modules')) !== 'missing') {
        await removeOwnedEntry(stagingRoot)
        return { status: 'existing', durationMs: elapsed(startedAt) }
      }
      await rename(stagingNodeModules, join(input.projectRoot, 'node_modules'))
      await removeOwnedEntry(stagingRoot)
      stagingRoot = undefined
      const touchedAt = new Date(this.now())
      await utimes(location.snapshotRoot, touchedAt, touchedAt).catch(() => undefined)
      await this.collectOldSnapshots(location.repositoryRoot, inspection.profile.key)
      return { status: 'ready', durationMs: elapsed(startedAt), key: inspection.profile.key }
    } catch (error) {
      if (stagingRoot) await removeOwnedEntry(stagingRoot).catch(() => undefined)
      if (isAbortError(error) || input.signal?.aborted) {
        return { status: 'cancelled', durationMs: elapsed(startedAt) }
      }
      this.log('[dependency-snapshot] materialize failed', error)
      return {
        status: 'unavailable',
        durationMs: elapsed(startedAt),
        reason: error instanceof Error ? error.message : String(error),
      }
    } finally {
      if (activeSnapshotRoot) this.releaseSnapshotReader(activeSnapshotRoot)
    }
  }

  capture(input: WorktreeDependencySnapshotInput): Promise<WorktreeDependencyCaptureResult> {
    const lockKey = `${resolve(input.projectRoot)}\0${input.runtime.bunVersion}\0${input.runtime.installEnvHash}`
    const existing = this.captureLocks.get(lockKey)
    if (existing) return existing
    const operation = this.captureUnlocked(input).finally(() => {
      if (this.captureLocks.get(lockKey) === operation) this.captureLocks.delete(lockKey)
    })
    this.captureLocks.set(lockKey, operation)
    return operation
  }

  private async captureUnlocked(input: WorktreeDependencySnapshotInput): Promise<WorktreeDependencyCaptureResult> {
    const startedAt = performance.now()
    if (this.disabled) return { status: 'skipped', durationMs: elapsed(startedAt), reason: 'disabled' }
    if (input.runtime.shellKind === 'wsl') {
      return { status: 'skipped', durationMs: elapsed(startedAt), reason: 'unsupported_wsl' }
    }

    let stagingRoot: string | undefined
    try {
      if (input.signal?.aborted) throw abortError()
      const inspection = await inspectBunDependencySnapshotProfile(profileInput(input))
      if (inspection.status !== 'ready') {
        return { status: 'skipped', durationMs: elapsed(startedAt), reason: inspection.reason }
      }
      if (await pathType(join(input.projectRoot, 'node_modules')) !== 'directory') {
        return { status: 'skipped', durationMs: elapsed(startedAt), reason: 'node_modules_missing' }
      }
      if (!await verifyWorkspaceLinks(input.projectRoot, inspection.profile)) {
        return { status: 'skipped', durationMs: elapsed(startedAt), reason: 'workspace_links_invalid' }
      }

      const location = await resolveSnapshotLocation(input.projectRoot, input.localRoot, inspection.profile.key)
      if (!location) {
        return { status: 'skipped', durationMs: elapsed(startedAt), reason: 'managed_git_root_missing' }
      }
      await ensureSnapshotRepository(location)
      await this.cleanupStaleStaging(location.repositoryRoot)
      const validExisting = await this.validateSnapshot(location.snapshotRoot, inspection.profile, input.signal)
      if (validExisting) {
        return { status: 'existing', durationMs: elapsed(startedAt), key: inspection.profile.key }
      }
      if (await pathType(location.snapshotRoot) !== 'missing') {
        await this.quarantineInvalidSnapshot(location.snapshotRoot, location.repositoryRoot)
      }

      stagingRoot = join(location.repositoryRoot, `.publishing-${this.createId()}`)
      const stagingNodeModules = join(stagingRoot, 'node_modules')
      await mkdir(stagingRoot, { recursive: false })
      const exclusions = inspection.profile.workspaceLinks.map((workspace) => (
        workspaceLinkPath(join(input.projectRoot, 'node_modules'), workspace.name)
      ))
      const copied = await this.copyDirectory({
        source: join(input.projectRoot, 'node_modules'),
        destination: stagingNodeModules,
        excludedDirectories: exclusions,
        signal: input.signal,
      })
      if (copied.skippedDirectoryCount !== inspection.profile.workspaceLinks.length) {
        throw new Error('unexpected_snapshot_reparse_points')
      }

      const stableInspection = await inspectBunDependencySnapshotProfile(profileInput(input))
      if (stableInspection.status !== 'ready' || stableInspection.profile.key !== inspection.profile.key) {
        throw new Error('dependency_profile_changed_during_capture')
      }
      const receipt: DependencySnapshotReceipt = {
        schemaVersion: 1,
        key: inspection.profile.key,
        profile: inspection.profile,
        tree: copied.tree,
        createdAt: this.now(),
      }
      await writeFile(join(stagingRoot, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
      try {
        await rename(stagingRoot, location.snapshotRoot)
        stagingRoot = undefined
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
          throw error
        }
        const winner = await this.validateSnapshot(location.snapshotRoot, inspection.profile, input.signal)
        if (!winner) throw new Error('concurrent_snapshot_invalid')
      }
      if (stagingRoot) await removeOwnedEntry(stagingRoot)
      stagingRoot = undefined
      await this.collectOldSnapshots(location.repositoryRoot, inspection.profile.key)
      return { status: 'published', durationMs: elapsed(startedAt), key: inspection.profile.key }
    } catch (error) {
      if (stagingRoot) await removeOwnedEntry(stagingRoot).catch(() => undefined)
      if (isAbortError(error) || input.signal?.aborted) {
        return { status: 'cancelled', durationMs: elapsed(startedAt) }
      }
      this.log('[dependency-snapshot] capture failed', error)
      return {
        status: 'unavailable',
        durationMs: elapsed(startedAt),
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private retainSnapshotReader(snapshotRoot: string): void {
    this.activeSnapshotReaders.set(snapshotRoot, (this.activeSnapshotReaders.get(snapshotRoot) ?? 0) + 1)
  }

  private releaseSnapshotReader(snapshotRoot: string): void {
    const remaining = (this.activeSnapshotReaders.get(snapshotRoot) ?? 1) - 1
    if (remaining > 0) this.activeSnapshotReaders.set(snapshotRoot, remaining)
    else this.activeSnapshotReaders.delete(snapshotRoot)
  }

  private async validateSnapshot(
    snapshotRoot: string,
    profile: BunDependencySnapshotProfile,
    signal?: AbortSignal,
  ): Promise<DependencySnapshotReceipt | undefined> {
    if (await pathType(snapshotRoot) !== 'directory') return undefined
    const receipt = await readReceipt(snapshotRoot)
    if (!receipt || receipt.key !== profile.key || JSON.stringify(receipt.profile) !== JSON.stringify(profile)) {
      return undefined
    }
    if (await pathType(join(snapshotRoot, 'node_modules')) !== 'directory') return undefined
    const inspected = await this.inspectDirectory({ source: join(snapshotRoot, 'node_modules'), signal })
    return treeStatsEqual(inspected.tree, receipt.tree) && inspected.skippedDirectoryCount === 0
      ? receipt
      : undefined
  }

  private async quarantineInvalidSnapshot(snapshotRoot: string, repositoryRoot: string): Promise<void> {
    if (await pathType(snapshotRoot) === 'missing') return
    const invalid = join(repositoryRoot, `.invalid-${this.createId()}`)
    try {
      await rename(snapshotRoot, invalid)
      await removeOwnedEntry(invalid)
    } catch (error) {
      this.log('[dependency-snapshot] invalid snapshot quarantine failed', error)
    }
  }

  private async cleanupStaleStaging(repositoryRoot: string): Promise<void> {
    let entries
    try {
      entries = await readdir(repositoryRoot, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      if (!STAGING_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue
      const path = join(repositoryRoot, entry.name)
      try {
        const metadata = await lstat(path)
        if (this.now() - metadata.mtimeMs < this.staleStagingMs) continue
        await removeOwnedEntry(path)
      } catch (error) {
        this.log('[dependency-snapshot] stale staging cleanup failed', error)
      }
    }
  }

  private async collectOldSnapshots(repositoryRoot: string, currentKey: string): Promise<void> {
    if (this.maxSnapshotsPerRepository < 1) return
    const entries = await readdir(repositoryRoot, { withFileTypes: true })
    const snapshots: Array<{ name: string; createdAt: number }> = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !SNAPSHOT_KEY_PATTERN.test(entry.name)) continue
      const receipt = await readReceipt(join(repositoryRoot, entry.name))
      if (!receipt || receipt.key !== entry.name) continue
      snapshots.push({ name: entry.name, createdAt: receipt.createdAt })
    }
    snapshots.sort((left, right) => {
      if (left.name === currentKey) return -1
      if (right.name === currentKey) return 1
      return right.createdAt - left.createdAt
    })
    for (const stale of snapshots.slice(this.maxSnapshotsPerRepository)) {
      const staleRoot = join(repositoryRoot, stale.name)
      if (this.activeSnapshotReaders.has(staleRoot)) continue
      await removeOwnedEntry(staleRoot).catch((error) => {
        this.log('[dependency-snapshot] snapshot GC failed', error)
      })
    }
  }
}

let productionService: WorktreeDependencySnapshotService | undefined

/** Process singleton: concurrent Agent sessions must share capture locks and cache ownership. */
export function getWorktreeDependencySnapshotService(): WorktreeDependencySnapshotService {
  productionService ??= new WorktreeDependencySnapshotService()
  return productionService
}

export function resetWorktreeDependencySnapshotServiceForTesting(): void {
  productionService = undefined
}

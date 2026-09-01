import { createHash } from 'node:crypto'
import { opendir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const SNAPSHOT_SCHEMA_VERSION = 1 as const
const SAFE_PACKAGE_NAME = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/
const MAX_LOCK_BYTES = 64 * 1024 * 1024
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const MAX_CONFIG_BYTES = 2 * 1024 * 1024
const MAX_PATCH_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_PATCH_BYTES = 32 * 1024 * 1024
const MAX_PATCH_FILES = 128
const MAX_WORKSPACE_PATTERNS = 32
const MAX_WORKSPACE_CANDIDATES = 512

class SnapshotProfileResourceLimitError extends Error {
  constructor() {
    super('dependency_profile_resource_limit')
    this.name = 'SnapshotProfileResourceLimitError'
  }
}

export interface BunDependencyWorkspaceLink {
  name: string
  relativePath: string
}

export interface BunDependencySnapshotProfile {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION
  key: string
  platform: 'win32'
  arch: string
  bunVersion: string
  installEnvHash: string
  linker: 'hoisted'
  lockHash: string
  manifestHash: string
  configHash: string
  workspaceLinks: BunDependencyWorkspaceLink[]
}

export type BunDependencySnapshotProfileInspection =
  | { status: 'ready'; profile: BunDependencySnapshotProfile }
  | {
      status: 'skipped'
      reason:
        | 'unsupported_platform'
        | 'bun_lock_missing'
        | 'package_manifest_missing'
        | 'invalid_package_manifest'
        | 'unsafe_workspace_pattern'
        | 'unsupported_workspace_pattern'
        | 'invalid_workspace_manifest'
        | 'duplicate_workspace_name'
        | 'unsupported_linker'
        | 'unsafe_patch_path'
        | 'patch_missing'
        | 'resource_limit'
    }

export interface InspectBunDependencySnapshotProfileInput {
  projectRoot: string
  platform: NodeJS.Platform
  arch: string
  bunVersion: string
  installEnvHash: string
}

export interface WorktreeDependencyPreparationPromptInput {
  status: 'ready' | 'miss' | 'unavailable'
  durationMs: number
  reason?: string
}

export interface AgentWorktreeDependencySnapshotEligibilityInput {
  platform: NodeJS.Platform
  arch: string
  targetKind: 'local' | 'isolated'
  ownership: 'owner' | 'inherited'
  workflow: 'direct' | 'plan-first' | 'read-only'
  followupOnly: boolean
  shellKind?: 'git-bash' | 'wsl'
  bun: { available: boolean; version: string | null }
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>
}

export interface AgentWorktreeDependencySnapshotRuntime {
  platform: 'win32'
  arch: string
  bunVersion: string
  installEnvHash: string
  shellKind?: 'git-bash'
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

const INSTALL_ENVIRONMENT_KEY = /^(?:bun_|npm_config_|yarn_|pnpm_|node_env$|path$|cc$|cxx$|python$|ci$)/i

function normalizedInstallEnvironment(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): Array<[string, string]> {
  const normalized = new Map<string, string>()
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || !INSTALL_ENVIRONMENT_KEY.test(key)) continue
    normalized.set(key.toLowerCase(), value)
  }
  return [...normalized.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'))
}

/** Hash only install-relevant environment; receipt never stores raw values or credentials. */
export function hashDependencyInstallEnvironment(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): string {
  return sha256(JSON.stringify(normalizedInstallEnvironment(environment)))
}

function hasUnsupportedInstallEnvironment(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean {
  const values = new Map(normalizedInstallEnvironment(environment))
  const linker = values.get('bun_config_linker') ?? values.get('bun_install_linker') ?? values.get('bun_linker')
  if (linker && linker.toLowerCase() !== 'hoisted') return true
  const globalStore = values.get('bun_install_global_store')?.trim().toLowerCase()
  return !!globalStore && !['0', 'false', 'no', 'off'].includes(globalStore)
}

async function readRequiredFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
  try {
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size > maxBytes) throw new SnapshotProfileResourceLimitError()
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/')
}

function isSafeRelativePath(path: string): boolean {
  if (!path || path.includes('\0') || isAbsolute(path) || WINDOWS_ABSOLUTE_PATH.test(path)) return false
  const normalized = path.replace(/\\/g, '/')
  return !normalized.split('/').some((segment) => segment === '..' || segment === '')
}

function parseWorkspacePatterns(manifest: Record<string, unknown>): string[] | undefined {
  const workspaces = manifest.workspaces
  if (workspaces === undefined) return []
  if (Array.isArray(workspaces) && workspaces.every((item) => typeof item === 'string')) return workspaces
  if (
    workspaces
    && typeof workspaces === 'object'
    && !Array.isArray(workspaces)
    && Array.isArray((workspaces as { packages?: unknown }).packages)
    && (workspaces as { packages: unknown[] }).packages.every((item) => typeof item === 'string')
  ) {
    return (workspaces as { packages: string[] }).packages
  }
  return undefined
}

function resolveInsideRoot(projectRoot: string, relativePath: string): string | undefined {
  if (!isSafeRelativePath(relativePath)) return undefined
  const root = resolve(projectRoot)
  const candidate = resolve(root, relativePath)
  const candidateRelative = relative(root, candidate)
  return candidateRelative && !candidateRelative.startsWith('..') && !isAbsolute(candidateRelative)
    ? candidate
    : undefined
}

async function workspaceDirectories(projectRoot: string, pattern: string): Promise<string[] | undefined> {
  const normalized = pattern.replace(/\\/g, '/').replace(/\/$/, '')
  if (!isSafeRelativePath(normalized.replace(/\/\*$/, '/placeholder'))) return undefined
  if (!normalized.includes('*')) return [normalized]
  if (!normalized.endsWith('/*') || normalized.slice(0, -2).includes('*')) return undefined

  const parentRelative = normalized.slice(0, -2)
  const parent = resolveInsideRoot(projectRoot, parentRelative)
  if (!parent) return undefined
  try {
    const directories: string[] = []
    const entries = await opendir(parent)
    for await (const entry of entries) {
      if (!entry.isDirectory()) continue
      directories.push(`${parentRelative}/${entry.name}`)
      if (directories.length > MAX_WORKSPACE_CANDIDATES) throw new SnapshotProfileResourceLimitError()
    }
    return directories.sort((left, right) => left.localeCompare(right, 'en'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function parseJsonObject(buffer: Buffer): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(buffer.toString('utf8'))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function linkerFromBunfig(content: Buffer | undefined): 'hoisted' | 'unsupported' {
  if (!content) return 'hoisted'
  const match = content.toString('utf8').match(/^\s*linker\s*=\s*["']([^"']+)["']/m)
  if (!match || match[1] === 'hoisted') return 'hoisted'
  return 'unsupported'
}

async function hashConfiguredFiles(
  projectRoot: string,
  rootManifest: Record<string, unknown>,
  bunfig: Buffer | undefined,
): Promise<{ hash: string } | { reason: 'unsafe_patch_path' | 'patch_missing' }> {
  const entries: Array<{ path: string; hash: string }> = []
  if (bunfig) entries.push({ path: 'bunfig.toml', hash: sha256(bunfig) })

  const patched = rootManifest.patchedDependencies
  if (patched !== undefined) {
    if (!patched || typeof patched !== 'object' || Array.isArray(patched)) {
      return { reason: 'unsafe_patch_path' }
    }
    const patchPaths = Object.values(patched)
    if (!patchPaths.every((value) => typeof value === 'string')) return { reason: 'unsafe_patch_path' }
    if (patchPaths.length > MAX_PATCH_FILES) throw new SnapshotProfileResourceLimitError()
    let totalPatchBytes = 0
    for (const patchPath of [...patchPaths as string[]].sort((left, right) => left.localeCompare(right, 'en'))) {
      const absolutePath = resolveInsideRoot(projectRoot, patchPath)
      if (!absolutePath) return { reason: 'unsafe_patch_path' }
      const content = await readRequiredFile(absolutePath, MAX_PATCH_BYTES)
      if (!content) return { reason: 'patch_missing' }
      totalPatchBytes += content.byteLength
      if (totalPatchBytes > MAX_TOTAL_PATCH_BYTES) throw new SnapshotProfileResourceLimitError()
      entries.push({ path: patchPath.replace(/\\/g, '/'), hash: sha256(content) })
    }
  }
  return { hash: sha256(JSON.stringify(entries)) }
}

async function inspectBunDependencySnapshotProfileUnchecked(
  input: InspectBunDependencySnapshotProfileInput,
): Promise<BunDependencySnapshotProfileInspection> {
  if (input.platform !== 'win32') return { status: 'skipped', reason: 'unsupported_platform' }

  const projectRoot = resolve(input.projectRoot)
  const lock = await readRequiredFile(join(projectRoot, 'bun.lock'), MAX_LOCK_BYTES)
  if (!lock) return { status: 'skipped', reason: 'bun_lock_missing' }
  const rootManifestBuffer = await readRequiredFile(join(projectRoot, 'package.json'), MAX_MANIFEST_BYTES)
  if (!rootManifestBuffer) return { status: 'skipped', reason: 'package_manifest_missing' }
  const rootManifest = parseJsonObject(rootManifestBuffer)
  if (!rootManifest) return { status: 'skipped', reason: 'invalid_package_manifest' }

  const patterns = parseWorkspacePatterns(rootManifest)
  if (!patterns) return { status: 'skipped', reason: 'invalid_package_manifest' }
  if (patterns.length > MAX_WORKSPACE_PATTERNS) throw new SnapshotProfileResourceLimitError()

  const workspaceRelativePaths: string[] = []
  for (const pattern of patterns) {
    if (!isSafeRelativePath(pattern.replace(/\\/g, '/').replace(/\/\*$/, '/placeholder'))) {
      return { status: 'skipped', reason: 'unsafe_workspace_pattern' }
    }
    const directories = await workspaceDirectories(projectRoot, pattern)
    if (!directories) {
      const reason = pattern.includes('*') ? 'unsupported_workspace_pattern' : 'unsafe_workspace_pattern'
      return { status: 'skipped', reason }
    }
    workspaceRelativePaths.push(...directories)
    if (workspaceRelativePaths.length > MAX_WORKSPACE_CANDIDATES) {
      throw new SnapshotProfileResourceLimitError()
    }
  }

  const workspaceLinks: BunDependencyWorkspaceLink[] = []
  const manifestEntries: Array<{ path: string; hash: string }> = [
    { path: 'package.json', hash: sha256(rootManifestBuffer) },
  ]
  const names = new Set<string>()
  for (const relativePath of [...new Set(workspaceRelativePaths)].sort((left, right) => left.localeCompare(right, 'en'))) {
    const workspaceRoot = resolveInsideRoot(projectRoot, relativePath)
    if (!workspaceRoot) return { status: 'skipped', reason: 'unsafe_workspace_pattern' }
    const manifestBuffer = await readRequiredFile(join(workspaceRoot, 'package.json'), MAX_MANIFEST_BYTES)
    if (!manifestBuffer) continue
    const manifest = parseJsonObject(manifestBuffer)
    const name = manifest?.name
    if (typeof name !== 'string' || !SAFE_PACKAGE_NAME.test(name)) {
      return { status: 'skipped', reason: 'invalid_workspace_manifest' }
    }
    if (names.has(name)) return { status: 'skipped', reason: 'duplicate_workspace_name' }
    names.add(name)
    const normalizedRelativePath = normalizeRelativePath(relative(projectRoot, workspaceRoot))
    workspaceLinks.push({ name, relativePath: normalizedRelativePath })
    manifestEntries.push({ path: `${normalizedRelativePath}/package.json`, hash: sha256(manifestBuffer) })
  }
  workspaceLinks.sort((left, right) => left.name.localeCompare(right.name, 'en'))
  manifestEntries.sort((left, right) => left.path.localeCompare(right.path, 'en'))

  const bunfig = await readRequiredFile(join(projectRoot, 'bunfig.toml'), MAX_CONFIG_BYTES)
  if (linkerFromBunfig(bunfig) !== 'hoisted') {
    return { status: 'skipped', reason: 'unsupported_linker' }
  }
  const config = await hashConfiguredFiles(projectRoot, rootManifest, bunfig)
  if ('reason' in config) return { status: 'skipped', reason: config.reason }

  const exactInput = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    platform: 'win32' as const,
    arch: input.arch,
    bunVersion: input.bunVersion,
    installEnvHash: input.installEnvHash,
    linker: 'hoisted' as const,
    lockHash: sha256(lock),
    manifestHash: sha256(JSON.stringify(manifestEntries)),
    configHash: config.hash,
    workspaceLinks,
  }
  return {
    status: 'ready',
    profile: {
      ...exactInput,
      key: sha256(JSON.stringify(exactInput)),
    },
  }
}

/** Build an exact, path-free and resource-bounded dependency profile. */
export async function inspectBunDependencySnapshotProfile(
  input: InspectBunDependencySnapshotProfileInput,
): Promise<BunDependencySnapshotProfileInspection> {
  try {
    return await inspectBunDependencySnapshotProfileUnchecked(input)
  } catch (error) {
    if (error instanceof SnapshotProfileResourceLimitError) {
      return { status: 'skipped', reason: 'resource_limit' }
    }
    throw error
  }
}

/** Host eligibility only; this never changes Session Target, Workflow, or tool authorization. */
export function resolveAgentWorktreeDependencySnapshotRuntime(
  input: AgentWorktreeDependencySnapshotEligibilityInput,
): AgentWorktreeDependencySnapshotRuntime | undefined {
  if (
    input.platform !== 'win32'
    || input.targetKind !== 'isolated'
    || input.ownership !== 'owner'
    || input.workflow !== 'direct'
    || input.followupOnly
    || input.shellKind === 'wsl'
    || hasUnsupportedInstallEnvironment(input.environment)
    || !input.bun.available
    || !input.bun.version
  ) return undefined
  return {
    platform: 'win32',
    arch: input.arch,
    bunVersion: input.bun.version,
    installEnvHash: hashDependencyInstallEnvironment(input.environment),
    ...(input.shellKind === 'git-bash' && { shellKind: 'git-bash' as const }),
  }
}

/** Only an exact, already-authorized full frozen install may seed a snapshot. */
export function isExactFrozenBunInstallCommand(command: string): boolean {
  return /^\s*bun(?:\.exe)?\s+install\s+--frozen-lockfile\s*$/i.test(command)
}

/** Truthful prompt note: preparation never implies that validation ran or passed. */
export function buildWorktreeDependencyPreparationPrompt(
  input: WorktreeDependencyPreparationPromptInput,
): string {
  if (input.status === 'ready') {
    return `## Worktree 依赖环境\n\nDomi 的精确版本私有依赖快照已物化到当前 Worktree（${Math.round(input.durationMs)}ms）。这只表示依赖环境已准备，不表示任何测试已经运行或通过。`
  }
  if (input.status === 'miss') {
    return '## Worktree 依赖环境\n\n当前没有精确匹配的依赖快照；本轮仍可能需要按现有 Execution Policy 执行 `bun install --frozen-lockfile`。不要用修改 lockfile 或 tsconfig 掩盖缺少依赖。'
  }
  return `## Worktree 依赖环境\n\nDomi 未能使用依赖快照${input.reason ? `（${input.reason}）` : ''}；请按普通 Fresh Worktree 处理，并保持既有安装审批与安全边界。`
}

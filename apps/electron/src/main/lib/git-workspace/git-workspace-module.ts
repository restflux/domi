import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import type {
  GitRepositorySnapshot,
  GitWorkspaceBranchesResult,
  GitWorkspaceChangeLayer,
  GitWorkspaceChangeStatus,
  GitWorkspaceCommitDiffRequest,
  GitWorkspaceCommitFileEntry,
  GitWorkspaceCommitFilesRequest,
  GitWorkspaceCommitFilesResult,
  GitWorkspaceCommitRequest,
  GitWorkspaceCheckoutRequest,
  GitWorkspaceDiffContents,
  GitWorkspaceDiffRequest,
  GitWorkspaceDiscardRequest,
  GitWorkspaceFileChange,
  GitWorkspaceHistoryResult,
  GitWorkspaceLogEntry,
  GitWorkspaceOperationResult,
  GitWorkspacePullPushRequest,
  GitWorkspaceRef,
  GitWorkspaceSnapshot,
  GitWorkspaceStageRequest,
} from '@domi/shared'
import { runGitCommand, type CommandResult } from './git-command-runner.ts'
import {
  entryLayers,
  parseGitNumstat,
  parseGitPorcelainV2,
  statusForGitCode,
  type ParsedGitStatusEntry,
} from './git-porcelain-v2.ts'

const CACHE_TTL_MS = 350
const MAX_DIFF_FILE_BYTES = 5 * 1024 * 1024
const LOG_FIELD_SEP = '\x1f'

/** 解析 git log %D refs 字段（`HEAD -> main, tag: v1.0.0, origin/main`）。 */
/** diff-tree --name-status 状态码 → 公开状态（避免依赖 porcelain 的 indexCode 语义）。 */
const COMMIT_FILE_STATUS: Record<string, GitWorkspaceChangeStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
  U: 'conflicted',
}

/**
 * 从 git 命令失败输出中提取用户可读错误信息。
 * 优先包含错误关键词的行；其次过滤 hint/To/Updating 提示行后取末行；空输出兜底。
 */
export function extractGitErrorMessage(result: CommandResult): string {
  const text = (result.stderr || result.stdout || '').trim()
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return 'Git 命令失败。'
  const errorLine = lines.find((line) => (
    /error:|fatal:|\[rejected\]|\[remote rejected\]|\[remote failure\]|CONFLICT|无法|拒绝/.test(line)
  ))
  if (errorLine) return errorLine
  const meaningful = lines.filter((line) => (
    !/^hint:/i.test(line) && !line.startsWith('To ') && !line.startsWith('Updating ')
  ))
  return meaningful[meaningful.length - 1] ?? lines[lines.length - 1]!
}

function parseRefs(refsField: string): GitWorkspaceRef[] {
  if (!refsField) return []
  const refs: GitWorkspaceRef[] = []
  for (const part of refsField.split(', ')) {
    const p = part.trim()
    if (!p) continue
    if (p.startsWith('tag: ')) refs.push({ kind: 'tag', name: p.slice(5) })
    else if (p.startsWith('HEAD -> ')) refs.push({ kind: 'head', name: p.slice(8) })
    else if (p === 'HEAD') refs.push({ kind: 'head', name: 'HEAD' })
    else if (p.includes('/')) refs.push({ kind: 'remote', name: p })
    else refs.push({ kind: 'branch', name: p })
  }
  return refs
}

interface GitWorkspaceModuleDependencies {
  now?: () => number
  findRoots?: (root: string) => Promise<string[]>
  runGit?: (args: readonly string[], cwd: string, options?: { timeoutMs?: number; dedupeKey?: string; stdin?: string }) => Promise<CommandResult>
}

interface InternalChange {
  publicChange: GitWorkspaceFileChange
  repositoryPath: string
}

interface InternalRepository {
  root: string
  publicSnapshot: GitRepositorySnapshot
  changes: Map<string, InternalChange>
}

interface InternalSnapshot {
  publicSnapshot: GitWorkspaceSnapshot
  repositories: InternalRepository[]
}

interface CacheEntry {
  expiresAt: number
  value: InternalSnapshot
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeGitRoot(value: string): string {
  return resolve(value).replace(/\\/g, '/')
}

function comparablePath(value: string): string {
  const normalized = normalizeGitRoot(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function canonicalRoot(value: string): string | null {
  try {
    return realpathSync(resolve(value))
  } catch {
    return null
  }
}

function safeRelativePath(value: string): boolean {
  return Boolean(value)
    && !isAbsolute(value)
    && !win32.isAbsolute(value)
    && !value.replace(/\\/g, '/').split('/').includes('..')
    && !value.includes('\0')
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

function projectRepositoryPath(targetRoot: string, repositoryRoot: string, repositoryPath: string): string | null {
  if (!safeRelativePath(repositoryPath)) return null
  const nestedRepositoryPrefix = relative(targetRoot, repositoryRoot)
  if (isInside(targetRoot, repositoryRoot)) {
    return toPosix(nestedRepositoryPrefix ? join(nestedRepositoryPrefix, repositoryPath) : repositoryPath)
  }

  if (!isInside(repositoryRoot, targetRoot)) return null
  const projectPrefix = toPosix(relative(repositoryRoot, targetRoot)).replace(/\/$/, '')
  const normalizedPath = toPosix(repositoryPath)
  if (!projectPrefix) return normalizedPath
  const prefix = `${projectPrefix}/`
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : null
}

function displayNameForRepository(targetRoot: string, repositoryRoot: string): string {
  const nested = toPosix(relative(targetRoot, repositoryRoot))
  return nested && nested !== '.' && !nested.startsWith('../') ? nested : basename(repositoryRoot)
}

function statsForLayer(
  layer: GitWorkspaceChangeLayer,
  repositoryPath: string,
  stagedStats: Map<string, { additions: number; deletions: number }>,
  unstagedStats: Map<string, { additions: number; deletions: number }>,
): { additions: number; deletions: number } {
  if (layer === 'staged') return stagedStats.get(repositoryPath) ?? { additions: 0, deletions: 0 }
  if (layer === 'unstaged') return unstagedStats.get(repositoryPath) ?? { additions: 0, deletions: 0 }
  return { additions: 0, deletions: 0 }
}

function statusForLayer(entry: ParsedGitStatusEntry, layer: GitWorkspaceChangeLayer) {
  if (layer === 'conflict') return 'conflicted' as const
  if (layer === 'untracked') return 'untracked' as const
  return statusForGitCode(layer === 'staged' ? entry.indexCode : entry.worktreeCode)
}

function changeKey(layer: GitWorkspaceChangeLayer, relativePath: string): string {
  return `${layer}\0${relativePath}`
}

export class GitWorkspaceModule {
  private readonly now: () => number
  private readonly providedFindRoots?: (root: string) => Promise<string[]>
  private readonly runGit: NonNullable<GitWorkspaceModuleDependencies['runGit']>
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<InternalSnapshot>>()

  constructor(dependencies: GitWorkspaceModuleDependencies = {}) {
    this.now = dependencies.now ?? Date.now
    this.providedFindRoots = dependencies.findRoots
    this.runGit = dependencies.runGit ?? runGitCommand
  }

  async inspect(
    targetRootInput: string,
    targetKind: 'local' | 'isolated',
    force = false,
  ): Promise<GitWorkspaceSnapshot> {
    return (await this.inspectInternal(targetRootInput, targetKind, force)).publicSnapshot
  }

  async inspectHistory(
    targetRootInput: string,
    request: { repositoryId: string; limit?: number },
  ): Promise<GitWorkspaceHistoryResult> {
    const limit = Math.min(Math.max(request.limit ?? 30, 1), 200)
    const internal = await this.inspectInternal(targetRootInput, 'local', true)
    const repository = internal.repositories.find(
      (item) => item.publicSnapshot.repositoryId === request.repositoryId,
    )
    if (!repository) return { entries: [] }
    const revisions = repository.publicSnapshot.upstream
      ? ['HEAD', repository.publicSnapshot.upstream]
      : ['HEAD']
    const result = await this.runGit(
      [
        'log', '-n', String(limit),
        '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%P%x1f%B%x1e',
        ...revisions,
      ],
      repository.root,
      { timeoutMs: 10_000 },
    )
    if (!result.ok) return { entries: [] }

    const rawRecords: { oid: string; fields: string[] }[] = []
    for (const record of result.stdout.split('\x1e')) {
      if (!record) continue
      const fields = record.split(LOG_FIELD_SEP)
      // git log 每条记录后自动追加换行，记录间形如 ...\x1e\n...；trim 掉前导换行
      const oid = fields[0]?.trim()
      // 尾部伪记录（仅含 \n）与异常字段直接跳过；严格校验完整哈希
      if (!oid || !/^[0-9a-f]{40}$/.test(oid)) continue
      rawRecords.push({ oid, fields })
    }

    const reachable = await this.resolveRemoteReachableSet(
      repository,
      rawRecords.map((record) => record.oid),
    )
    const entries: GitWorkspaceLogEntry[] = rawRecords.map(({ oid, fields }) => {
      const [shortOid, subject, authorName, authorEmail, at, refs, parents, rawBody] = fields.slice(1)
      const body = rawBody
        ? rawBody.split('\n').slice(1).join('\n').trim()
        : ''
      return {
        oid,
        shortOid: shortOid ?? oid.slice(0, 7),
        subject: subject ?? '',
        authorName: authorName ?? '',
        authorEmail: authorEmail ?? '',
        authorDate: Number(at ?? 0),
        refs: parseRefs(refs ?? ''),
        parents: (parents ?? '').split(' ').filter(Boolean),
        onRemote: reachable.has(oid),
        ...(body ? { body } : {}),
      }
    })
    return { entries }
  }

  /**
   * 计算远端可达 oid 集合（upstream 祖先闭包）。
   * rev-list 输出超过 50_000 行时降级为逐条 merge-base 判定；失败时保守返回空集合。
   */
  private async resolveRemoteReachableSet(
    repository: InternalRepository,
    oids: string[],
  ): Promise<Set<string>> {
    const upstream = repository.publicSnapshot.upstream
    if (!upstream || oids.length === 0) return new Set()
    const revList = await this.runGit(
      ['rev-list', upstream],
      repository.root,
      { timeoutMs: 10_000 },
    )
    if (!revList.ok) return new Set()
    const lines = revList.stdout.split('\n').filter(Boolean)
    if (lines.length <= 50_000) return new Set(lines)
    // 大仓库降级：逐条 merge-base --is-ancestor（exit 0 = 是祖先）
    const results = await Promise.all(oids.map(async (oid) => {
      const check = await this.runGit(
        ['merge-base', '--is-ancestor', oid, upstream],
        repository.root,
        { timeoutMs: 5_000 },
      )
      return check.ok ? oid : null
    }))
    return new Set(results.filter((oid): oid is string => oid !== null))
  }

  private async inspectInternal(
    targetRootInput: string,
    targetKind: 'local' | 'isolated',
    force: boolean,
  ): Promise<InternalSnapshot> {
    const targetRoot = canonicalRoot(targetRootInput)
    if (!targetRoot) {
      return {
        repositories: [],
        publicSnapshot: {
          target: { kind: targetKind },
          repositories: [],
          scannedAt: this.now(),
          error: { code: 'target-unavailable', message: '工作环境暂不可用。' },
        },
      }
    }

    const cacheKey = comparablePath(targetRoot)
    const cached = this.cache.get(cacheKey)
    if (!force && cached && cached.expiresAt > this.now()) return cached.value
    const running = this.inFlight.get(cacheKey)
    if (running) return running

    const promise = this.scanTarget(targetRoot, targetKind)
      .then((value) => {
        this.cache.set(cacheKey, { expiresAt: this.now() + CACHE_TTL_MS, value })
        return value
      })
      .finally(() => {
        if (this.inFlight.get(cacheKey) === promise) this.inFlight.delete(cacheKey)
      })
    this.inFlight.set(cacheKey, promise)
    return promise
  }

  private async discoverRoots(targetRoot: string): Promise<string[]> {
    const roots = new Map<string, string>()
    const upward = await this.runGit(
      ['rev-parse', '--show-toplevel'],
      targetRoot,
      { timeoutMs: 10_000, dedupeKey: `${comparablePath(targetRoot)}:show-toplevel` },
    )
    if (upward.ok && upward.stdout.trim()) {
      const root = canonicalRoot(upward.stdout.trim())
      if (root) roots.set(comparablePath(root), root)
    }

    const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.cache', 'target'])
    const visit = (directory: string, depth: number): void => {
      if (depth < 0) return
      let entries: string[]
      try { entries = readdirSync(directory) } catch { return }
      for (const name of entries) {
        if (skip.has(name) || (name.startsWith('.') && name !== '.git')) continue
        const child = join(directory, name)
        let stats
        try { stats = statSync(child) } catch { continue }
        if (!stats.isDirectory()) continue
        if (existsSync(join(child, '.git'))) {
          const root = canonicalRoot(child)
          if (root) roots.set(comparablePath(root), root)
          continue
        }
        visit(child, depth - 1)
      }
    }
    if (existsSync(join(targetRoot, '.git'))) roots.set(comparablePath(targetRoot), targetRoot)
    visit(targetRoot, 4)
    return [...roots.values()]
  }

  private async scanTarget(targetRoot: string, targetKind: 'local' | 'isolated'): Promise<InternalSnapshot> {
    const scannedAt = this.now()
    const discovered = this.providedFindRoots
      ? await this.providedFindRoots(targetRoot)
      : await this.discoverRoots(targetRoot)
    const roots = [...new Map(discovered.map((root) => [comparablePath(root), canonicalRoot(root)])).values()]
      .filter((root): root is string => Boolean(root))
      .filter((root) => isInside(root, targetRoot) || isInside(targetRoot, root))

    if (roots.length === 0) {
      return {
        repositories: [],
        publicSnapshot: { target: { kind: targetKind }, repositories: [], scannedAt },
      }
    }

    try {
      const repositories = await Promise.all(roots.map((root) => this.scanRepository(targetRoot, root)))
      repositories.sort((a, b) => a.publicSnapshot.displayName.localeCompare(b.publicSnapshot.displayName))
      return {
        repositories,
        publicSnapshot: {
          target: { kind: targetKind },
          repositories: repositories.map((repository) => repository.publicSnapshot),
          scannedAt,
        },
      }
    } catch {
      return {
        repositories: [],
        publicSnapshot: {
          target: { kind: targetKind },
          repositories: [],
          scannedAt,
          error: { code: 'scan-failed', message: '无法读取 Git 工作区状态，请稍后重试。' },
        },
      }
    }
  }

  private async scanRepository(targetRoot: string, repositoryRoot: string): Promise<InternalRepository> {
    const dedupePrefix = comparablePath(repositoryRoot)
    const [statusResult, stagedResult, unstagedResult] = await Promise.all([
      this.runGit(
        ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'],
        repositoryRoot,
        { timeoutMs: 10_000, dedupeKey: `${dedupePrefix}:status` },
      ),
      this.runGit(
        ['diff', '--cached', '--numstat', '-z', '--'],
        repositoryRoot,
        { timeoutMs: 10_000, dedupeKey: `${dedupePrefix}:staged-numstat` },
      ),
      this.runGit(
        ['diff', '--numstat', '-z', '--'],
        repositoryRoot,
        { timeoutMs: 10_000, dedupeKey: `${dedupePrefix}:unstaged-numstat` },
      ),
    ])
    if (!statusResult.ok) throw new Error('git status failed')

    const parsed = parseGitPorcelainV2(statusResult.stdout)
    const stagedStats = stagedResult.ok ? parseGitNumstat(stagedResult.stdout) : new Map()
    const unstagedStats = unstagedResult.ok ? parseGitNumstat(unstagedResult.stdout) : new Map()
    const grouped = {
      conflict: [] as GitWorkspaceFileChange[],
      staged: [] as GitWorkspaceFileChange[],
      unstaged: [] as GitWorkspaceFileChange[],
      untracked: [] as GitWorkspaceFileChange[],
    }
    const changes = new Map<string, InternalChange>()

    for (const entry of parsed.entries) {
      const relativePath = projectRepositoryPath(targetRoot, repositoryRoot, entry.repositoryPath)
      if (!relativePath) continue
      const previousPath = entry.previousRepositoryPath
        ? projectRepositoryPath(targetRoot, repositoryRoot, entry.previousRepositoryPath) ?? undefined
        : undefined
      for (const layer of entryLayers(entry)) {
        const stats = statsForLayer(layer, entry.repositoryPath, stagedStats, unstagedStats)
        const publicChange: GitWorkspaceFileChange = {
          relativePath,
          ...(previousPath ? { previousPath } : {}),
          layer,
          status: statusForLayer(entry, layer),
          additions: stats.additions,
          deletions: stats.deletions,
        }
        grouped[layer].push(publicChange)
        changes.set(changeKey(layer, relativePath), {
          publicChange,
          repositoryPath: entry.repositoryPath,
        })
      }
    }

    for (const list of Object.values(grouped)) {
      list.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    }

    const repositoryId = `repo-${hash(comparablePath(repositoryRoot)).slice(0, 16)}`
    const stateToken = hash(JSON.stringify({
      head: parsed.header.headOid,
      branch: parsed.header.branch,
      upstream: parsed.header.upstream,
      ahead: parsed.header.ahead,
      behind: parsed.header.behind,
      changes: [...changes.keys()],
    })).slice(0, 24)
    const publicSnapshot: GitRepositorySnapshot = {
      repositoryId,
      displayName: displayNameForRepository(targetRoot, repositoryRoot),
      branch: parsed.header.branch,
      detached: parsed.header.detached,
      unborn: parsed.header.unborn,
      headOid: parsed.header.headOid,
      upstream: parsed.header.upstream,
      ahead: parsed.header.ahead,
      behind: parsed.header.behind,
      conflicts: grouped.conflict,
      staged: grouped.staged,
      unstaged: grouped.unstaged,
      untracked: grouped.untracked,
      stateToken,
    }
    return { root: repositoryRoot, publicSnapshot, changes }
  }

  async getDiffContents(
    targetRootInput: string,
    targetKind: 'local' | 'isolated',
    request: Omit<GitWorkspaceDiffRequest, 'sessionId'>,
  ): Promise<GitWorkspaceDiffContents | null> {
    if (!safeRelativePath(request.relativePath)) return null
    const internal = await this.inspectInternal(targetRootInput, targetKind, true)
    const repository = internal.repositories.find((item) => item.publicSnapshot.repositoryId === request.repositoryId)
    const change = repository?.changes.get(changeKey(request.layer, toPosix(request.relativePath)))
    if (!repository || !change) return null

    const workingContent = (): string => this.readWorkingFile(targetRootInput, request.relativePath)
    const headContent = async (): Promise<string | null> => this.readGitObject(repository.root, `HEAD:${change.repositoryPath}`)
    const indexContent = async (): Promise<string | null> => this.readGitObject(repository.root, `:${change.repositoryPath}`)

    if (request.layer === 'untracked') {
      return { oldContent: '', newContent: workingContent() }
    }
    if (request.layer === 'staged') {
      return { oldContent: await headContent() ?? '', newContent: await indexContent() ?? '' }
    }
    if (request.layer === 'unstaged') {
      const indexed = await indexContent()
      return { oldContent: indexed ?? await headContent() ?? '', newContent: workingContent() }
    }
    const head = await headContent()
    const ours = await this.readGitObject(repository.root, `:2:${change.repositoryPath}`)
    return { oldContent: head ?? ours ?? '', newContent: workingContent() }
  }

  /** 定位仓库（repositoryId → 内部仓库对象），供只读/写操作复用。 */
  private async locateRepository(
    targetRootInput: string,
    repositoryId: string,
  ): Promise<InternalRepository | null> {
    const internal = await this.inspectInternal(targetRootInput, 'local', true)
    return internal.repositories.find(
      (item) => item.publicSnapshot.repositoryId === repositoryId,
    ) ?? null
  }

  async listLocalBranches(
    targetRootInput: string,
    repositoryId: string,
  ): Promise<GitWorkspaceBranchesResult> {
    const repository = await this.locateRepository(targetRootInput, repositoryId)
    if (!repository) return { current: null, local: [] }
    const result = await this.runGit(
      ['branch', '--format=%(HEAD)%00%(refname:short)'],
      repository.root,
      { timeoutMs: 10_000 },
    )
    if (!result.ok) return { current: null, local: [] }
    const local: string[] = []
    let current: string | null = null
    for (const line of result.stdout.split('\n')) {
      if (!line) continue
      const [head, name] = line.split('\0')
      if (!name) continue
      local.push(name)
      if (head === '*') current = name
    }
    return { current, local }
  }

  async getCommitFiles(
    targetRootInput: string,
    request: Omit<GitWorkspaceCommitFilesRequest, 'sessionId'>,
  ): Promise<GitWorkspaceCommitFilesResult> {
    if (!/^[0-9a-f]{7,40}$/.test(request.oid)) return { files: [] }
    const repository = await this.locateRepository(targetRootInput, request.repositoryId)
    if (!repository) return { files: [] }
    const result = await this.runGit(
      ['diff-tree', '--no-commit-id', '--name-status', '-r', '-z', request.oid],
      repository.root,
      { timeoutMs: 10_000 },
    )
    if (!result.ok) return { files: [] }
    const files: GitWorkspaceCommitFileEntry[] = []
    const tokens = result.stdout.split('\0')
    let i = 0
    while (i < tokens.length) {
      const statusToken = tokens[i++]
      if (statusToken === undefined) break
      const code = statusToken[0] ?? ''
      // rename/copy 后跟旧路径，跳过
      if (code === 'R' || code === 'C') i++
      const path = tokens[i++]
      if (path === undefined) break
      if (!path) continue
      files.push({
        relativePath: toPosix(path),
        status: COMMIT_FILE_STATUS[code] ?? 'modified',
      })
    }
    return { files }
  }

  async getCommitDiffContents(
    targetRootInput: string,
    request: Omit<GitWorkspaceCommitDiffRequest, 'sessionId'>,
  ): Promise<GitWorkspaceDiffContents | null> {
    if (!safeRelativePath(request.relativePath)) return null
    if (!/^[0-9a-f]{7,40}$/.test(request.oid)) return null
    const repository = await this.locateRepository(targetRootInput, request.repositoryId)
    if (!repository) return null
    const pathSpec = toPosix(request.relativePath)
    const newContent = await this.readGitObject(repository.root, `${request.oid}:${pathSpec}`)
    const parentResult = await this.runGit(
      ['rev-parse', '--verify', '--quiet', `${request.oid}^^{commit}`],
      repository.root,
      { timeoutMs: 5_000 },
    )
    let oldContent: string | null = null
    if (parentResult.ok && parentResult.stdout.trim()) {
      oldContent = await this.readGitObject(repository.root, `${parentResult.stdout.trim()}:${pathSpec}`)
    }
    return { oldContent: oldContent ?? '', newContent: newContent ?? '' }
  }

  /** 写操作后失效快照缓存与 in-flight，令下次 inspect 强制重扫。 */
  private invalidate(targetRootInput: string): void {
    const targetRoot = canonicalRoot(targetRootInput)
    if (!targetRoot) return
    this.cache.delete(comparablePath(targetRoot))
    this.inFlight.delete(comparablePath(targetRoot))
  }

  /** 从 git 命令失败输出中提取用户可读错误：优先错误关键词行，其次过滤提示行取末行。 */
  private gitError(result: CommandResult): string {
    return extractGitErrorMessage(result)
  }

  async stageFiles(
    targetRootInput: string,
    request: Omit<GitWorkspaceStageRequest, 'sessionId'>,
  ): Promise<GitWorkspaceOperationResult> {
    if (request.action !== 'stage' && request.action !== 'unstage') {
      return { ok: false, message: '无效操作。' }
    }
    const repository = await this.locateRepository(targetRootInput, request.repositoryId)
    if (!repository) return { ok: false, message: '仓库不可用。' }
    const paths = request.relativePaths.filter(safeRelativePath)
    const args = request.action === 'stage'
      ? ['add', '--', ...(paths.length > 0 ? paths : ['.'])]
      : ['restore', '--staged', '--', ...(paths.length > 0 ? paths : ['.'])]
    const result = await this.runGit(args, repository.root, { timeoutMs: 15_000 })
    if (!result.ok) return { ok: false, message: this.gitError(result) }
    this.invalidate(targetRootInput)
    return { ok: true }
  }

  async discardFiles(
    targetRootInput: string,
    request: Omit<GitWorkspaceDiscardRequest, 'sessionId'>,
  ): Promise<GitWorkspaceOperationResult> {
    const repository = await this.locateRepository(targetRootInput, request.repositoryId)
    if (!repository) return { ok: false, message: '仓库不可用。' }
    const paths = request.relativePaths.filter(safeRelativePath)
    if (paths.length === 0) return { ok: false, message: '未指定文件。' }

    const internal = await this.inspectInternal(targetRootInput, 'local', true)
    const tracked = internal.repositories.find(
      (item) => item.publicSnapshot.repositoryId === request.repositoryId,
    )

    if (request.layer === 'untracked') {
      // 未追踪文件不受 git restore 管理，只能显式删除。
      for (const relativePath of paths) {
        const change = tracked?.changes.get(changeKey('untracked', toPosix(relativePath)))
        if (!change) continue
        const absolute = resolve(repository.root, change.repositoryPath)
        if (!isInside(repository.root, absolute)) return { ok: false, message: '路径越界。' }
        try {
          rmSync(absolute, { force: true })
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : '删除失败。' }
        }
      }
    } else {
      const restorable = paths.filter((relativePath) => (
        tracked?.changes.has(changeKey(request.layer, toPosix(relativePath)))
      ))
      if (restorable.length > 0) {
        // 放弃未暂存改动时从 index 恢复工作树，必须保留同文件已经暂存的内容。
        const restoreArgs = request.layer === 'unstaged'
          ? ['restore', '--worktree', '--', ...restorable]
          : ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...restorable]
        const result = await this.runGit(restoreArgs, repository.root, { timeoutMs: 15_000 })
        if (!result.ok) return { ok: false, message: this.gitError(result) }
      }
    }
    this.invalidate(targetRootInput)
    return { ok: true }
  }

  async commitFiles(
    targetRootInput: string,
    request: Omit<GitWorkspaceCommitRequest, 'sessionId'>,
  ): Promise<GitWorkspaceOperationResult> {
    if (typeof request.message !== 'string' || !request.message.trim()) {
      return { ok: false, message: '提交信息不能为空。' }
    }
    const repository = await this.locateRepository(targetRootInput, request.repositoryId)
    if (!repository) return { ok: false, message: '仓库不可用。' }
    const commitResult = await this.runGit(['commit', '-F', '-'], repository.root, {
      timeoutMs: 20_000,
      stdin: request.message.replace(/\r\n/g, '\n'),
    })
    if (!commitResult.ok) return { ok: false, message: this.gitError(commitResult) }
    this.invalidate(targetRootInput)
    if (request.push === true) {
      const pushResult = await this.runGit(['push'], repository.root, { timeoutMs: 60_000 })
      if (!pushResult.ok) {
        return { ok: false, message: `提交成功，推送失败：${this.gitError(pushResult)}` }
      }
    }
    return { ok: true }
  }

  async checkoutBranch(
    targetRootInput: string,
    request: Omit<GitWorkspaceCheckoutRequest, 'sessionId'>,
  ): Promise<GitWorkspaceOperationResult> {
    if (typeof request.branch !== 'string'
      || !request.branch
      || request.branch.includes('..')
      || /[\s~^:?*[\\]/.test(request.branch)) {
      return { ok: false, message: '非法分支名。' }
    }
    const repository = await this.locateRepository(targetRootInput, request.repositoryId)
    if (!repository) return { ok: false, message: '仓库不可用。' }
    const result = await this.runGit(['checkout', request.branch], repository.root, { timeoutMs: 20_000 })
    if (!result.ok) return { ok: false, message: this.gitError(result) }
    this.invalidate(targetRootInput)
    return { ok: true }
  }

  /** pull：优先 ff-only；分叉（ff 失败）时降级普通合并，自动创建合并提交。 */
  private async pullWithFallback(repository: InternalRepository): Promise<CommandResult> {
    const ff = await this.runGit(['pull', '--ff-only'], repository.root, { timeoutMs: 60_000 })
    if (ff.ok) return ff
    // 分叉或其它失败：降级普通合并（merge 语义、无编辑器弹窗）
    return this.runGit(['pull', '--no-rebase', '--no-edit'], repository.root, { timeoutMs: 60_000 })
  }

  async pullPush(
    targetRootInput: string,
    request: Omit<GitWorkspacePullPushRequest, 'sessionId'>,
  ): Promise<GitWorkspaceOperationResult> {
    if (!['fetch', 'pull', 'push', 'sync'].includes(request.action)) {
      return { ok: false, message: '无效操作。' }
    }
    const repository = await this.locateRepository(targetRootInput, request.repositoryId)
    if (!repository) return { ok: false, message: '仓库不可用。' }
    if ((request.action === 'fetch' || request.action === 'sync') && !repository.publicSnapshot.upstream) {
      return { ok: false, message: '当前分支没有上游分支。' }
    }

    const results: CommandResult[] = []
    if (request.action === 'sync') {
      results.push(await this.pullWithFallback(repository))
      if (results[results.length - 1]!.ok) {
        results.push(await this.runGit(['push'], repository.root, { timeoutMs: 60_000 }))
      }
    } else if (request.action === 'fetch') {
      results.push(await this.runGit(['fetch', '--prune'], repository.root, { timeoutMs: 60_000 }))
    } else if (request.action === 'pull') {
      results.push(await this.pullWithFallback(repository))
    } else {
      results.push(await this.runGit(['push'], repository.root, { timeoutMs: 60_000 }))
    }

    const failed = results.find((result) => !result.ok)
    if (failed) {
      // pull/fetch 即使最终失败也可能已更新部分引用，不能继续提供旧缓存。
      this.invalidate(targetRootInput)
      return { ok: false, message: extractGitErrorMessage(failed) }
    }
    this.invalidate(targetRootInput)
    return { ok: true }
  }

  private readWorkingFile(targetRootInput: string, relativePath: string): string {
    const targetRoot = canonicalRoot(targetRootInput)
    if (!targetRoot) return ''
    const candidate = resolve(targetRoot, relativePath)
    if (!isInside(targetRoot, candidate) || !existsSync(candidate)) return ''
    try {
      const stats = lstatSync(candidate)
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_DIFF_FILE_BYTES) return ''
      const realCandidate = realpathSync(candidate)
      if (!isInside(targetRoot, realCandidate) || statSync(realCandidate).size > MAX_DIFF_FILE_BYTES) return ''
      const buffer = readFileSync(realCandidate)
      return buffer.includes(0) ? '' : buffer.toString('utf8').replace(/\r\n/g, '\n')
    } catch {
      return ''
    }
  }

  private async readGitObject(repositoryRoot: string, spec: string): Promise<string | null> {
    const result = await this.runGit(
      ['show', spec],
      repositoryRoot,
      { timeoutMs: 10_000, dedupeKey: `${comparablePath(repositoryRoot)}:show:${spec}` },
    )
    if (!result.ok || result.stdout.length > MAX_DIFF_FILE_BYTES || result.stdout.includes('\0')) return null
    return result.stdout.replace(/\r\n/g, '\n')
  }
}

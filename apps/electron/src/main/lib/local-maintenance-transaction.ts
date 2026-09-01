import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type { SessionTargetView } from '@domi/shared'
import { canonicalizePath } from './execution-policy/path-canonicalizer.ts'
import { isWithinWorkspace } from './execution-policy/workspace-boundary.ts'
import {
  isDestructiveGitCommand,
  isKnownReadOnlyCommand,
  isKnownValidationCommand,
} from './execution-policy/shell-command-classifier.ts'
import { getLocalMaintenanceDir, getLocalMaintenanceTransactionsPath } from './config-paths.ts'
import { SessionCheckoutError } from './session-checkout/index.ts'

const IDLE_TIMEOUT_MS = 30 * 60 * 1000
const MAX_OUTPUT_CHARS = 50_000
const MAX_UNTRACKED_SNAPSHOT_BYTES = 50 * 1024 * 1024

export interface LocalMaintenanceSnapshot {
  checkoutId: string
  expectedRevision: number
  expectedWorktreeOid: string
  localHeadOid: string
  localBranch: string | null
  localStatusHash: string
  createdAt: number
}

export interface LocalMaintenanceTransactionView {
  id: string
  sessionId: string
  checkoutId: string
  goal: string
  state: 'active' | 'completed' | 'expired' | 'paused'
  startedAt: number
  lastActivityAt: number
  localHeadOid: string
  localBranch: string | null
  snapshotDir: string
}

interface PersistedTransaction extends LocalMaintenanceTransactionView {
  localRoot: string
  worktreeRoot: string
  expectedLocalFingerprint: string
  initialLocalHeadOid: string
  initialLocalBranch: string | null
  initialLocalStatus: string
  initialLocalFingerprint: string
  initialLocalDirtyFingerprint: string
  result?: LocalMaintenanceCompletion
}

interface PersistedRegistry {
  version: 1
  transactions: PersistedTransaction[]
}

export interface LocalMaintenanceCompletion {
  transactionId: string
  state: 'completed' | 'paused'
  localHeadOid: string
  localBranch: string | null
  localStatus: string
  changedSinceStart: boolean
  worktreeSync: 'already_contains_local' | 'fast_forwarded_to_local' | 'local_dirty' | 'worktree_dirty' | 'diverged' | 'unavailable'
  message: string
}

export interface LocalMaintenanceDependencies {
  inspect(sessionId: string): Promise<SessionTargetView>
  lease(sessionId: string): Promise<{ cwd: string; localRoot: string }>
}

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function gitRawSync(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 100 * 1024 * 1024 })
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.error?.message || `git ${args.join(' ')} exited ${result.status}`)
  }
  return result.stdout
}

function gitSync(cwd: string, ...args: string[]): string {
  return gitRawSync(cwd, ...args).trim()
}

function tryGit(cwd: string, ...args: string[]): string | null {
  try { return gitSync(cwd, ...args) } catch { return null }
}

function tryGitRaw(cwd: string, ...args: string[]): string | null {
  try { return gitRawSync(cwd, ...args) } catch { return null }
}

function hashFileSync(path: string): string {
  const digest = createHash('sha256')
  const fd = openSync(path, 'r')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  try {
    while (true) {
      const bytes = readSync(fd, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      digest.update(buffer.subarray(0, bytes))
    }
    return digest.digest('hex')
  } finally {
    closeSync(fd)
  }
}

function captureLocalState(localRoot: string): {
  headOid: string
  branch: string | null
  status: string
  dirtyFingerprint: string
  fingerprint: string
} {
  const headOid = gitSync(localRoot, 'rev-parse', 'HEAD')
  const branchValue = tryGit(localRoot, 'symbolic-ref', '--short', 'HEAD')
  const branch = branchValue || null
  const status = gitRawSync(localRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none')
  const unstagedPatch = tryGitRaw(localRoot, 'diff', '--binary', '--no-ext-diff') ?? ''
  const stagedPatch = tryGitRaw(localRoot, 'diff', '--cached', '--binary', '--no-ext-diff') ?? ''
  const untracked = (tryGitRaw(localRoot, 'ls-files', '--others', '--exclude-standard', '-z') ?? '').split('\0').filter(Boolean)
  const untrackedHashes = untracked.map((path) => {
    const absolute = resolve(localRoot, path)
    try { return `${path}\0${statSync(absolute).isFile() ? hashFileSync(absolute) : 'non-file'}` } catch { return `${path}\0unreadable` }
  }).join('\0')
  const dirtyFingerprint = hash(`${status}\0${unstagedPatch}\0${stagedPatch}\0${untrackedHashes}`)
  return { headOid, branch, status, dirtyFingerprint, fingerprint: hash(`${headOid}\0${branch ?? ''}\0${dirtyFingerprint}`) }
}

function terminateChildTree(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
    return
  }
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() }
}

function isSafeLocalMaintenanceCommand(command: string): boolean {
  if (/\r|\n/.test(command)) return false
  if (/&&|\|\||[;|<>]/.test(command)) return false
  if (/(?:^|\s)(?:cd|pushd|popd|set-location)\b/i.test(command)) return false
  if (/(?:^|[^&])&(?!&)|\b(?:start-process|nohup)\b/i.test(command)) return false
  if (isDestructiveGitCommand(command)) return false
  if (/\b(?:rm|rmdir|del|erase|remove-item|unlink)\b/i.test(command)) return false
  if (isKnownReadOnlyCommand(command) || isKnownValidationCommand(command)) return true
  return /^\s*git(?:\.exe)?\s+(?:-[^\s]+\s+)*(?:add|commit)(?:\s|$)/i.test(command)
}

function copyUntrackedSnapshot(localRoot: string, snapshotDir: string, untracked: string[]): { copiedBytes: number; skipped: string[] } {
  const destination = join(snapshotDir, 'untracked')
  let copiedBytes = 0
  const skipped: string[] = []
  for (const path of untracked) {
    const source = resolve(localRoot, path)
    if (!isWithinWorkspace(source, localRoot) || !existsSync(source)) continue
    let size = 0
    try {
      const stat = statSync(source)
      if (!stat.isFile()) {
        skipped.push(path)
        continue
      }
      size = stat.size
    } catch {
      skipped.push(path)
      continue
    }
    if (copiedBytes + size > MAX_UNTRACKED_SNAPSHOT_BYTES) {
      skipped.push(path)
      continue
    }
    const target = join(destination, path)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target)
    copiedBytes += size
  }
  return { copiedBytes, skipped }
}

export class LocalMaintenanceTransactionService {
  private transactions = new Map<string, PersistedTransaction>()
  private activeProcesses = new Map<string, Set<ReturnType<typeof spawn>>>()
  private readonly idleTimer: ReturnType<typeof setInterval>

  constructor(
    private readonly dependencies: LocalMaintenanceDependencies,
    private readonly registryPath = getLocalMaintenanceTransactionsPath(),
    private readonly artifactsRoot = getLocalMaintenanceDir(),
  ) {
    this.load()
    this.idleTimer = setInterval(() => { void this.expireIdleTransactions() }, 60_000)
    this.idleTimer.unref?.()
  }

  dispose(): void {
    clearInterval(this.idleTimer)
    for (const sessionId of this.activeProcesses.keys()) this.stopProcesses(sessionId)
  }

  async captureRequestSnapshot(sessionId: string): Promise<LocalMaintenanceSnapshot> {
    const target = await this.dependencies.inspect(sessionId)
    if (target.checkout.kind !== 'isolated' || target.ownership !== 'owner') {
      throw new SessionCheckoutError('operation_not_allowed', 'Local 维修事务只适用于 owner managed Worktree 会话')
    }
    const lease = await this.dependencies.lease(sessionId)
    const local = captureLocalState(lease.localRoot)
    return {
      checkoutId: target.checkout.id,
      expectedRevision: target.revision,
      expectedWorktreeOid: target.current.oid,
      localHeadOid: local.headOid,
      localBranch: local.branch,
      localStatusHash: local.fingerprint,
      createdAt: Date.now(),
    }
  }

  async start(sessionId: string, goal: string, snapshot: LocalMaintenanceSnapshot): Promise<LocalMaintenanceTransactionView> {
    await this.expireIdleTransactions()
    const target = await this.dependencies.inspect(sessionId)
    if (
      target.checkout.kind !== 'isolated'
      || target.ownership !== 'owner'
      || target.checkout.id !== snapshot.checkoutId
      || target.revision !== snapshot.expectedRevision
      || target.current.oid !== snapshot.expectedWorktreeOid
    ) {
      throw new SessionCheckoutError('stale_target', 'Worktree 身份、revision 或 HEAD 已变化，旧 Local 维修授权已失效')
    }
    const lease = await this.dependencies.lease(sessionId)
    const local = captureLocalState(lease.localRoot)
    if (local.headOid !== snapshot.localHeadOid || local.branch !== snapshot.localBranch || local.fingerprint !== snapshot.localStatusHash) {
      throw new SessionCheckoutError('stale_local', 'Local HEAD、branch 或 dirty 状态已变化，旧维修授权已失效')
    }
    const conflicting = [...this.transactions.values()].find((transaction) => (
      transaction.state === 'active'
      && resolve(transaction.localRoot).toLowerCase() === resolve(lease.localRoot).toLowerCase()
      && transaction.sessionId !== sessionId
    ))
    if (conflicting) throw new SessionCheckoutError('collaborator_active', '另一个 Agent 正持有该 Local Checkout 的维修写 lease')

    const existing = this.transactions.get(sessionId)
    if (existing?.state === 'active') return this.view(existing)

    const id = randomUUID()
    const snapshotDir = join(this.artifactsRoot, id)
    mkdirSync(snapshotDir, { recursive: true })
    const unstagedPatch = tryGitRaw(lease.localRoot, 'diff', '--binary', '--no-ext-diff') ?? ''
    const stagedPatch = tryGitRaw(lease.localRoot, 'diff', '--cached', '--binary', '--no-ext-diff') ?? ''
    const untracked = (tryGitRaw(lease.localRoot, 'ls-files', '--others', '--exclude-standard', '-z') ?? '').split('\0').filter(Boolean)
    writeFileSync(join(snapshotDir, 'working-tree.patch'), unstagedPatch)
    writeFileSync(join(snapshotDir, 'index.patch'), stagedPatch)
    writeFileSync(join(snapshotDir, 'untracked.json'), JSON.stringify(copyUntrackedSnapshot(lease.localRoot, snapshotDir, untracked), null, 2))
    writeFileSync(join(snapshotDir, 'snapshot.json'), JSON.stringify({
      version: 1,
      transactionId: id,
      sessionId,
      checkoutId: snapshot.checkoutId,
      goal,
      capturedAt: Date.now(),
      localHeadOid: local.headOid,
      localBranch: local.branch,
      localStatus: local.status,
      untracked,
      recoveryNote: '这些 artifacts 只用于恢复事务开始前的 Local 状态；Domi 未执行 stash/reset。',
    }, null, 2))

    const now = Date.now()
    const transaction: PersistedTransaction = {
      id,
      sessionId,
      checkoutId: snapshot.checkoutId,
      goal: goal.trim().slice(0, 2000),
      state: 'active',
      startedAt: now,
      lastActivityAt: now,
      localHeadOid: local.headOid,
      localBranch: local.branch,
      snapshotDir,
      localRoot: lease.localRoot,
      worktreeRoot: lease.cwd,
      expectedLocalFingerprint: local.fingerprint,
      initialLocalHeadOid: local.headOid,
      initialLocalBranch: local.branch,
      initialLocalStatus: local.status,
      initialLocalFingerprint: local.fingerprint,
      initialLocalDirtyFingerprint: local.dirtyFingerprint,
    }
    this.transactions.set(sessionId, transaction)
    this.persist()
    return this.view(transaction)
  }

  getActive(sessionId: string): LocalMaintenanceTransactionView | null {
    const transaction = this.transactions.get(sessionId)
    if (!transaction || transaction.state !== 'active') return null
    if (Date.now() - transaction.lastActivityAt >= IDLE_TIMEOUT_MS) {
      void this.expireIdleTransactions()
      return null
    }
    return this.view(transaction)
  }

  async writeFile(sessionId: string, path: string, content: string): Promise<{ path: string; bytes: number }> {
    const transaction = await this.assertActiveAndFresh(sessionId)
    const target = await this.resolveLocalPath(transaction, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    this.refreshAfterOperation(transaction)
    return { path: relative(transaction.localRoot, target), bytes: Buffer.byteLength(content) }
  }

  async editFile(sessionId: string, path: string, oldText: string, newText: string): Promise<{ path: string }> {
    if (!oldText) throw new Error('oldText 不能为空')
    const transaction = await this.assertActiveAndFresh(sessionId)
    const target = await this.resolveLocalPath(transaction, path)
    const source = readFileSync(target, 'utf8')
    const first = source.indexOf(oldText)
    if (first < 0 || source.indexOf(oldText, first + oldText.length) >= 0) {
      throw new Error('oldText 必须在目标文件中唯一匹配')
    }
    writeFileSync(target, `${source.slice(0, first)}${newText}${source.slice(first + oldText.length)}`)
    this.refreshAfterOperation(transaction)
    return { path: relative(transaction.localRoot, target) }
  }

  async runCommand(sessionId: string, command: string, timeoutSeconds = 120): Promise<CommandResult> {
    if (!isSafeLocalMaintenanceCommand(command)) {
      throw new SessionCheckoutError('operation_not_allowed', 'Local 维修 Bash 仅允许只读/测试命令及普通 git add/commit；删除、覆盖、切换目录、后台进程和破坏性 Git 仍需独立确认')
    }
    const transaction = await this.assertActiveAndFresh(sessionId)
    const timeoutMs = Math.max(1, Math.min(timeoutSeconds, 600)) * 1000
    const result = await new Promise<CommandResult>((resolvePromise, reject) => {
      const emptyHooksDir = join(transaction.snapshotDir, 'empty-git-hooks')
      mkdirSync(emptyHooksDir, { recursive: true })
      const child = spawn(command, {
        cwd: transaction.localRoot,
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'core.hooksPath',
          GIT_CONFIG_VALUE_0: emptyHooksDir,
        },
      })
      const processes = this.activeProcesses.get(sessionId) ?? new Set()
      processes.add(child)
      this.activeProcesses.set(sessionId, processes)
      let stdout = ''
      let stderr = ''
      const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString()}`.slice(-MAX_OUTPUT_CHARS)
      child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
      child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
      const timer = setTimeout(() => {
        terminateChildTree(child)
        reject(new Error(`Local 维修命令超过 ${timeoutSeconds} 秒，已停止`))
      }, timeoutMs)
      child.once('error', (error) => { clearTimeout(timer); processes.delete(child); reject(error) })
      child.once('close', (code) => {
        clearTimeout(timer)
        processes.delete(child)
        resolvePromise({ exitCode: code ?? -1, stdout, stderr })
      })
    })
    this.refreshAfterOperation(transaction)
    return result
  }

  async complete(sessionId: string): Promise<LocalMaintenanceCompletion> {
    const transaction = await this.assertActiveAndFresh(sessionId)
    this.stopProcesses(sessionId)
    const local = captureLocalState(transaction.localRoot)
    let worktreeSync: LocalMaintenanceCompletion['worktreeSync'] = 'unavailable'
    const transactionLeftUncommittedChanges = local.status.length > 0
      && local.dirtyFingerprint !== transaction.initialLocalDirtyFingerprint
    try {
      const worktreeStatus = gitSync(transaction.worktreeRoot, 'status', '--porcelain=v1', '-z', '--untracked-files=all')
      const worktreeHead = gitSync(transaction.worktreeRoot, 'rev-parse', 'HEAD')
      if (transactionLeftUncommittedChanges) {
        worktreeSync = 'local_dirty'
      } else if (worktreeStatus) {
        worktreeSync = 'worktree_dirty'
      } else if (worktreeHead === local.headOid || tryGit(transaction.worktreeRoot, 'merge-base', '--is-ancestor', local.headOid, worktreeHead) !== null) {
        worktreeSync = 'already_contains_local'
      } else if (tryGit(transaction.worktreeRoot, 'merge-base', '--is-ancestor', worktreeHead, local.headOid) !== null) {
        gitSync(transaction.worktreeRoot, 'merge', '--ff-only', local.headOid)
        worktreeSync = 'fast_forwarded_to_local'
      } else {
        worktreeSync = 'diverged'
      }
    } catch {
      worktreeSync = 'unavailable'
    }
    const changedSinceStart = local.fingerprint !== transaction.initialLocalFingerprint
    const needsConfirmation = worktreeSync === 'local_dirty' || worktreeSync === 'worktree_dirty' || worktreeSync === 'diverged'
    const result: LocalMaintenanceCompletion = {
      transactionId: transaction.id,
      state: needsConfirmation ? 'paused' : 'completed',
      localHeadOid: local.headOid,
      localBranch: local.branch,
      localStatus: local.status,
      changedSinceStart,
      worktreeSync,
      message: needsConfirmation
        ? 'Local 维修已关闭；原 Worktree 有修改或已分叉，Domi 未擅自同步，需要基于最新状态另行确认。'
        : worktreeSync === 'fast_forwarded_to_local'
          ? 'Local 维修已关闭，干净 Worktree 已安全 fast-forward 到 Local。'
          : 'Local 维修已关闭，Worktree 无需同步。',
    }
    transaction.state = result.state
    transaction.lastActivityAt = Date.now()
    transaction.localHeadOid = local.headOid
    transaction.localBranch = local.branch
    transaction.result = result
    this.persist()
    return result
  }

  private async assertActiveAndFresh(sessionId: string): Promise<PersistedTransaction> {
    await this.expireIdleTransactions()
    const transaction = this.transactions.get(sessionId)
    if (!transaction || transaction.state !== 'active') {
      throw new SessionCheckoutError('operation_not_allowed', '当前没有已授权的 Local 维修事务')
    }
    const target = await this.dependencies.inspect(sessionId)
    if (target.checkout.kind !== 'isolated' || target.ownership !== 'owner' || target.checkout.id !== transaction.checkoutId) {
      transaction.state = 'paused'
      this.persist()
      throw new SessionCheckoutError('stale_target', 'Session Target 或 Worktree 身份已变化，Local 维修事务已暂停')
    }
    const local = captureLocalState(transaction.localRoot)
    if (local.fingerprint !== transaction.expectedLocalFingerprint) {
      transaction.state = 'paused'
      transaction.localHeadOid = local.headOid
      transaction.localBranch = local.branch
      this.persist()
      throw new SessionCheckoutError('stale_local', '检测到事务外 Local HEAD、branch 或 dirty 指纹变化，维修事务已暂停')
    }
    transaction.lastActivityAt = Date.now()
    this.persist()
    return transaction
  }

  private async resolveLocalPath(transaction: PersistedTransaction, path: string): Promise<string> {
    const target = await canonicalizePath(resolve(transaction.localRoot, path))
    const root = await canonicalizePath(transaction.localRoot)
    if (!isWithinWorkspace(target, root)) throw new SessionCheckoutError('operation_not_allowed', 'Local 维修事务禁止写入项目目录外路径')
    return target
  }

  private refreshAfterOperation(transaction: PersistedTransaction): void {
    const local = captureLocalState(transaction.localRoot)
    transaction.expectedLocalFingerprint = local.fingerprint
    transaction.localHeadOid = local.headOid
    transaction.localBranch = local.branch
    transaction.lastActivityAt = Date.now()
    this.persist()
  }

  private async expireIdleTransactions(): Promise<void> {
    let changed = false
    const now = Date.now()
    for (const transaction of this.transactions.values()) {
      if (transaction.state !== 'active' || now - transaction.lastActivityAt < IDLE_TIMEOUT_MS) continue
      transaction.state = 'expired'
      transaction.lastActivityAt = now
      this.stopProcesses(transaction.sessionId)
      changed = true
    }
    if (changed) this.persist()
  }

  private stopProcesses(sessionId: string): void {
    const processes = this.activeProcesses.get(sessionId)
    if (!processes) return
    for (const child of processes) terminateChildTree(child)
    this.activeProcesses.delete(sessionId)
  }

  private view(transaction: PersistedTransaction): LocalMaintenanceTransactionView {
    return {
      id: transaction.id,
      sessionId: transaction.sessionId,
      checkoutId: transaction.checkoutId,
      goal: transaction.goal,
      state: transaction.state,
      startedAt: transaction.startedAt,
      lastActivityAt: transaction.lastActivityAt,
      localHeadOid: transaction.localHeadOid,
      localBranch: transaction.localBranch,
      snapshotDir: transaction.snapshotDir,
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.registryPath)) return
      const parsed = JSON.parse(readFileSync(this.registryPath, 'utf8')) as PersistedRegistry
      if (parsed.version !== 1 || !Array.isArray(parsed.transactions)) return
      for (const transaction of parsed.transactions) this.transactions.set(transaction.sessionId, transaction)
    } catch {
      this.transactions.clear()
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.registryPath), { recursive: true })
    writeFileSync(this.registryPath, JSON.stringify({ version: 1, transactions: [...this.transactions.values()] }, null, 2))
  }
}

let productionService: LocalMaintenanceTransactionService | null = null

export function configureLocalMaintenanceTransactionService(
  dependencies: LocalMaintenanceDependencies,
): LocalMaintenanceTransactionService {
  productionService?.dispose()
  productionService = new LocalMaintenanceTransactionService(dependencies)
  return productionService
}

export async function getLocalMaintenanceTransactionService(): Promise<LocalMaintenanceTransactionService> {
  if (productionService) return productionService
  const { getSessionCheckoutModule } = await import('./session-checkout/production.ts')
  const module = getSessionCheckoutModule()
  productionService = new LocalMaintenanceTransactionService({
    inspect: (sessionId) => module.inspect(sessionId),
    lease: (sessionId) => module.lease(sessionId),
  })
  return productionService
}

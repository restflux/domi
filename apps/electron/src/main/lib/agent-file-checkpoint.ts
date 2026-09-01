import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { SDKMessage } from '@domi/shared'
import type {
  AgentRewindUndoHostState,
  PersistedAgentRewindUndoHostState,
} from './agent-rewind-undo-types.ts'

const MANIFEST_VERSION = 1
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_SESSION_BYTES = 128 * 1024 * 1024
const DEFAULT_MAX_CHECKPOINTS = 100
const DEFAULT_MAX_FILES_PER_CHECKPOINT = 2_000
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024

type UnsupportedReason =
  | 'file_too_large'
  | 'session_limit_exceeded'
  | 'path_outside_target'
  | 'path_symlink'
  | 'not_regular_file'
  | 'io_error'

type FileFingerprint =
  | { kind: 'missing' }
  | { kind: 'file'; size: number; mode: number; sha256: string }
  | { kind: 'unsupported'; reason: UnsupportedReason }

type CheckpointFileState =
  | { kind: 'missing' }
  | { kind: 'file'; size: number; mode: number; sha256: string; backupFileName: string }

interface FileCheckpoint {
  userMessageUuid: string
  targetId: string
  createdAt: number
  backupDirName: string
  files: Record<string, CheckpointFileState>
  unsupported: Record<string, UnsupportedReason>
}

interface PendingRewindUndoFile {
  path: string
  before: CheckpointFileState
  rewound: CheckpointFileState
}

export type PendingRewindPhase = 'rewind_in_progress' | 'undo_available' | 'undo_in_progress'

interface PendingRewindUndo {
  transactionDirName: string
  targetId: string
  createdAt: number
  phase: PendingRewindPhase
  checkpointUserMessageUuids: string[]
  files: PendingRewindUndoFile[]
  hostState: PersistedAgentRewindUndoHostState
  sourceTranscriptFileName: string
  rewoundTranscriptFileName: string
}

interface FileCheckpointManifest {
  version: 1
  checkpoints: FileCheckpoint[]
  knownStates: Record<string, Record<string, FileFingerprint>>
  noMutationUserMessageUuids: string[]
  totalBackupBytes: number
  pendingRewindUndo?: PendingRewindUndo
}

export type AgentFileRestorePhase = 'apply' | 'rollback' | 'undo' | 'undo_rollback' | 'recovery' | 'recovery_rollback'

export interface AgentFileCheckpointStoreOptions {
  storageRoot: string
  maxFileBytes?: number
  maxSessionBytes?: number
  maxCheckpoints?: number
  maxFilesPerCheckpoint?: number
  now?: () => number
  createId?: () => string
  /** 仅用于确定性故障注入测试。 */
  beforeRestore?: (phase: AgentFileRestorePhase, relativePath: string) => void
}

export interface BeginAgentFileCheckpointInput {
  sessionId: string
  userMessageUuid: string
  targetRoot: string
}

export interface TrackAgentFileMutationInput extends BeginAgentFileCheckpointInput {
  filePath: string
}

export interface RecordAgentFileMutationInput {
  sessionId: string
  targetRoot: string
  filePath: string
}

export interface RewindFileChangePreview {
  path: string
  action: 'restore' | 'delete'
}

export interface RewindFileUnsupportedPreview {
  path: string
  reason: UnsupportedReason | 'checkpoint_missing'
}

export interface AgentFileRewindPreview {
  available: boolean
  changes: RewindFileChangePreview[]
  conflicts: string[]
  unsupported: RewindFileUnsupportedPreview[]
  error?: string
}

export interface AgentFileRewindResult {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  failedFiles?: Array<{ path: string; error: string }>
}

export interface AgentFileRollbackResult {
  complete: boolean
  failedFiles: Array<{ path: string; error: string }>
  recoveryRetained: boolean
}

export interface ApplyAgentFileRewindResult {
  result: AgentFileRewindResult & { rollbackIncomplete?: boolean }
  /** 立即永久提交，兼容旧调用。 */
  commit: () => void
  /** 提交为最近一次可撤销回退；future checkpoints 与反向事务暂时保留。 */
  commitUndoable: (hostState: AgentRewindUndoHostState) => void
  rollback: () => AgentFileRollbackResult
}

export interface AgentRewindUndoState {
  exists: boolean
  available: boolean
  filesChanged: string[]
  conflicts: string[]
  error?: string
}

export interface PreparedAgentRewindUndo {
  hostState: AgentRewindUndoHostState
  result: {
    canUndo: boolean
    filesChanged: string[]
    failedFiles?: Array<{ path: string; error: string }>
    rollbackIncomplete?: boolean
  }
  commit: () => void
  rollback: () => AgentFileRollbackResult
}

export interface PreparedConversationOnlyRewind {
  commitUndoable: (hostState: AgentRewindUndoHostState) => void
  rollback: () => AgentFileRollbackResult
}

export interface AgentRewindRecoveryState {
  needed: boolean
  phase?: Exclude<PendingRewindPhase, 'undo_available'>
  filesChanged: string[]
}

export interface PreparedAgentRewindRecovery {
  target: 'source' | 'rewound'
  hostState: AgentRewindUndoHostState
  result: { recovered: boolean; failedFiles?: Array<{ path: string; error: string }>; rollbackIncomplete?: boolean }
  commit: () => void
  rollback: () => AgentFileRollbackResult
}

interface PreviewPlan extends AgentFileRewindPreview {
  targetId: string
  desiredByPath: Map<string, CheckpointFileState>
  checkpointUserMessageUuids: string[]
}

interface ResolvedTrackedPath {
  absolutePath: string
  relativePath: string
}

interface TransactionFileState {
  path: string
  state: CheckpointFileState
}

function emptyManifest(): FileCheckpointManifest {
  return { version: MANIFEST_VERSION, checkpoints: [], knownStates: {}, noMutationUserMessageUuids: [], totalBackupBytes: 0 }
}

function stateFingerprint(state: CheckpointFileState): FileFingerprint {
  return state.kind === 'missing'
    ? { kind: 'missing' }
    : { kind: 'file', size: state.size, mode: state.mode, sha256: state.sha256 }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeForComparison(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isPathInside(root: string, candidate: string): boolean {
  const rootKey = normalizeForComparison(root)
  const candidateKey = normalizeForComparison(candidate)
  return candidateKey === rootKey || candidateKey.startsWith(`${rootKey}${sep}`)
}

function normalizeRelativePath(value: string): string {
  return value.split(sep).join('/')
}

function sanitizeDirectoryName(value: string): string {
  return /^[a-zA-Z0-9_-]+$/.test(value) ? value : hash(value).slice(0, 32)
}

function isRealUserMessage(message: SDKMessage): boolean {
  if (message.type !== 'user') return false
  const content = (message as { message?: { content?: Array<{ type?: string }> } }).message?.content
  return !Array.isArray(content) || !content.some((block) => block.type === 'tool_result')
}

export function resolveLaterCheckpointUserIds(
  messages: readonly SDKMessage[],
  assistantMessageUuid: string,
): { laterUserMessageUuids: string[]; missingUserMessageUuid: boolean } {
  const targetIndex = messages.findIndex((message) => (
    message.type === 'assistant'
    && (message as { uuid?: unknown }).uuid === assistantMessageUuid
  ))
  if (targetIndex < 0) throw new Error('未在会话历史中找到回退目标消息')

  const laterUserMessageUuids: string[] = []
  let missingUserMessageUuid = false
  for (const message of messages.slice(targetIndex + 1)) {
    if (!isRealUserMessage(message)) continue
    const uuid = (message as { uuid?: unknown }).uuid
    if (typeof uuid === 'string' && uuid.length > 0) {
      laterUserMessageUuids.push(uuid)
    } else {
      missingUserMessageUuid = true
    }
  }
  return { laterUserMessageUuids, missingUserMessageUuid }
}

export class AgentFileCheckpointStore {
  private readonly storageRoot: string
  private readonly maxFileBytes: number
  private readonly maxSessionBytes: number
  private readonly maxCheckpoints: number
  private readonly maxFilesPerCheckpoint: number
  private readonly now: () => number
  private readonly createId: () => string
  private readonly beforeRestore?: (phase: AgentFileRestorePhase, relativePath: string) => void

  constructor(options: AgentFileCheckpointStoreOptions) {
    this.storageRoot = options.storageRoot
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.maxSessionBytes = options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES
    this.maxCheckpoints = options.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS
    this.maxFilesPerCheckpoint = options.maxFilesPerCheckpoint ?? DEFAULT_MAX_FILES_PER_CHECKPOINT
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.beforeRestore = options.beforeRestore
  }

  beginCheckpoint(input: BeginAgentFileCheckpointInput): void {
    this.finalizeRewindUndo(input.sessionId)
    const targetId = this.targetId(input.targetRoot)
    const manifest = this.readManifest(input.sessionId)
    if (manifest.checkpoints.some((checkpoint) => (
      checkpoint.userMessageUuid === input.userMessageUuid && checkpoint.targetId === targetId
    ))) return

    manifest.noMutationUserMessageUuids = manifest.noMutationUserMessageUuids.filter((uuid) => uuid !== input.userMessageUuid)
    manifest.checkpoints.push({
      userMessageUuid: input.userMessageUuid,
      targetId,
      createdAt: this.now(),
      backupDirName: sanitizeDirectoryName(this.createId()),
      files: {},
      unsupported: {},
    })
    const staleBackupDirs = this.collectOldCheckpoints(manifest)
    this.writeManifest(input.sessionId, manifest)
    for (const backupDirName of staleBackupDirs) {
      try {
        rmSync(this.safeBackupDirectory(input.sessionId, backupDirName), { recursive: true, force: true })
      } catch (error) {
        console.warn(`[file-checkpoint] stale backup cleanup skipped (${backupDirName}):`, error)
      }
    }
  }

  markNoMutation(sessionId: string, userMessageUuid: string): void {
    this.finalizeRewindUndo(sessionId)
    const manifest = this.readManifest(sessionId)
    if (!manifest.noMutationUserMessageUuids.includes(userMessageUuid)) {
      manifest.noMutationUserMessageUuids.push(userMessageUuid)
      manifest.noMutationUserMessageUuids = manifest.noMutationUserMessageUuids.slice(-1_000)
      this.writeManifest(sessionId, manifest)
    }
  }

  /** 返回该会话所有仍受检查点记录追踪的项目相对路径，不暴露目标根目录。 */
  listTrackedPaths(sessionId: string): string[] {
    const manifest = this.readManifest(sessionId)
    const paths = new Set<string>()
    for (const checkpoint of manifest.checkpoints) {
      for (const path of Object.keys(checkpoint.files)) paths.add(path)
    }
    for (const states of Object.values(manifest.knownStates)) {
      for (const path of Object.keys(states)) paths.add(path)
    }
    return [...paths].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }

  trackFileBeforeMutation(input: TrackAgentFileMutationInput): void {
    const targetId = this.targetId(input.targetRoot)
    const manifest = this.readManifest(input.sessionId)
    const checkpoint = manifest.checkpoints.findLast((candidate) => (
      candidate.userMessageUuid === input.userMessageUuid && candidate.targetId === targetId
    ))
    if (!checkpoint) throw new Error('当前用户消息尚未建立文件检查点')

    const resolvedPath = this.resolveTrackedPath(input.targetRoot, input.filePath)
    if (!resolvedPath) {
      const displayPath = normalizeRelativePath(input.filePath)
      checkpoint.unsupported[displayPath] = 'path_outside_target'
      this.writeManifest(input.sessionId, manifest)
      return
    }
    if (checkpoint.files[resolvedPath.relativePath] || checkpoint.unsupported[resolvedPath.relativePath]) return
    if (Object.keys(checkpoint.files).length + Object.keys(checkpoint.unsupported).length >= this.maxFilesPerCheckpoint) {
      checkpoint.unsupported['<checkpoint-file-limit>'] = 'session_limit_exceeded'
      this.writeManifest(input.sessionId, manifest)
      return
    }

    const captured = this.captureFingerprint(resolvedPath.absolutePath)
    const knownStates = manifest.knownStates[targetId] ??= {}
    knownStates[resolvedPath.relativePath] = captured

    if (captured.kind === 'missing') {
      checkpoint.files[resolvedPath.relativePath] = { kind: 'missing' }
      this.writeManifest(input.sessionId, manifest)
      return
    }
    if (captured.kind === 'unsupported') {
      checkpoint.unsupported[resolvedPath.relativePath] = captured.reason
      this.writeManifest(input.sessionId, manifest)
      return
    }
    if (manifest.totalBackupBytes + captured.size > this.maxSessionBytes) {
      checkpoint.unsupported[resolvedPath.relativePath] = 'session_limit_exceeded'
      this.writeManifest(input.sessionId, manifest)
      return
    }

    const backupFileName = `${checkpoint.backupDirName}/${hash(resolvedPath.relativePath).slice(0, 24)}`
    const backupPath = join(this.checkpointBackupRoot(input.sessionId), backupFileName)
    mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 })
    copyFileSync(resolvedPath.absolutePath, backupPath)
    chmodSync(backupPath, captured.mode)
    checkpoint.files[resolvedPath.relativePath] = { ...captured, backupFileName }
    manifest.totalBackupBytes += captured.size
    try {
      this.writeManifest(input.sessionId, manifest)
    } catch (error) {
      rmSync(backupPath, { force: true })
      throw error
    }
  }

  recordFileAfterMutation(input: RecordAgentFileMutationInput): void {
    const targetId = this.targetId(input.targetRoot)
    const resolvedPath = this.resolveTrackedPath(input.targetRoot, input.filePath)
    if (!resolvedPath) return
    const manifest = this.readManifest(input.sessionId)
    const knownStates = manifest.knownStates[targetId] ??= {}
    knownStates[resolvedPath.relativePath] = this.captureFingerprint(resolvedPath.absolutePath)
    this.writeManifest(input.sessionId, manifest)
  }

  markCheckpointIncomplete(input: TrackAgentFileMutationInput, reason: UnsupportedReason = 'io_error'): void {
    const targetId = this.targetId(input.targetRoot)
    const manifest = this.readManifest(input.sessionId)
    const checkpoint = manifest.checkpoints.findLast((candidate) => (
      candidate.userMessageUuid === input.userMessageUuid && candidate.targetId === targetId
    ))
    if (!checkpoint) return
    const resolvedPath = this.resolveTrackedPath(input.targetRoot, input.filePath)
    const displayPath = resolvedPath?.relativePath ?? normalizeRelativePath(input.filePath)
    const previous = checkpoint.files[displayPath]
    if (previous?.kind === 'file') {
      const backupRoot = this.checkpointBackupRoot(input.sessionId)
      const backupPath = resolve(backupRoot, previous.backupFileName)
      if (this.isUsableBackupPath(backupRoot, backupPath)) rmSync(backupPath, { force: true })
      manifest.totalBackupBytes = Math.max(0, manifest.totalBackupBytes - previous.size)
    }
    delete checkpoint.files[displayPath]
    checkpoint.unsupported[displayPath] = reason
    this.writeManifest(input.sessionId, manifest)
  }

  previewRewind(input: {
    sessionId: string
    targetRoot: string
    laterUserMessageUuids: readonly string[]
    missingUserMessageUuid?: boolean
  }): AgentFileRewindPreview {
    const plan = this.buildPreviewPlan(input)
    return {
      available: plan.available,
      changes: plan.changes,
      conflicts: plan.conflicts,
      unsupported: plan.unsupported,
      ...(plan.error ? { error: plan.error } : {}),
    }
  }

  applyRewind(input: {
    sessionId: string
    targetRoot: string
    laterUserMessageUuids: readonly string[]
    missingUserMessageUuid?: boolean
    undoHostState?: AgentRewindUndoHostState
  }): ApplyAgentFileRewindResult {
    this.finalizeRewindUndo(input.sessionId)
    const plan = this.buildPreviewPlan(input)
    if (!plan.available) throw new Error(plan.error ?? '文件检查点覆盖不完整')
    if (plan.conflicts.length > 0) {
      throw new Error(`检测到 Agent 写入后的人工修改冲突：${plan.conflicts.join('、')}`)
    }

    const transactionDirName = sanitizeDirectoryName(this.createId())
    const transactionDir = this.safeTransactionDirectory(input.sessionId, transactionDirName)
    const transactionStates: TransactionFileState[] = []
    const changedPaths = plan.changes.map((change) => change.path)
    const failedFiles: Array<{ path: string; error: string }> = []
    let transactionBytes = 0
    let applied = false

    const rollback = (): AgentFileRollbackResult => {
      if (!applied) {
        try { rmSync(transactionDir, { recursive: true, force: true }) } catch { /* best effort */ }
        return { complete: true, failedFiles: [], recoveryRetained: false }
      }
      const rollbackFailures: Array<{ path: string; error: string }> = []
      for (const transaction of [...transactionStates].reverse()) {
        try {
          this.restoreState(input.targetRoot, transaction.path, transaction.state, transactionDir, 'rollback')
        } catch (error) {
          rollbackFailures.push({
            path: transaction.path,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (rollbackFailures.length === 0) {
        this.clearPendingRewindUndo(input.sessionId, transactionDirName)
        applied = false
        rmSync(transactionDir, { recursive: true, force: true })
      }
      return {
        complete: rollbackFailures.length === 0,
        failedFiles: rollbackFailures,
        recoveryRetained: rollbackFailures.length > 0,
      }
    }

    try {
      mkdirSync(transactionDir, { recursive: true, mode: 0o700 })
      if (!this.isUsableTransactionDirectory(input.sessionId, transactionDirName)) {
        throw new Error('回退事务目录不安全')
      }
      for (const path of changedPaths) {
        const resolvedPath = this.resolveTrackedPath(input.targetRoot, path)
        if (!resolvedPath) throw new Error(`路径已越过当前 Session Target: ${path}`)
        const current = this.captureCurrentStateForTransaction(resolvedPath.absolutePath, transactionDir, path)
        transactionStates.push({ path, state: current })
        if (current.kind === 'file') {
          transactionBytes += current.size
          if (transactionBytes > this.maxSessionBytes) {
            throw new Error('撤销回退事务超过会话容量限制')
          }
        }
      }
      writeFileSync(join(transactionDir, 'transaction.json'), JSON.stringify({
        version: 1,
        targetId: plan.targetId,
        createdAt: this.now(),
        files: transactionStates,
      }), { encoding: 'utf8', mode: 0o600 })
      if (input.undoHostState) {
        this.stagePendingRewindUndo({
          sessionId: input.sessionId,
          targetId: plan.targetId,
          transactionDirName,
          checkpointUserMessageUuids: plan.checkpointUserMessageUuids,
          files: transactionStates.map((transaction) => {
            const rewound = plan.desiredByPath.get(transaction.path)
            if (!rewound) throw new Error(`撤销回退缺少恢复后状态: ${transaction.path}`)
            return { path: transaction.path, before: transaction.state, rewound }
          }),
          hostState: input.undoHostState,
        })
      }

      for (const change of plan.changes) {
        const desired = plan.desiredByPath.get(change.path)
        if (!desired) continue
        try {
          this.restoreState(
            input.targetRoot,
            change.path,
            desired,
            this.checkpointBackupRoot(input.sessionId),
            'apply',
          )
        } catch (error) {
          failedFiles.push({ path: change.path, error: error instanceof Error ? error.message : String(error) })
          throw error
        }
      }
      applied = true
    } catch (error) {
      applied = true
      const rollbackResult = rollback()
      return {
        result: {
          canRewind: false,
          error: rollbackResult.complete
            ? error instanceof Error ? error.message : String(error)
            : '文件回退失败，且自动恢复未完整完成；恢复事务已保留。',
          failedFiles: [...failedFiles, ...rollbackResult.failedFiles],
          ...(rollbackResult.complete ? {} : { rollbackIncomplete: true }),
        },
        commit: () => {},
        commitUndoable: () => {},
        rollback: () => rollbackResult,
      }
    }

    const commit = (): void => {
      if (!applied) return
      const manifest = this.readManifest(input.sessionId)
      const removed = new Set(plan.checkpointUserMessageUuids)
      const kept: FileCheckpoint[] = []
      const staleBackupDirs: string[] = []
      for (const checkpoint of manifest.checkpoints) {
        if (checkpoint.targetId === plan.targetId && removed.has(checkpoint.userMessageUuid)) {
          staleBackupDirs.push(checkpoint.backupDirName)
        } else {
          kept.push(checkpoint)
        }
      }
      manifest.checkpoints = kept
      manifest.noMutationUserMessageUuids = manifest.noMutationUserMessageUuids.filter((uuid) => !removed.has(uuid))
      delete manifest.pendingRewindUndo
      const knownStates = manifest.knownStates[plan.targetId] ??= {}
      for (const [path, desired] of plan.desiredByPath) {
        knownStates[path] = desired.kind === 'missing'
          ? { kind: 'missing' }
          : { kind: 'file', size: desired.size, mode: desired.mode, sha256: desired.sha256 }
      }
      manifest.totalBackupBytes = this.calculateBackupBytes(manifest)
      this.pruneKnownStates(manifest)
      this.writeManifest(input.sessionId, manifest)
      applied = false
      try {
        rmSync(transactionDir, { recursive: true, force: true })
      } catch (error) {
        console.warn('[file-checkpoint] committed transaction cleanup failed:', error)
      }
      for (const backupDirName of staleBackupDirs) {
        try {
          rmSync(this.safeBackupDirectory(input.sessionId, backupDirName), { recursive: true, force: true })
        } catch (error) {
          console.warn(`[file-checkpoint] unreachable backup cleanup failed (${backupDirName}):`, error)
        }
      }
    }

    const commitUndoable = (hostState: AgentRewindUndoHostState): void => {
      if (!applied) return
      if (!this.isUsableTransactionDirectory(input.sessionId, transactionDirName)) {
        throw new Error('回退事务目录不安全')
      }
      void hostState
      const manifest = this.readManifest(input.sessionId)
      const pending = manifest.pendingRewindUndo
      if (!pending || pending.transactionDirName !== transactionDirName || pending.phase !== 'rewind_in_progress') {
        throw new Error('回退事务阶段已变化')
      }
      const knownStates = manifest.knownStates[plan.targetId] ??= {}
      for (const file of pending.files) knownStates[file.path] = stateFingerprint(file.rewound)
      pending.phase = 'undo_available'
      this.writeManifest(input.sessionId, manifest)
      applied = false
    }

    return {
      result: { canRewind: true, filesChanged: changedPaths },
      commit,
      commitUndoable,
      rollback,
    }
  }

  prepareConversationOnlyRewind(input: {
    sessionId: string
    targetRoot: string
    undoHostState?: AgentRewindUndoHostState
  }): PreparedConversationOnlyRewind {
    this.finalizeRewindUndo(input.sessionId)
    const targetId = this.targetId(input.targetRoot)
    const transactionDirName = sanitizeDirectoryName(this.createId())
    const transactionDir = this.safeTransactionDirectory(input.sessionId, transactionDirName)
    let prepared = true
    mkdirSync(transactionDir, { recursive: true, mode: 0o700 })
    if (!this.isUsableTransactionDirectory(input.sessionId, transactionDirName)) {
      throw new Error('回退事务目录不安全')
    }
    writeFileSync(join(transactionDir, 'transaction.json'), JSON.stringify({
      version: 1,
      targetId,
      createdAt: this.now(),
      files: [],
    }), { encoding: 'utf8', mode: 0o600 })
    if (input.undoHostState) {
      this.stagePendingRewindUndo({
        sessionId: input.sessionId,
        targetId,
        transactionDirName,
        checkpointUserMessageUuids: [],
        files: [],
        hostState: input.undoHostState,
      })
    }

    const rollback = (): AgentFileRollbackResult => {
      if (prepared) {
        this.clearPendingRewindUndo(input.sessionId, transactionDirName)
        try { rmSync(transactionDir, { recursive: true, force: true }) } catch { /* best effort */ }
        prepared = false
      }
      return { complete: true, failedFiles: [], recoveryRetained: false }
    }

    return {
      commitUndoable: (hostState) => {
        if (!prepared) return
        if (!this.isUsableTransactionDirectory(input.sessionId, transactionDirName)) {
          throw new Error('回退事务目录不安全')
        }
        void hostState
        const manifest = this.readManifest(input.sessionId)
        const pending = manifest.pendingRewindUndo
        if (!pending || pending.transactionDirName !== transactionDirName || pending.phase !== 'rewind_in_progress') {
          throw new Error('回退事务阶段已变化')
        }
        pending.phase = 'undo_available'
        this.writeManifest(input.sessionId, manifest)
        prepared = false
      },
      rollback,
    }
  }

  getRewindUndoState(input: { sessionId: string; targetRoot: string }): AgentRewindUndoState {
    const manifest = this.readManifest(input.sessionId)
    const pending = manifest.pendingRewindUndo
    if (!pending) return { exists: false, available: false, filesChanged: [], conflicts: [], error: '没有可撤销的回退' }

    let targetId: string
    try {
      targetId = this.targetId(input.targetRoot)
    } catch {
      return { exists: true, available: false, filesChanged: pending.files.map((file) => file.path), conflicts: [], error: '当前工作环境不可用' }
    }
    if (targetId !== pending.targetId) {
      return { exists: true, available: false, filesChanged: pending.files.map((file) => file.path), conflicts: [], error: '当前 Session Target 已变化，无法撤销回退' }
    }
    if (pending.phase !== 'undo_available') {
      return { exists: true, available: false, filesChanged: pending.files.map((file) => file.path), conflicts: [], error: '回退事务上次未完整结束，需要先恢复' }
    }

    const transactionDir = this.safeTransactionDirectory(input.sessionId, pending.transactionDirName)
    if (!this.isUsableTransactionDirectory(input.sessionId, pending.transactionDirName)) {
      return { exists: true, available: false, filesChanged: pending.files.map((file) => file.path), conflicts: [], error: '撤销回退事务目录不安全' }
    }
    const sourceTranscriptPath = resolve(transactionDir, pending.sourceTranscriptFileName)
    const rewoundTranscriptPath = resolve(transactionDir, pending.rewoundTranscriptFileName)
    if (!this.isUsableBackupPath(transactionDir, sourceTranscriptPath)
      || !this.isUsableBackupPath(transactionDir, rewoundTranscriptPath)) {
      return { exists: true, available: false, filesChanged: pending.files.map((file) => file.path), conflicts: [], error: '撤销回退的对话备份不可用' }
    }

    const conflicts: string[] = []
    for (const file of pending.files) {
      const resolvedPath = this.resolveTrackedPath(input.targetRoot, file.path)
      if (!resolvedPath) {
        conflicts.push(file.path)
        continue
      }
      const current = this.captureFingerprint(resolvedPath.absolutePath)
      if (!this.fingerprintMatchesState(current, file.rewound)) conflicts.push(file.path)
      if (file.before.kind === 'file') {
        const beforePath = resolve(transactionDir, file.before.backupFileName)
        if (!this.isUsableBackupPath(transactionDir, beforePath) && !conflicts.includes(file.path)) conflicts.push(file.path)
      }
      if (file.rewound.kind === 'file' && !this.isUsableBackupFile(input.sessionId, file.rewound.backupFileName)) {
        if (!conflicts.includes(file.path)) conflicts.push(file.path)
      }
    }
    conflicts.sort()
    return {
      exists: true,
      available: conflicts.length === 0,
      filesChanged: pending.files.map((file) => file.path),
      conflicts,
      ...(conflicts.length > 0 ? { error: '回退后的文件又被修改或备份已不可用' } : {}),
    }
  }

  prepareUndoRewind(input: { sessionId: string; targetRoot: string }): PreparedAgentRewindUndo {
    const state = this.getRewindUndoState(input)
    if (!state.available) {
      if (state.conflicts.length > 0) throw new Error(`检测到回退后的人工修改冲突：${state.conflicts.join('、')}`)
      throw new Error(state.error ?? '没有可撤销的回退')
    }

    const manifest = this.readManifest(input.sessionId)
    const pending = manifest.pendingRewindUndo
    if (!pending) throw new Error('没有可撤销的回退')
    const transactionDir = this.safeTransactionDirectory(input.sessionId, pending.transactionDirName)
    const sourceTranscriptContent = readFileSync(resolve(transactionDir, pending.sourceTranscriptFileName), 'utf8')
    const rewoundTranscriptContent = readFileSync(resolve(transactionDir, pending.rewoundTranscriptFileName), 'utf8')
    if (Buffer.byteLength(sourceTranscriptContent, 'utf8') + Buffer.byteLength(rewoundTranscriptContent, 'utf8') > this.maxSessionBytes) {
      throw new Error('撤销回退对话备份超过会话容量限制')
    }
    const hostState: AgentRewindUndoHostState = {
      sourcePi: pending.hostState.sourcePi,
      rewoundPi: pending.hostState.rewoundPi,
      sourceTranscriptContent,
      rewoundTranscriptContent,
    }
    pending.phase = 'undo_in_progress'
    this.writeManifest(input.sessionId, manifest)
    const failedFiles: Array<{ path: string; error: string }> = []
    let applied = false

    const rollback = (): AgentFileRollbackResult => {
      if (!applied) return { complete: true, failedFiles: [], recoveryRetained: false }
      const rollbackFailures: Array<{ path: string; error: string }> = []
      for (const file of [...pending.files].reverse()) {
        try {
          this.restoreState(input.targetRoot, file.path, file.rewound, this.checkpointBackupRoot(input.sessionId), 'undo_rollback')
        } catch (error) {
          rollbackFailures.push({ path: file.path, error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (rollbackFailures.length === 0) {
        const latest = this.readManifest(input.sessionId)
        if (latest.pendingRewindUndo?.transactionDirName === pending.transactionDirName) {
          latest.pendingRewindUndo.phase = 'undo_available'
          this.writeManifest(input.sessionId, latest)
        }
        applied = false
      }
      return {
        complete: rollbackFailures.length === 0,
        failedFiles: rollbackFailures,
        recoveryRetained: rollbackFailures.length > 0,
      }
    }

    try {
      for (const file of pending.files) {
        try {
          this.restoreState(input.targetRoot, file.path, file.before, transactionDir, 'undo')
        } catch (error) {
          failedFiles.push({ path: file.path, error: error instanceof Error ? error.message : String(error) })
          throw error
        }
      }
      applied = true
    } catch (error) {
      applied = true
      const rollbackResult = rollback()
      return {
        hostState,
        result: {
          canUndo: false,
          filesChanged: pending.files.map((file) => file.path),
          failedFiles: [...failedFiles, ...rollbackResult.failedFiles],
          ...(rollbackResult.complete ? {} : { rollbackIncomplete: true }),
        },
        commit: () => {},
        rollback: () => rollbackResult,
      }
    }

    const commit = (): void => {
      if (!applied) return
      const latest = this.readManifest(input.sessionId)
      if (latest.pendingRewindUndo?.transactionDirName !== pending.transactionDirName
        || latest.pendingRewindUndo.phase !== 'undo_in_progress') {
        throw new Error('撤销回退事务已变化')
      }
      const knownStates = latest.knownStates[pending.targetId] ??= {}
      for (const file of pending.files) knownStates[file.path] = stateFingerprint(file.before)
      delete latest.pendingRewindUndo
      latest.totalBackupBytes = this.calculateBackupBytes(latest)
      this.pruneKnownStates(latest)
      this.writeManifest(input.sessionId, latest)
      applied = false
      try { rmSync(transactionDir, { recursive: true, force: true }) } catch (error) {
        console.warn('[file-checkpoint] undo transaction cleanup failed:', error)
      }
    }

    return {
      hostState,
      result: { canUndo: true, filesChanged: pending.files.map((file) => file.path) },
      commit,
      rollback,
    }
  }

  getRewindRecoveryState(sessionId: string): AgentRewindRecoveryState {
    const pending = this.readManifest(sessionId).pendingRewindUndo
    if (!pending || pending.phase === 'undo_available') return { needed: false, filesChanged: [] }
    return {
      needed: true,
      phase: pending.phase,
      filesChanged: pending.files.map((file) => file.path),
    }
  }

  prepareRewindRecovery(input: { sessionId: string; targetRoot: string }): PreparedAgentRewindRecovery {
    const manifest = this.readManifest(input.sessionId)
    const pending = manifest.pendingRewindUndo
    if (!pending || pending.phase === 'undo_available') throw new Error('没有需要恢复的回退事务')
    if (this.targetId(input.targetRoot) !== pending.targetId) throw new Error('当前 Session Target 已变化，无法恢复回退事务')
    if (!this.isUsableTransactionDirectory(input.sessionId, pending.transactionDirName)) {
      throw new Error('回退事务目录不安全')
    }
    const transactionDir = this.safeTransactionDirectory(input.sessionId, pending.transactionDirName)
    const sourceTranscriptContent = readFileSync(resolve(transactionDir, pending.sourceTranscriptFileName), 'utf8')
    const rewoundTranscriptContent = readFileSync(resolve(transactionDir, pending.rewoundTranscriptFileName), 'utf8')
    const hostState: AgentRewindUndoHostState = {
      sourcePi: pending.hostState.sourcePi,
      rewoundPi: pending.hostState.rewoundPi,
      sourceTranscriptContent,
      rewoundTranscriptContent,
    }
    const target = pending.phase === 'rewind_in_progress' ? 'source' : 'rewound'
    const targetStates = pending.files.map((file) => ({
      path: file.path,
      state: target === 'source' ? file.before : file.rewound,
    }))
    const targetBackupRoot = target === 'source' ? transactionDir : this.checkpointBackupRoot(input.sessionId)
    const recoveryDir = join(transactionDir, 'recovery')
    rmSync(recoveryDir, { recursive: true, force: true })
    mkdirSync(recoveryDir, { recursive: true, mode: 0o700 })
    const previousStates: TransactionFileState[] = []
    const failedFiles: Array<{ path: string; error: string }> = []
    let applied = false

    const rollback = (): AgentFileRollbackResult => {
      if (!applied) return { complete: true, failedFiles: [], recoveryRetained: false }
      const rollbackFailures: Array<{ path: string; error: string }> = []
      for (const file of [...previousStates].reverse()) {
        try {
          this.restoreState(input.targetRoot, file.path, file.state, recoveryDir, 'recovery_rollback')
        } catch (error) {
          rollbackFailures.push({ path: file.path, error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (rollbackFailures.length === 0) {
        applied = false
        rmSync(recoveryDir, { recursive: true, force: true })
      }
      return {
        complete: rollbackFailures.length === 0,
        failedFiles: rollbackFailures,
        recoveryRetained: rollbackFailures.length > 0,
      }
    }

    try {
      for (const file of targetStates) {
        const resolvedPath = this.resolveTrackedPath(input.targetRoot, file.path)
        if (!resolvedPath) throw new Error(`路径已越过当前 Session Target: ${file.path}`)
        previousStates.push({
          path: file.path,
          state: this.captureCurrentStateForTransaction(resolvedPath.absolutePath, recoveryDir, file.path),
        })
      }
      for (const file of targetStates) {
        try {
          this.restoreState(input.targetRoot, file.path, file.state, targetBackupRoot, 'recovery')
        } catch (error) {
          failedFiles.push({ path: file.path, error: error instanceof Error ? error.message : String(error) })
          throw error
        }
      }
      applied = true
    } catch (error) {
      applied = true
      const rollbackResult = rollback()
      return {
        target,
        hostState,
        result: {
          recovered: false,
          failedFiles: [...failedFiles, ...rollbackResult.failedFiles],
          ...(rollbackResult.complete ? {} : { rollbackIncomplete: true }),
        },
        commit: () => {},
        rollback: () => rollbackResult,
      }
    }

    const commit = (): void => {
      if (!applied) return
      const latest = this.readManifest(input.sessionId)
      const current = latest.pendingRewindUndo
      if (!current || current.transactionDirName !== pending.transactionDirName || current.phase !== pending.phase) {
        throw new Error('回退恢复事务阶段已变化')
      }
      const knownStates = latest.knownStates[pending.targetId] ??= {}
      for (const file of pending.files) {
        knownStates[file.path] = stateFingerprint(target === 'source' ? file.before : file.rewound)
      }
      if (target === 'source') {
        delete latest.pendingRewindUndo
      } else {
        current.phase = 'undo_available'
      }
      this.writeManifest(input.sessionId, latest)
      applied = false
      try { rmSync(recoveryDir, { recursive: true, force: true }) } catch (error) {
        console.warn('[file-checkpoint] recovery compensation cleanup failed:', error)
      }
      if (target === 'source') {
        try { rmSync(transactionDir, { recursive: true, force: true }) } catch (error) {
          console.warn('[file-checkpoint] recovered rewind transaction cleanup failed:', error)
        }
      }
    }

    return {
      target,
      hostState,
      result: { recovered: true },
      commit,
      rollback,
    }
  }

  finalizeRewindUndo(sessionId: string): boolean {
    const manifest = this.readManifest(sessionId)
    const pending = manifest.pendingRewindUndo
    if (!pending) return false
    if (pending.phase !== 'undo_available') throw new Error('回退事务上次未完整结束，需要先恢复')

    const removed = new Set(pending.checkpointUserMessageUuids)
    const kept: FileCheckpoint[] = []
    const staleBackupDirs: string[] = []
    for (const checkpoint of manifest.checkpoints) {
      if (checkpoint.targetId === pending.targetId && removed.has(checkpoint.userMessageUuid)) {
        staleBackupDirs.push(checkpoint.backupDirName)
      } else {
        kept.push(checkpoint)
      }
    }
    manifest.checkpoints = kept
    manifest.noMutationUserMessageUuids = manifest.noMutationUserMessageUuids.filter((uuid) => !removed.has(uuid))
    delete manifest.pendingRewindUndo
    manifest.totalBackupBytes = this.calculateBackupBytes(manifest)
    this.pruneKnownStates(manifest)
    this.writeManifest(sessionId, manifest)

    const transactionDir = this.safeTransactionDirectory(sessionId, pending.transactionDirName)
    try {
      if (this.isUsableTransactionDirectory(sessionId, pending.transactionDirName)) {
        rmSync(transactionDir, { recursive: true, force: true })
      } else {
        console.warn('[file-checkpoint] unsafe finalized undo transaction was not deleted')
      }
    } catch (error) {
      console.warn('[file-checkpoint] finalized undo transaction cleanup failed:', error)
    }
    for (const backupDirName of staleBackupDirs) {
      try { rmSync(this.safeBackupDirectory(sessionId, backupDirName), { recursive: true, force: true }) } catch (error) {
        console.warn(`[file-checkpoint] finalized unreachable backup cleanup failed (${backupDirName}):`, error)
      }
    }
    return true
  }

  deleteSession(sessionId: string): void {
    rmSync(this.sessionDir(sessionId), { recursive: true, force: true })
  }

  private buildPreviewPlan(input: {
    sessionId: string
    targetRoot: string
    laterUserMessageUuids: readonly string[]
    missingUserMessageUuid?: boolean
  }): PreviewPlan {
    const targetId = this.targetId(input.targetRoot)
    const manifest = this.readManifest(input.sessionId)
    const requested = [...new Set(input.laterUserMessageUuids)]
    const checkpoints: FileCheckpoint[] = []
    const unsupported = new Map<string, UnsupportedReason | 'checkpoint_missing'>()

    for (const userMessageUuid of requested) {
      const checkpoint = manifest.checkpoints.findLast((candidate) => (
        candidate.userMessageUuid === userMessageUuid && candidate.targetId === targetId
      ))
      if (!checkpoint) {
        if (!manifest.noMutationUserMessageUuids.includes(userMessageUuid)) {
          unsupported.set(userMessageUuid, 'checkpoint_missing')
        }
      } else {
        checkpoints.push(checkpoint)
      }
    }

    if (input.missingUserMessageUuid) unsupported.set('历史用户消息', 'checkpoint_missing')

    const desiredByPath = new Map<string, CheckpointFileState>()
    for (const checkpoint of checkpoints) {
      for (const [path, state] of Object.entries(checkpoint.files)) {
        if (!desiredByPath.has(path)) desiredByPath.set(path, state)
      }
      for (const [path, reason] of Object.entries(checkpoint.unsupported)) {
        if (!desiredByPath.has(path)) unsupported.set(path, reason)
      }
    }

    const knownStates = manifest.knownStates[targetId] ?? {}
    const changes: RewindFileChangePreview[] = []
    const conflicts: string[] = []
    for (const [path, desired] of desiredByPath) {
      const resolvedPath = this.resolveTrackedPath(input.targetRoot, path)
      if (!resolvedPath) {
        unsupported.set(path, 'path_outside_target')
        continue
      }
      const current = this.captureFingerprint(resolvedPath.absolutePath)
      if (this.fingerprintMatchesState(current, desired)) continue
      if (desired.kind === 'file' && !this.isUsableBackupFile(input.sessionId, desired.backupFileName)) {
        unsupported.set(path, 'io_error')
        continue
      }
      const known = knownStates[path]
      if (!known || known.kind === 'unsupported' || !this.fingerprintsEqual(current, known)) {
        conflicts.push(path)
        continue
      }
      changes.push({ path, action: desired.kind === 'missing' ? 'delete' : 'restore' })
    }

    changes.sort((left, right) => left.path.localeCompare(right.path))
    conflicts.sort()
    const unsupportedList = [...unsupported.entries()]
      .map(([path, reason]) => ({ path, reason }))
      .sort((left, right) => left.path.localeCompare(right.path))
    const available = unsupportedList.length === 0
    return {
      targetId,
      available,
      changes,
      conflicts,
      unsupported: unsupportedList,
      desiredByPath,
      checkpointUserMessageUuids: requested,
      ...(!available ? { error: '部分后续轮次或文件没有可用检查点，只能安全回退对话。' } : {}),
    }
  }

  private restoreState(
    targetRoot: string,
    relativePath: string,
    state: CheckpointFileState,
    backupRoot: string,
    phase: AgentFileRestorePhase,
  ): void {
    this.beforeRestore?.(phase, relativePath)
    const resolvedPath = this.resolveTrackedPath(targetRoot, relativePath)
    if (!resolvedPath) throw new Error(`路径已越过当前 Session Target: ${relativePath}`)
    if (state.kind === 'missing') {
      if (existsSync(resolvedPath.absolutePath)) unlinkSync(resolvedPath.absolutePath)
      return
    }
    const backupPath = resolve(backupRoot, state.backupFileName.includes('/')
      ? state.backupFileName
      : state.backupFileName)
    if (!this.isUsableBackupPath(backupRoot, backupPath)) {
      throw new Error(`文件检查点备份不存在: ${relativePath}`)
    }
    mkdirSync(dirname(resolvedPath.absolutePath), { recursive: true })
    copyFileSync(backupPath, resolvedPath.absolutePath)
    chmodSync(resolvedPath.absolutePath, state.mode)
  }

  private isUsableBackupFile(sessionId: string, backupFileName: string): boolean {
    const root = this.checkpointBackupRoot(sessionId)
    return this.isUsableBackupPath(root, resolve(root, backupFileName))
  }

  private isUsableBackupPath(root: string, candidate: string): boolean {
    try {
      if (!isPathInside(root, candidate) || !lstatSync(candidate).isFile()) return false
      const realRoot = realpathSync.native(root)
      const realCandidate = realpathSync.native(candidate)
      return isPathInside(realRoot, realCandidate)
    } catch {
      return false
    }
  }

  private captureCurrentStateForTransaction(
    absolutePath: string,
    transactionDir: string,
    relativePath: string,
  ): CheckpointFileState {
    const fingerprint = this.captureFingerprint(absolutePath)
    if (fingerprint.kind === 'missing') return { kind: 'missing' }
    if (fingerprint.kind === 'unsupported') throw new Error(`无法为回退事务暂存当前文件: ${relativePath}`)
    const backupFileName = hash(relativePath).slice(0, 24)
    const backupPath = join(transactionDir, backupFileName)
    copyFileSync(absolutePath, backupPath)
    chmodSync(backupPath, fingerprint.mode)
    return { ...fingerprint, backupFileName }
  }

  private resolveTrackedPath(targetRoot: string, filePath: string): ResolvedTrackedPath | undefined {
    let realRoot: string
    try {
      realRoot = realpathSync.native(resolve(targetRoot))
    } catch {
      return undefined
    }
    const lexicalPath = isAbsolute(filePath) ? resolve(filePath) : resolve(targetRoot, filePath)
    if (!isPathInside(targetRoot, lexicalPath)) return undefined

    let existingAncestor = lexicalPath
    while (!existsSync(existingAncestor)) {
      const parent = dirname(existingAncestor)
      if (parent === existingAncestor) return undefined
      existingAncestor = parent
    }
    try {
      const ancestorMetadata = lstatSync(existingAncestor)
      if (ancestorMetadata.isSymbolicLink()) return undefined
      const realAncestor = realpathSync.native(existingAncestor)
      if (!isPathInside(realRoot, realAncestor)) return undefined
      if (existsSync(lexicalPath)) {
        const metadata = lstatSync(lexicalPath)
        if (metadata.isSymbolicLink()) return undefined
        const realCandidate = realpathSync.native(lexicalPath)
        if (!isPathInside(realRoot, realCandidate)) return undefined
      }
    } catch {
      return undefined
    }

    const relativePath = relative(resolve(targetRoot), lexicalPath)
    if (!relativePath || relativePath === '.' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      return undefined
    }
    return { absolutePath: lexicalPath, relativePath: normalizeRelativePath(relativePath) }
  }

  private captureFingerprint(absolutePath: string): FileFingerprint {
    try {
      if (!existsSync(absolutePath)) return { kind: 'missing' }
      const metadata = lstatSync(absolutePath)
      if (metadata.isSymbolicLink()) return { kind: 'unsupported', reason: 'path_symlink' }
      if (!metadata.isFile()) return { kind: 'unsupported', reason: 'not_regular_file' }
      if (metadata.size > this.maxFileBytes) return { kind: 'unsupported', reason: 'file_too_large' }
      const content = readFileSync(absolutePath)
      return {
        kind: 'file',
        size: metadata.size,
        mode: metadata.mode,
        sha256: createHash('sha256').update(content).digest('hex'),
      }
    } catch {
      return { kind: 'unsupported', reason: 'io_error' }
    }
  }

  private fingerprintMatchesState(fingerprint: FileFingerprint, state: CheckpointFileState): boolean {
    if (fingerprint.kind === 'missing' || state.kind === 'missing') return fingerprint.kind === state.kind
    if (fingerprint.kind !== 'file') return false
    return fingerprint.size === state.size
      && fingerprint.mode === state.mode
      && fingerprint.sha256 === state.sha256
  }

  private fingerprintsEqual(left: FileFingerprint, right: FileFingerprint): boolean {
    if (left.kind !== right.kind) return false
    if (left.kind === 'missing' && right.kind === 'missing') return true
    if (left.kind === 'unsupported' && right.kind === 'unsupported') return left.reason === right.reason
    if (left.kind === 'file' && right.kind === 'file') {
      return left.size === right.size && left.mode === right.mode && left.sha256 === right.sha256
    }
    return false
  }

  private targetId(targetRoot: string): string {
    const realRoot = realpathSync.native(resolve(targetRoot))
    return hash(normalizeForComparison(realRoot))
  }

  private sessionDir(sessionId: string): string {
    return join(this.storageRoot, sanitizeDirectoryName(sessionId))
  }

  private manifestPath(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'manifest.json')
  }

  private checkpointBackupRoot(sessionId: string): string {
    return join(this.sessionDir(sessionId), 'backups')
  }

  private checkpointBackupDir(sessionId: string, checkpoint: FileCheckpoint): string {
    return this.safeBackupDirectory(sessionId, checkpoint.backupDirName)
  }

  private stagePendingRewindUndo(input: {
    sessionId: string
    targetId: string
    transactionDirName: string
    checkpointUserMessageUuids: string[]
    files: PendingRewindUndoFile[]
    hostState: AgentRewindUndoHostState
  }): void {
    if (!this.isUsableTransactionDirectory(input.sessionId, input.transactionDirName)) {
      throw new Error('回退事务目录不安全')
    }
    const transcriptBytes = Buffer.byteLength(input.hostState.sourceTranscriptContent, 'utf8')
      + Buffer.byteLength(input.hostState.rewoundTranscriptContent, 'utf8')
    if (transcriptBytes > this.maxSessionBytes) throw new Error('撤销回退对话备份超过会话容量限制')
    const transactionDir = this.safeTransactionDirectory(input.sessionId, input.transactionDirName)
    const sourceTranscriptFileName = 'transcript-source.jsonl'
    const rewoundTranscriptFileName = 'transcript-rewound.jsonl'
    writeFileSync(join(transactionDir, sourceTranscriptFileName), input.hostState.sourceTranscriptContent, { encoding: 'utf8', mode: 0o600 })
    writeFileSync(join(transactionDir, rewoundTranscriptFileName), input.hostState.rewoundTranscriptContent, { encoding: 'utf8', mode: 0o600 })
    const manifest = this.readManifest(input.sessionId)
    if (manifest.pendingRewindUndo) throw new Error('当前会话已存在待恢复或待撤销的回退事务')
    manifest.pendingRewindUndo = {
      transactionDirName: input.transactionDirName,
      targetId: input.targetId,
      createdAt: this.now(),
      phase: 'rewind_in_progress',
      checkpointUserMessageUuids: [...input.checkpointUserMessageUuids],
      files: input.files,
      hostState: {
        sourcePi: input.hostState.sourcePi,
        rewoundPi: input.hostState.rewoundPi,
      },
      sourceTranscriptFileName,
      rewoundTranscriptFileName,
    }
    this.writeManifest(input.sessionId, manifest)
  }

  private clearPendingRewindUndo(sessionId: string, transactionDirName: string): void {
    const manifest = this.readManifest(sessionId)
    if (manifest.pendingRewindUndo?.transactionDirName !== transactionDirName) return
    delete manifest.pendingRewindUndo
    this.writeManifest(sessionId, manifest)
  }

  private safeTransactionDirectory(sessionId: string, transactionDirName: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(transactionDirName)) throw new Error('回退事务目录名不安全')
    const root = join(this.sessionDir(sessionId), 'transactions')
    const candidate = resolve(root, transactionDirName)
    if (!isPathInside(root, candidate)) throw new Error('回退事务目录越界')
    return candidate
  }

  private isUsableTransactionDirectory(sessionId: string, transactionDirName: string): boolean {
    try {
      const storageRoot = resolve(this.storageRoot)
      const sessionDir = this.sessionDir(sessionId)
      const transactionRoot = join(sessionDir, 'transactions')
      const candidate = this.safeTransactionDirectory(sessionId, transactionDirName)
      for (const directory of [storageRoot, sessionDir, transactionRoot, candidate]) {
        const metadata = lstatSync(directory)
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false
      }
      const realStorageRoot = realpathSync.native(storageRoot)
      const realCandidate = realpathSync.native(candidate)
      return isPathInside(realStorageRoot, realCandidate)
    } catch {
      return false
    }
  }

  private safeBackupDirectory(sessionId: string, backupDirName: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(backupDirName)) throw new Error('文件检查点目录名不安全')
    const root = this.checkpointBackupRoot(sessionId)
    const candidate = resolve(root, backupDirName)
    if (!isPathInside(root, candidate)) throw new Error('文件检查点目录越界')
    return candidate
  }

  private readManifest(sessionId: string): FileCheckpointManifest {
    const path = this.manifestPath(sessionId)
    if (!existsSync(path)) return emptyManifest()
    try {
      if (statSync(path).size > MAX_MANIFEST_BYTES) throw new Error('manifest too large')
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as FileCheckpointManifest
      if (parsed.version !== MANIFEST_VERSION || !Array.isArray(parsed.checkpoints) || typeof parsed.knownStates !== 'object') {
        throw new Error('invalid manifest')
      }
      if (!Array.isArray(parsed.noMutationUserMessageUuids)) parsed.noMutationUserMessageUuids = []
      if (parsed.pendingRewindUndo && (
        typeof parsed.pendingRewindUndo.transactionDirName !== 'string'
        || typeof parsed.pendingRewindUndo.targetId !== 'string'
        || !['rewind_in_progress', 'undo_available', 'undo_in_progress'].includes(parsed.pendingRewindUndo.phase)
        || typeof parsed.pendingRewindUndo.sourceTranscriptFileName !== 'string'
        || typeof parsed.pendingRewindUndo.rewoundTranscriptFileName !== 'string'
        || !Array.isArray(parsed.pendingRewindUndo.files)
        || !Array.isArray(parsed.pendingRewindUndo.checkpointUserMessageUuids)
        || typeof parsed.pendingRewindUndo.hostState !== 'object'
      )) throw new Error('invalid pending rewind undo')
      return parsed
    } catch (error) {
      throw new Error(`文件检查点索引损坏: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private writeManifest(sessionId: string, manifest: FileCheckpointManifest): void {
    const path = this.manifestPath(sessionId)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const temporaryPath = `${path}.${sanitizeDirectoryName(this.createId())}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(manifest), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryPath, path)
  }

  private collectOldCheckpoints(manifest: FileCheckpointManifest): string[] {
    const staleBackupDirs: string[] = []
    while (manifest.checkpoints.length > this.maxCheckpoints) {
      const stale = manifest.checkpoints.shift()
      if (!stale) break
      staleBackupDirs.push(stale.backupDirName)
    }
    manifest.totalBackupBytes = this.calculateBackupBytes(manifest)
    this.pruneKnownStates(manifest)
    return staleBackupDirs
  }

  private pruneKnownStates(manifest: FileCheckpointManifest): void {
    const reachable = new Map<string, Set<string>>()
    for (const checkpoint of manifest.checkpoints) {
      const paths = reachable.get(checkpoint.targetId) ?? new Set<string>()
      for (const path of Object.keys(checkpoint.files)) paths.add(path)
      for (const path of Object.keys(checkpoint.unsupported)) paths.add(path)
      reachable.set(checkpoint.targetId, paths)
    }
    for (const [targetId, states] of Object.entries(manifest.knownStates)) {
      const paths = reachable.get(targetId)
      if (!paths) {
        delete manifest.knownStates[targetId]
        continue
      }
      for (const path of Object.keys(states)) {
        if (!paths.has(path)) delete states[path]
      }
    }
  }

  private calculateBackupBytes(manifest: FileCheckpointManifest): number {
    let total = 0
    for (const checkpoint of manifest.checkpoints) {
      for (const state of Object.values(checkpoint.files)) {
        if (state.kind === 'file') total += state.size
      }
    }
    return total
  }
}

import type {
  ApplyBaseStrategy,
  SessionCheckoutPhase,
  SessionTargetRef,
  WorktreeValidationItem,
  WorktreeRetentionMode,
  WorktreeValidationStatus,
  AgentDelegationStatus,
} from '@domi/shared'
import type { SessionCheckoutApplyEngine } from './session-checkout-apply.ts'

export interface SessionCheckoutSessionRecord {
  id: string
  projectId?: string
  /** 仅用于创建可读的 managed Worktree 目录名，不参与身份判断。 */
  title?: string
  sourceDelegationId?: string
  parentSessionId?: string
  delegationStatus?: AgentDelegationStatus
  delegationCheckoutReleasedAt?: number
}

export interface SessionCheckoutProjectRecord {
  id: string
  name: string
  root: string
}

export interface SessionCheckoutLookupPort {
  getSession(sessionId: string): SessionCheckoutSessionRecord | undefined
  getProject(projectId: string): SessionCheckoutProjectRecord | undefined
  isSessionActive(sessionId: string): boolean
  /** 先持久化“不可继续”标记，再释放 registry binding，崩溃时保持 fail closed。 */
  markDelegationCheckoutReleased(sessionId: string, releasedAt: number): void
  /** 普通 inherited Fork 释放时先把会话目标收敛为 unselected，再删除共享 binding。 */
  markInheritedCheckoutReleased(sessionId: string): void
  /** integration wiring 可用此策略区分新会话与缺少字段的历史会话。 */
  getUnboundTargetPolicy(session: SessionCheckoutSessionRecord): 'unselected' | 'local'
}

export interface GitCheckoutSnapshot {
  root: string
  commonDir: string
  gitDir: string
  branch: string | null
  headOid: string
  headRef: string
}

export interface SessionCheckoutGitPort {
  inspect(root: string): Promise<GitCheckoutSnapshot | null>
  /** 返回指定目录所属的 Git checkout 顶层；不要求仓库已有 HEAD。 */
  findContainingWorktreeRoot(root: string): Promise<string | null>
  status(root: string): Promise<{ dirty: boolean }>
  createDetachedWorktree(localRoot: string, managedRoot: string, baseOid: string): Promise<void>
  /** 已由宿主验证 checkout identity 与含 untracked 的完整 fingerprint 后执行删除。 */
  removeWorktree(localRoot: string, managedRoot: string): Promise<void>
  retainApplyBase(localRoot: string, checkoutId: string, oid: string): Promise<void>
  releaseApplyBase(localRoot: string, checkoutId: string): Promise<void>
  retainInternalArtifact(localRoot: string, checkoutId: string, artifactName: string, oid: string): Promise<void>
  releaseInternalArtifacts(localRoot: string, checkoutId: string, artifactPrefix?: string): Promise<void>
  /** 只读 ancestry 证明；仅接受宿主已验证的 checkout root 与 OID。 */
  isAncestor(root: string, ancestorOid: string, descendantOid: string): Promise<boolean>
}

export interface DirectoryIdentity {
  device: string
  inode: string
  birthtimeNs: string
}

export interface SessionCheckoutFilesPort {
  exists(path: string): boolean
  canonicalize(path: string): Promise<string>
  inspectDirectoryIdentity(path: string): Promise<DirectoryIdentity | null>
  ensureDirectory(path: string): void
  /** 仅当整棵目录树不含文件或符号链接时删除；用于收口 git worktree add 的空目录残留。 */
  removeEmptyDirectoryTree(path: string): boolean
  /** 将同一父目录下、文件身份匹配的残余原子移动到 Domi 私有 quarantine。 */
  quarantineDirectoryTree(path: string, expectedIdentity: DirectoryIdentity, quarantinePath: string): Promise<void>
  /** 删除已取得所有权的非空目录树；根路径不得是文件或符号链接。 */
  removeDirectoryTree(path: string): Promise<void>
  /** 估算目录真实文件占用；不跟随符号链接。 */
  measureDirectoryBytes(path: string): Promise<number>
}

export interface SessionBindingRecord {
  sessionId: string
  projectId: string
  projectName: string
  target: SessionTargetRef
  ownerSessionId: string
  inheritedFromSessionId?: string
  sourceRef: string
  sourceOid: string
  revision: number
}

interface ManagedCheckoutJournalBase {
  operationId: string
  startedAt: number
}

export interface ManagedCheckoutCreateJournal extends ManagedCheckoutJournalBase {
  operation: 'create'
  step: 'creating_worktree'
}

export interface ManagedCheckoutMutationJournal extends ManagedCheckoutJournalBase {
  operation: 'apply' | 'preview' | 'checkpoint' | 'rollback_preview' | 'finish' | 'finalize_preview' | 'cleanup'
  step: 'planning' | 'artifacts_retained' | 'writing_local' | 'updating_ref' | 'replacing_index' | 'removing_worktree'
  baseOid?: string
  planRevision?: string
  previewId?: string
  reviewId?: string
  localFingerprint?: string
  isolatedFingerprint?: string
  effectiveBaseOid?: string
  baseStrategy?: ApplyBaseStrategy
  localHeadOid?: string
  isolatedHeadOid?: string
  commitOid?: string
  checkpointId?: string
  checkpointSequence?: number
  checkpointMessage?: string
  checkpointIndexTreeOid?: string
  parentOid?: string
  retention?: WorktreeRetentionMode
  /** rollback_preview 崩溃恢复时必须保留原本要回到 working 还是 ready_for_review。 */
  resumeRevision?: boolean
  changedFiles?: string[]
  managedDirectoryIdentity?: DirectoryIdentity
  cleanupQuarantinePath?: string
}

export type ManagedCheckoutJournal = ManagedCheckoutCreateJournal | ManagedCheckoutMutationJournal

export interface ManagedWorktreeCheckpointRecord {
  checkpointId: string
  sequence: number
  reviewId: string
  iteration: number
  createdAt: number
  commitOid: string
  parentOid: string
  summary: string
  commitMessage: string
  validationStatus: WorktreeValidationStatus
  changedFiles: string[]
}

export interface ManagedWorktreePreviousReviewRecord {
  reviewId: string
  iteration: number
  summary: string
  suggestedCommitMessage: string
  changedFiles: string[]
  reviewBaseOid?: string
  reviewBaseStrategy?: ApplyBaseStrategy
  reviewLocalHeadOid?: string
}

export interface ManagedWorktreeReviewRecord {
  reviewId: string
  iteration: number
  preparedAt: number
  detailsMarkdown?: string
  summary: string
  validationStatus: WorktreeValidationStatus
  validationSummary?: string
  tests: WorktreeValidationItem[]
  changedFiles: string[]
  suggestedCommitMessage: string
  isolatedFingerprint: string
  isolatedHeadOid: string
  /** changedFiles 与提交说明所对应的有效验收基线。 */
  reviewBaseOid?: string
  /** 有效验收基线的选择策略。 */
  reviewBaseStrategy?: ApplyBaseStrategy
  /** 生成验收快照时观察到的 Local HEAD。 */
  reviewLocalHeadOid?: string
}

export interface ManagedPreviewReceipt {
  previewId: string
  reviewId: string
  iteration: number
  previewedAt: number
  configuredBaseOid: string
  effectiveBaseOid: string
  baseStrategy: ApplyBaseStrategy
  localHeadOid: string
  localHeadRef: string | null
  localFingerprintBefore: string
  localFingerprintPreview: string
  localWorkingTreeOid: string
  localIndexTreeOid: string
  previewWorkingTreeOid: string
  isolatedHeadOid: string
  isolatedFingerprint: string
  isolatedSnapshotOid: string
  changedFiles: string[]
}

export interface ManagedDeliveryProof {
  localBranch: string | null
  localHeadBefore: string
  localHeadAfter: string
  changedFiles: string[]
}

export type ManagedCheckoutDelivery =
  | { state: 'working'; iteration: number }
  | { state: 'ready_for_review'; review: ManagedWorktreeReviewRecord }
  | { state: 'preview_active'; review: ManagedWorktreeReviewRecord; preview: ManagedPreviewReceipt }
  | {
      state: 'preview_detached'
      review: ManagedWorktreeReviewRecord
      preview: ManagedPreviewReceipt
      detachedAt: number
      reason: 'stale_local' | 'preview_modified'
      attemptedAction: 'rollback_preview' | 'finalize_preview' | 'discard'
    }
  | {
      state: 'finalized'
      review: ManagedWorktreeReviewRecord
      commitOid: string | null
      /** 新版交付凭证；历史 registry 可缺省。 */
      proof?: ManagedDeliveryProof
      /** Finalized 时已交付的 Isolated 快照；cleanup retry 必须做 fingerprint CAS。 */
      isolatedFingerprint: string
      finalizedAt: number
      cleanup: 'pending' | 'blocked'
      cleanupMessage?: string
    }
  | {
      state: 'retained'
      review: ManagedWorktreeReviewRecord
      commitOid: string | null
      /** 新版交付凭证；历史 registry 可缺省。 */
      proof?: ManagedDeliveryProof
      isolatedFingerprint: string
      retention: Exclude<WorktreeRetentionMode, 'cleanup'>
      retainedAt: number
      expiresAt: number | null
      cleanup: 'scheduled' | 'blocked'
      cleanupMessage?: string
    }
  | { state: 'delivered'; iteration: number; commitOid: string | null; proof?: ManagedDeliveryProof; deliveredAt: number }

export interface ManagedCheckoutRecord {
  checkoutId: string
  projectId: string
  projectName: string
  ownerSessionId: string
  /** 项目在用户 Local Checkout 中的 canonical root。 */
  localRoot: string
  /** 项目在 managed worktree 中的 canonical root，也是 lease cwd。 */
  managedRoot: string
  /** managed Git worktree 的仓库顶层；项目根可能是其子目录。 */
  managedGitRoot: string
  gitCommonDir: string
  gitDir: string
  baseOid: string
  /** 上次成功 Apply 的 Isolated 快照；不改变用户可见 Session Base。 */
  applyBaseOid?: string
  /** 同一迭代最近一次验收的有界摘要；重新生成时只作为累计总结的辅助线索。 */
  previousReview?: ManagedWorktreePreviousReviewRecord
  /** 当前 managed Worktree 内尚未交付到 Local 的线性阶段 checkpoint。 */
  checkpoints?: ManagedWorktreeCheckpointRecord[]
  sourceRef: string
  phase: SessionCheckoutPhase
  delivery: ManagedCheckoutDelivery
  journal: ManagedCheckoutJournal | null
  revision: number
}

export interface ManagedCheckoutsRegistry {
  version: 2
  revision: number
  sessionBindings: Record<string, SessionBindingRecord>
  managedCheckouts: Record<string, ManagedCheckoutRecord>
}

export interface SessionCheckoutRegistryPort {
  read(): ManagedCheckoutsRegistry
  write(registry: ManagedCheckoutsRegistry): void
}

export interface SessionCheckoutTimingEvent {
  phase: 'worktree_create' | 'checkout_bind'
  sessionId: string
  iteration: number
  attempt: number
  outcome: 'success' | 'error'
  timestamp: string
  durationMs: number
}

export interface SessionCheckoutDependencies {
  lookup: SessionCheckoutLookupPort
  git: SessionCheckoutGitPort
  files: SessionCheckoutFilesPort
  registry: SessionCheckoutRegistryPort
  applyEngine: SessionCheckoutApplyEngine
  managedCheckoutsRoot: string
  createCheckoutId(): string
  /** Best-effort safe scalar timing; failures must never affect checkout lifecycle. */
  onTimingEvent?: (event: SessionCheckoutTimingEvent) => void | Promise<void>
}

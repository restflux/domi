import type {
  ManagedWorktreeSummaryView,
  BulkCleanupManagedWorktreeCandidate,
  BulkCleanupManagedWorktreesResult,
  SessionCheckoutErrorCode,
  SessionCheckoutKind,
  SessionCheckoutOperation,
  SessionCheckoutOperationResult,
  SessionTargetBindChoice,
  SessionTargetView,
  WorktreeValidationItem,
  WorktreeRetentionMode,
  WorktreeValidationStatus,
  WorktreeApplyPreflightView,
  WorktreeDeliveryView,
  ApplyBaseStrategy,
} from '@domi/shared'

/** 仅存在于 main 的运行租约，renderer 不得接收这些路径。 */
export interface CheckoutLeasePreviousReview {
  reviewId: string
  iteration: number
  summary: string
  suggestedCommitMessage: string
  changedFiles: string[]
  reviewBaseOid?: string
  reviewBaseStrategy?: ApplyBaseStrategy
  reviewLocalHeadOid?: string
}

export interface CheckoutLease {
  /** 当前租约对应的 Domi Session Target 类型。 */
  kind: SessionCheckoutKind
  cwd: string
  allowedRoot: string
  /** 真实 Local Checkout canonical root，仅供 main 捕获 Local Baseline。 */
  localRoot: string
  baseOid: string
  /** 当前交付迭代的原始稳定基线；用于 checkpoint ancestry 与完整历史校验。 */
  deliveryBaseOid?: string
  /** 当前有效验收基线；冲突解决并整合 Local HEAD 后，提交说明必须以它到最终快照为事实源。 */
  reviewBaseOid?: string
  /** 有效验收基线相对原始 Session Base 的选择策略。 */
  reviewBaseStrategy?: ApplyBaseStrategy
  /** 建立有效验收基线时观察到的 Local HEAD。 */
  reviewLocalHeadOid?: string
  /** 同一迭代上一版验收，仅作为累计总结的辅助线索。 */
  previousReview?: CheckoutLeasePreviousReview
  /** 创建当前 Session Target 时记录的来源 ref；managed Worktree 即使 detached 也保留。 */
  sourceRef: string
  projectId: string
  checkoutId: string
  ownerSessionId: string
  /** 当前 Session Target registry revision；供一次运行的不可变观测快照使用。 */
  revision: number
  /** 当前 managed Worktree 中尚未交付到 Local 的阶段 checkpoint 数量。 */
  checkpointCount?: number
  /** 已交付、已保留或正在 Local 验收的会话仅借用 Local 运行普通问答；Execution Controller 必须强制只读。 */
  followupOnly?: boolean
  followupReason?: 'delivered' | 'discarded' | 'retained' | 'preview_active'
}

export type SessionCheckoutReleaseIntent = 'delete' | 'move'

export interface SessionCheckoutReconcileSummary {
  recoveryRequiredCheckoutIds: string[]
  orphanedCheckoutIds: string[]
  dirtyOrphanedCheckoutIds: string[]
  retainedCheckoutCount: number
}

export interface VerifiedIsolatedBindProof {
  expectedCurrentOid: string
  dirtyConfirmed: boolean
  /** main-only：从已有 Isolated Worktree 的稳定快照创建独立副本。 */
  seedSnapshot?: {
    headOid: string
    indexTreeOid: string
    treeOid: string
    fingerprint: string
    baseOid: string
    applyBaseOid?: string
    sourceRef: string
  }
}

export interface ManageManagedWorktreeInput {
  checkoutId: string
  expectedRevision: number
  action: 'cleanup_retained' | 'retry_cleanup' | 'set_retention' | 'discard'
  retention?: Exclude<WorktreeRetentionMode, 'cleanup'>
  confirmDirty?: boolean
}

export interface ListManagedWorktreesInput {
  projectId?: string
  needsAttention?: boolean
  checkoutId?: string
  includeDiagnostics?: boolean
}

export interface SessionHandoffSnapshot {
  /** 实际点击“交接到新会话”的来源会话；继承/fork 会话必须保留自身身份。 */
  originSessionId: string
  /** 当前 Session Target 的 owner，仅用于追溯；不把 handoff 权限提升为 owner 写权限。 */
  originTargetOwnerSessionId: string
  originTargetKind: 'local' | 'isolated'
  originCheckoutId: string
  originRevision: number
  projectId: string
  projectName: string
  localHeadOid: string
  localHeadRef: string | null
  localDirty: boolean
  changedFiles: string[]
  summary: string
  detailsMarkdown?: string
  validationStatus: WorktreeValidationStatus
  validationSummary?: string
  tests: WorktreeValidationItem[]
  iteration?: number
  reviewId?: string
  previewId?: string
  detachedReason?: 'stale_local' | 'preview_modified'
  attemptedAction?: 'rollback_preview' | 'finalize_preview' | 'discard'
  configuredBaseOid?: string
  effectiveBaseOid?: string
  isolatedHeadOid?: string
  isolatedSnapshotOid?: string
  previewWorkingTreeOid?: string
}

export type WorktreeRecoveryHandoffSnapshot = SessionHandoffSnapshot & {
  originTargetKind: 'isolated'
  iteration: number
  reviewId: string
  previewId: string
  detachedReason: 'stale_local' | 'preview_modified'
  attemptedAction: 'rollback_preview' | 'finalize_preview' | 'discard'
  configuredBaseOid: string
  effectiveBaseOid: string
  isolatedHeadOid: string
  isolatedSnapshotOid: string
  previewWorkingTreeOid: string
}

export interface MarkReadyForReviewInput {
  detailsMarkdown?: string
  summary: string
  validationStatus: WorktreeValidationStatus
  validationSummary?: string
  tests: WorktreeValidationItem[]
  suggestedCommitMessage: string
}

/** Session Checkout Module 对业务调用方暴露的完整核心接口。 */
export interface SessionCheckoutModule {
  inspect(sessionId: string): Promise<SessionTargetView>
  /**
   * 批量读取 registry 中已持久化的 Isolated 交付状态。
   * 不执行 Git/fs 校验，也不进入 checkout mutation 队列；用于全局只读投影。
   */
  readSessionDeliveries(sessionIds: readonly string[]): Map<string, WorktreeDeliveryView>
  /** 聚合该 owner 会话历次 Isolated Checkout 中持久化的项目产物相对路径。 */
  readSessionChangedFiles(sessionId: string): string[]
  /** 只读同步预检；不修改 Local、Worktree、registry、review 状态或 Git refs。 */
  preflight?(sessionId: string, expectedRevision: number): Promise<WorktreeApplyPreflightView>
  /** 主进程内部跨模块 mutation：与 bind/apply/discard/cleanup 共用同一独占锁。 */
  runExclusiveSessionMutation<T>(
    sessionId: string,
    operation: (target: SessionTargetView) => Promise<T>,
  ): Promise<T>
  bind(sessionId: string, choice: SessionTargetBindChoice): Promise<SessionTargetView>
  /** 将已有 Isolated Worktree 的稳定 Git 状态复制为 child 自己拥有的独立 target。 */
  cloneIsolatedTarget(sourceSessionId: string, childSessionId: string, expectedSourceRevision: number): Promise<SessionTargetView>
  /** 仅 main 内部 handoff 使用：在同一 binding lock 内校验最终 HEAD/dirty snapshot 并创建。 */
  bindVerifiedIsolated(sessionId: string, proof: VerifiedIsolatedBindProof): Promise<SessionTargetView>
  /** 已交付 owner 会话确认需要修改代码时，惰性创建下一轮 Isolated Checkout。 */
  beginNextIteration(sessionId: string): Promise<SessionTargetView>
  /** main-only：捕获任意会话 handoff 的无路径稳定证据，不修改 Local 或旧 Worktree。 */
  captureSessionHandoff(sessionId: string, expectedRevision: number): Promise<SessionHandoffSnapshot>
  /** 兼容 Preview recovery 专用调用；仅接受 detached Preview。 */
  captureRecoveryHandoff(sessionId: string, expectedRevision: number): Promise<WorktreeRecoveryHandoffSnapshot>
  lease(sessionId: string): Promise<CheckoutLease>
  markReadyForReview(sessionId: string, input: MarkReadyForReviewInput): Promise<SessionTargetView>
  operate(input: SessionCheckoutOperation): Promise<SessionCheckoutOperationResult>
  listManagedWorktrees(input?: ListManagedWorktreesInput): Promise<ManagedWorktreeSummaryView[]>
  /** main-owned 只读清理巡检；不写 registry、Git refs 或目录。 */
  inspectManagedWorktreeCleanup(input?: ListManagedWorktreesInput): Promise<ManagedWorktreeSummaryView[]>
  bulkCleanupManagedWorktrees(candidates: BulkCleanupManagedWorktreeCandidate[]): Promise<BulkCleanupManagedWorktreesResult>
  manageManagedWorktree(input: ManageManagedWorktreeInput): Promise<ManagedWorktreeSummaryView>
  /** 仅 main reveal IPC 使用，renderer 不得接收返回路径。 */
  resolveManagedRootForReveal(checkoutId: string): Promise<string>
  cleanupExpiredRetained(now?: number): Promise<string[]>
  assertReleaseSession(sessionId: string, intent: SessionCheckoutReleaseIntent): Promise<void>
  releaseSession(sessionId: string, intent: SessionCheckoutReleaseIntent): Promise<void>
  reconcile(): Promise<SessionCheckoutReconcileSummary>
}

export class SessionCheckoutError extends Error {
  readonly code: SessionCheckoutErrorCode

  constructor(code: SessionCheckoutErrorCode, message: string) {
    super(message)
    this.name = 'SessionCheckoutError'
    this.code = code
  }
}

/** 会话目标在持久化层中的稳定引用。路径与分支都不是 checkout 身份。 */
export type SessionTargetRef =
  | { kind: 'unselected' }
  | { kind: 'local' }
  | { kind: 'isolated'; checkoutId: string }

export type SessionCheckoutKind = 'local' | 'isolated'

export type SessionCheckoutPhase =
  | 'preparing'
  | 'ready'
  /** @deprecated v1 registry/runtime compatibility; new mutations use mutating. */
  | 'applying'
  | 'mutating'
  | 'recovery_required'
  | 'finalized'
  | 'retained'
  | 'discarded'

export type WorktreeValidationStatus = 'passed' | 'failed' | 'partial' | 'not_run'

/** cleanup 是默认立即清理；其余值只在用户显式选择保留运行环境时使用。 */
export type WorktreeRetentionMode = 'cleanup' | 'retain_24h' | 'retain_3d' | 'retain_manual'

export type WorktreeCleanupReason =
  | 'directory_busy'
  | 'modified_after_finalize'
  | 'collaborator_active'
  | 'identity_changed'
  | 'detached_residue'
  | 'quarantine_busy'

export interface WorktreeValidationItem {
  command: string
  status: 'passed' | 'failed' | 'not_run'
  summary?: string
}

export interface WorktreeCheckpointView {
  checkpointId: string
  sequence: number
  reviewId: string
  createdAt: number
  summary: string
  validationStatus: WorktreeValidationStatus
  changedFiles: string[]
}

export interface WorktreeReviewView {
  reviewId: string
  iteration: number
  preparedAt: number
  /** 宿主在验收卡之前确定性渲染的完整 Markdown 正文。历史记录可缺省。 */
  detailsMarkdown?: string
  summary: string
  validationStatus: WorktreeValidationStatus
  validationSummary?: string
  tests: WorktreeValidationItem[]
  changedFiles: string[]
  suggestedCommitMessage: string
  /** 本次验收 changedFiles 与提交说明使用的有效基线；历史记录可缺省。 */
  reviewBaseOid?: string
  /** 有效基线相对初始 Session Base 的选择策略；历史记录可缺省。 */
  reviewBaseStrategy?: ApplyBaseStrategy
  /** 生成验收快照时观察到的 Local HEAD；历史记录可缺省。 */
  reviewLocalHeadOid?: string
}

export interface WorktreeDeliveryProofView {
  /** 提交时 Local 所在分支；null 表示 detached，自动 Finish 会拒绝这种状态。 */
  localBranch: string | null
  localHeadBefore: string
  localHeadAfter: string
  changedFiles: string[]
  /** 当前查看时，本轮 commit 是否仍是 Local HEAD 的祖先。无 commit 时为 null。 */
  commitInLocalHistory: boolean | null
}

export type WorktreeDeliveryView =
  | { state: 'working'; iteration: number }
  | { state: 'ready_for_review'; review: WorktreeReviewView }
  | { state: 'preview_active'; review: WorktreeReviewView; previewedAt: number }
  | {
      state: 'preview_detached'
      review: WorktreeReviewView
      previewedAt: number
      detachedAt: number
      reason: 'stale_local' | 'preview_modified'
      attemptedAction: 'rollback_preview' | 'finalize_preview' | 'discard'
    }
  | {
      state: 'finalized'
      review: WorktreeReviewView
      commitOid: string | null
      /** 新版交付凭证；历史记录可缺省。 */
      proof?: WorktreeDeliveryProofView
      cleanup: 'pending' | 'blocked'
      cleanupMessage?: string
    }
  | {
      state: 'retained'
      review: WorktreeReviewView
      commitOid: string | null
      /** 新版交付凭证；历史记录可缺省。 */
      proof?: WorktreeDeliveryProofView
      retention: Exclude<WorktreeRetentionMode, 'cleanup'>
      retainedAt: number
      expiresAt: number | null
      cleanup: 'scheduled' | 'blocked'
      cleanupMessage?: string
    }
  | { state: 'delivered'; iteration: number; commitOid: string | null; proof?: WorktreeDeliveryProofView; deliveredAt: number }

export type WorktreeApplyPreflightBlockedReason =
  | 'not_owner'
  | 'not_ready_for_review'
  | 'stale_target'
  | 'stale_isolated'
  | 'project_acceptance_busy'
  | 'checkout_unavailable'
  | 'git_error'

export interface WorktreeApplyPreflightFacts {
  checkoutId: string
  reviewId: string
  revision: number
  configuredBaseOid: string
  effectiveBaseOid: string
  baseStrategy: ApplyBaseStrategy
  localBranch: string | null
  localHeadOid: string
  isolatedHeadOid: string
  changedFiles: string[]
}

export type WorktreeApplyPreflightView =
  | ({ status: 'ready' | 'local_advanced' | 'already_in_local'; localModified: false } & WorktreeApplyPreflightFacts)
  | ({ status: 'conflict'; localModified: false; conflictingFiles: string[] } & WorktreeApplyPreflightFacts)
  | {
      status: 'blocked'
      localModified: false
      checkoutId: string
      reviewId: string | null
      revision: number
      reason: WorktreeApplyPreflightBlockedReason
      message: string
    }

export interface SessionTargetProjectView {
  id: string
  name: string
}

export interface SessionTargetCheckoutView {
  id: string
  kind: SessionCheckoutKind
  label: string
  phase: SessionCheckoutPhase
  /** Isolated Checkout 当前或最近结束的 Worktree 迭代号。 */
  iteration?: number
}

export interface SessionTargetSourceView {
  /** 创建目标时记录的来源 ref；detached 来源使用 HEAD。 */
  ref: string
  oid: string
}

export interface SessionTargetCurrentView {
  /** null 明确表示当前 checkout 处于 detached HEAD。 */
  branch: string | null
  oid: string
}

/** 可安全发送到 renderer 的目标视图；不得加入本地绝对路径。 */
export type WorktreeCollaboratorStatus = 'running' | 'idle' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'unknown'

/** Checkout owner 可见的协作占用投影；不包含路径、委派提示词或内部 refs。 */
export interface WorktreeCollaboratorView {
  sessionId: string
  title: string
  kind: 'delegation' | 'fork' | 'unknown'
  status: WorktreeCollaboratorStatus
  /** 已停止的 delegation 或普通 inherited Fork 可显式释放；running 会话必须先停止。 */
  canRelease: boolean
}

export interface SessionTargetView {
  project: SessionTargetProjectView
  checkout: SessionTargetCheckoutView
  source: SessionTargetSourceView
  current: SessionTargetCurrentView
  ownership: 'owner' | 'inherited'
  dirty: boolean
  revision: number
  /** Isolated checkout 的交付状态；Local target 不提供。 */
  delivery?: WorktreeDeliveryView
  /** 当前 managed Worktree 内尚未交付到 Local 的阶段 checkpoint。 */
  checkpoints?: WorktreeCheckpointView[]
  /** 当前项目 Local Preview 槽位状态；不暴露其他 checkout 身份。 */
  reviewSlot?: 'available' | 'waiting'
  /** 槽位被占用时对应的 owner Agent 会话；仅供受限会话跳转，不暴露 checkout 或路径。 */
  reviewSlotOwnerSessionId?: string
  /** 仍绑定当前 owner Worktree 的协作会话。 */
  collaborators?: WorktreeCollaboratorView[]
}

export type SessionTargetBindChoice =
  | { kind: 'local' }
  | { kind: 'isolated' }
  | { kind: 'inherit'; parentSessionId: string }

interface SessionCheckoutOperationBase {
  sessionId: string
  expectedRevision: number
}

export interface SessionCheckoutApplyOperation extends SessionCheckoutOperationBase {
  action: 'apply'
}

export interface SessionCheckoutFinishOperation extends SessionCheckoutOperationBase {
  action: 'finish'
  commitMessage: string
  retention?: WorktreeRetentionMode
}

export interface SessionCheckoutPreviewOperation extends SessionCheckoutOperationBase {
  action: 'preview'
}

export interface SessionCheckoutCheckpointOperation extends SessionCheckoutOperationBase {
  action: 'checkpoint'
  commitMessage: string
}

export interface SessionCheckoutRollbackPreviewOperation extends SessionCheckoutOperationBase {
  action: 'rollback_preview'
  /** 结构化“撤回并继续修改”确认使用；普通撤回仍保留原验收卡。 */
  resumeRevision?: boolean
}

export interface SessionCheckoutFinalizePreviewOperation extends SessionCheckoutOperationBase {
  action: 'finalize_preview'
  commitMessage: string
  retention?: WorktreeRetentionMode
}

export interface SessionCheckoutRetryCleanupOperation extends SessionCheckoutOperationBase {
  action: 'retry_cleanup'
}

export interface SessionCheckoutDiscardOperation extends SessionCheckoutOperationBase {
  action: 'discard'
  confirmDirty: boolean
}

export interface SessionCheckoutRecoverOperation extends SessionCheckoutOperationBase {
  action: 'recover'
}

export interface SessionCheckoutReleaseCollaboratorOperation extends SessionCheckoutOperationBase {
  action: 'release_collaborator'
  collaboratorSessionId: string
}

export interface SessionCheckoutReleaseCollaboratorsOperation extends SessionCheckoutOperationBase {
  action: 'release_collaborators'
}

export type SessionCheckoutOperation =
  | SessionCheckoutApplyOperation
  | SessionCheckoutFinishOperation
  | SessionCheckoutPreviewOperation
  | SessionCheckoutCheckpointOperation
  | SessionCheckoutRollbackPreviewOperation
  | SessionCheckoutFinalizePreviewOperation
  | SessionCheckoutRetryCleanupOperation
  | SessionCheckoutDiscardOperation
  | SessionCheckoutRecoverOperation
  | SessionCheckoutReleaseCollaboratorOperation
  | SessionCheckoutReleaseCollaboratorsOperation

export interface SessionCheckoutAppliedResult {
  status: 'applied'
  target: SessionTargetView
  changedFiles: string[]
}

export interface SessionCheckoutPreviewedResult {
  status: 'previewed'
  target: SessionTargetView
  changedFiles: string[]
}

export interface SessionCheckoutCheckpointedResult {
  status: 'checkpointed'
  target: SessionTargetView
  checkpoint: WorktreeCheckpointView
  changedFiles: string[]
}

export interface SessionCheckoutPreviewRolledBackResult {
  status: 'preview_rolled_back'
  target: SessionTargetView
  changedFiles: string[]
}

export interface SessionCheckoutPreviewDetachedResult {
  status: 'preview_detached'
  target: SessionTargetView
  changedFiles: string[]
  reason: 'stale_local' | 'preview_modified'
  attemptedAction: 'rollback_preview' | 'finalize_preview' | 'discard'
}

export interface SessionCheckoutFinishedResult {
  status: 'finished'
  target: SessionTargetView
  changedFiles: string[]
  /** null 表示没有任务增量，因此没有创建空提交。 */
  commitOid: string | null
  /** retained 表示提交已成功，用户显式保留冻结运行环境。 */
  cleanup: 'discarded' | 'pending' | 'retained'
  cleanupMessage?: string
  cleanupReason?: WorktreeCleanupReason
}

export type ManagedWorktreeCleanupEligibility = 'safe' | 'retained' | 'blocked'

export type ManagedWorktreeCleanupBlockReason =
  | 'working'
  | 'review_pending'
  | 'preview_active'
  | 'retention_active'
  | 'uncommitted_changes'
  | 'collaborator_active'
  | 'identity_mismatch'
  | 'cleanup_failed'
  | 'unknown'

/** main 只读巡检产生的无路径清理结论。批量 mutation 必须再次校验，不能把本结果当授权。 */
export interface ManagedWorktreeCleanupView {
  eligibility: ManagedWorktreeCleanupEligibility
  reason: ManagedWorktreeCleanupBlockReason
  message: string
  inspectedRevision: number
}

export interface BulkCleanupManagedWorktreeCandidate {
  checkoutId: string
  expectedRevision: number
}

export interface BulkCleanupManagedWorktreesResult {
  cleaned: Array<{ checkoutId: string; iteration: number; commitOid: string | null }>
  retained: Array<{ checkoutId: string; iteration: number; cleanup: ManagedWorktreeCleanupView }>
}

export type ManagedWorktreeSummaryState =
  | 'working'
  | 'ready_for_review'
  | 'preview_active'
  | 'retained'
  | 'cleanup_pending'
  | 'needs_attention'
  | 'delivered'

/** 全局管理页使用的无路径投影。 */
export interface ManagedWorktreeSummaryView {
  checkoutId: string
  revision: number
  ownerSessionId: string
  ownerSessionTitle: string
  project: SessionTargetProjectView
  iteration: number
  state: ManagedWorktreeSummaryState
  phase: SessionCheckoutPhase
  dirty: boolean
  commitOid: string | null
  retention?: Exclude<WorktreeRetentionMode, 'cleanup'>
  retainedAt?: number
  expiresAt?: number | null
  cleanupMessage?: string
  cleanupReason?: WorktreeCleanupReason
  approximateBytes: number | null
  updatedAt: number
  canReveal: boolean
  canCleanup: boolean
  /** 只读 cleanup inspection；只用于解释与确认，真实清理会重新校验。 */
  cleanup?: ManagedWorktreeCleanupView
  /** 管理面板执行放弃前会停止的真实 active owner/协作会话。 */
  activeSessionIds?: string[]
}

export type ApplyBaseStrategy =
  | 'recorded_base'
  | 'isolated_contains_local_head'
  | 'local_contains_isolated_head'
  | 'shared_merge_base'

export interface SessionCheckoutConflictResult {
  status: 'conflict'
  code: 'apply_conflict'
  reason: 'content_conflict'
  target: SessionTargetView
  baseStrategy: ApplyBaseStrategy
  effectiveBaseOid: string
  /** 冲突计算时的 Local HEAD；Agent 可在当前 Isolated Checkout 内同步到该提交并解决冲突。 */
  localHeadOid: string
  isolatedHeadOid: string
  canRetryAfterRefresh: false
  conflictingFiles: string[]
}

export interface SessionCheckoutDiscardedResult {
  status: 'discarded'
  target: SessionTargetView
}

export interface SessionCheckoutRecoveredResult {
  status: 'recovered'
  target: SessionTargetView
}

export interface SessionCheckoutCollaboratorReleasedResult {
  status: 'collaborator_released'
  target: SessionTargetView
  collaboratorSessionId: string
}

export interface SessionCheckoutCollaboratorsReleasedResult {
  status: 'collaborators_released'
  target: SessionTargetView
  collaboratorSessionIds: string[]
}

export interface SessionCheckoutOperationErrorResult {
  status: 'error'
  code: SessionCheckoutErrorCode
  message: string
  target?: SessionTargetView
}

export type SessionCheckoutOperationResult =
  | SessionCheckoutAppliedResult
  | SessionCheckoutPreviewedResult
  | SessionCheckoutCheckpointedResult
  | SessionCheckoutPreviewRolledBackResult
  | SessionCheckoutPreviewDetachedResult
  | SessionCheckoutFinishedResult
  | SessionCheckoutConflictResult
  | SessionCheckoutDiscardedResult
  | SessionCheckoutRecoveredResult
  | SessionCheckoutCollaboratorReleasedResult
  | SessionCheckoutCollaboratorsReleasedResult
  | SessionCheckoutOperationErrorResult

export const SESSION_CHECKOUT_ERROR_CODES = [
  'session_not_found',
  'project_not_found',
  'project_root_missing',
  'not_git_repository',
  'target_unselected',
  'target_already_bound',
  'parent_session_not_found',
  'parent_target_unselected',
  'project_mismatch',
  'checkout_missing',
  'checkout_mismatch',
  'recovery_required',
  'registry_corrupt',
  'git_operation_failed',
  'not_owner',
  'stale_target',
  'dirty_confirmation_required',
  'apply_conflict',
  'apply_failed',
  'invalid_input',
  'invalid_plan',
  'stale_local',
  'stale_isolated',
  'git_error',
  'commit_isolation_conflict',
  'checkout_limit_reached',
  'project_acceptance_busy',
  'preview_not_active',
  'preview_modified',
  'collaborator_active',
  'operation_not_allowed',
  'recovery_unsafe',
] as const

export type SessionCheckoutErrorCode = typeof SESSION_CHECKOUT_ERROR_CODES[number]

export interface SessionCheckoutFailure {
  code: SessionCheckoutErrorCode
  message: string
}

import type { AgentSessionMeta } from '../types/agent.ts'
import type {
  ManagedWorktreeSummaryView,
  BulkCleanupManagedWorktreeCandidate,
  BulkCleanupManagedWorktreesResult,
  SessionCheckoutOperationResult,
  SessionTargetView,
  WorktreeApplyPreflightView,
  WorktreeRetentionMode,
} from '../types/session-target.ts'

export const SESSION_CHECKOUT_IPC_CHANNELS = {
  INSPECT: 'session-checkout:inspect',
  PREFLIGHT: 'session-checkout:preflight',
  BIND: 'session-checkout:bind',
  CONFIRM_ITERATION: 'session-checkout:confirm-iteration',
  OPERATE: 'session-checkout:operate',
  LIST_MANAGED: 'session-checkout:list-managed',
  MANAGE: 'session-checkout:manage',
  BULK_CLEANUP_MANAGED: 'session-checkout:bulk-cleanup-managed',
  REVEAL_MANAGED: 'session-checkout:reveal-managed',
  HANDOFF_RECOVERY: 'session-checkout:handoff-recovery',
  HANDOFF_SESSION: 'session-checkout:handoff-session',
} as const

/** Renderer 只能选择公开 target，inherit 仅供主进程协作会话接线。 */
export type RendererSessionTargetChoice = { kind: 'local' } | { kind: 'isolated' }
export type SessionCheckoutAction =
  | 'apply'
  | 'finish'
  | 'preview'
  | 'checkpoint'
  | 'rollback_preview'
  | 'finalize_preview'
  | 'retry_cleanup'
  | 'discard'
  | 'recover'
  | 'release_collaborator'
  | 'release_collaborators'

export interface InspectSessionCheckoutInput {
  sessionId: string
}

export interface PreflightSessionCheckoutInput {
  sessionId: string
  expectedRevision: number
}

export interface BindSessionCheckoutInput {
  sessionId: string
  choice: RendererSessionTargetChoice
}

export interface ConfirmWorktreeIterationInput {
  sessionId: string
  requestId: string
}

export interface ConfirmWorktreeIterationResult {
  target: SessionTargetView
  authorizationToken: string
  continuationMessage: string
  requestId: string
  iteration: number
}

export type OperateSessionCheckoutInput =
  | {
      sessionId: string
      action: 'apply' | 'preview' | 'retry_cleanup' | 'recover'
      expectedRevision: number
    }
  | {
      sessionId: string
      action: 'rollback_preview'
      expectedRevision: number
      resumeRevision?: boolean
    }
  | {
      sessionId: string
      action: 'checkpoint'
      expectedRevision: number
      commitMessage: string
    }
  | {
      sessionId: string
      action: 'finish' | 'finalize_preview'
      expectedRevision: number
      commitMessage: string
      retention?: WorktreeRetentionMode
    }
  | {
      sessionId: string
      action: 'discard'
      expectedRevision: number
      confirmDirty: boolean
    }
  | {
      sessionId: string
      action: 'release_collaborator'
      expectedRevision: number
      collaboratorSessionId: string
    }
  | {
      sessionId: string
      action: 'release_collaborators'
      expectedRevision: number
    }

export interface ListManagedWorktreesInput {
  projectId?: string
  needsAttention?: boolean
  /** 只读取指定 checkout；用于管理面板渐进加载单项磁盘与安全诊断。 */
  checkoutId?: string
  /** 默认返回快速保守摘要；开启后才执行 Git dirty/fingerprint 与目录大小扫描。 */
  includeDiagnostics?: boolean
}

export type ManageWorktreeInput =
  | {
      checkoutId: string
      expectedRevision: number
      action: 'cleanup_retained' | 'retry_cleanup'
    }
  | {
      checkoutId: string
      expectedRevision: number
      action: 'discard'
      confirmDirty: true
    }
  | {
      checkoutId: string
      expectedRevision: number
      action: 'set_retention'
      retention: Exclude<WorktreeRetentionMode, 'cleanup'>
    }

export interface BulkCleanupManagedWorktreesInput {
  candidates: BulkCleanupManagedWorktreeCandidate[]
}

export interface RevealManagedWorktreeInput {
  checkoutId: string
}

export interface WorktreeRecoveryHandoffInput {
  sessionId: string
  expectedRevision: number
  confirmedIgnoreDirtyLocal: true
}

export interface WorktreeRecoveryHandoffResult {
  session: AgentSessionMeta
  handoffId: string
  reused: boolean
  mode: 'fork' | 'degraded'
  degradedReason?: AgentSessionMeta['handoffDegradedReason']
}

export interface AgentSessionHandoffInput {
  sessionId: string
  expectedRevision: number
  targetKind: 'local' | 'isolated'
  confirmedIgnoreDirtyLocal: boolean
}

export type AgentSessionHandoffResult = WorktreeRecoveryHandoffResult

export interface SessionCheckoutIpcError {
  code: string
  message: string
}

export type SessionCheckoutIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: SessionCheckoutIpcError }

export interface SessionCheckoutRendererApi {
  inspect(input: InspectSessionCheckoutInput): Promise<SessionCheckoutIpcResult<SessionTargetView>>
  preflight?(input: PreflightSessionCheckoutInput): Promise<SessionCheckoutIpcResult<WorktreeApplyPreflightView>>
  bind(input: BindSessionCheckoutInput): Promise<SessionCheckoutIpcResult<SessionTargetView>>
  confirmIteration?(input: ConfirmWorktreeIterationInput): Promise<SessionCheckoutIpcResult<ConfirmWorktreeIterationResult>>
  operate(input: OperateSessionCheckoutInput): Promise<SessionCheckoutIpcResult<SessionCheckoutOperationResult>>
  listManaged?(input: ListManagedWorktreesInput): Promise<SessionCheckoutIpcResult<ManagedWorktreeSummaryView[]>>
  manage?(input: ManageWorktreeInput): Promise<SessionCheckoutIpcResult<ManagedWorktreeSummaryView>>
  bulkCleanupManaged?(input: BulkCleanupManagedWorktreesInput): Promise<SessionCheckoutIpcResult<BulkCleanupManagedWorktreesResult>>
  revealManaged?(input: RevealManagedWorktreeInput): Promise<SessionCheckoutIpcResult<void>>
  handoffRecovery?(input: WorktreeRecoveryHandoffInput): Promise<SessionCheckoutIpcResult<WorktreeRecoveryHandoffResult>>
  handoffSession?(input: AgentSessionHandoffInput): Promise<SessionCheckoutIpcResult<AgentSessionHandoffResult>>
}

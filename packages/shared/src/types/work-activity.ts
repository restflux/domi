import type { AgentDelegationStatus } from './agent.ts'

export type WorkActivityState = 'attention_required' | 'working' | 'recently_completed'
export type WorkActivitySource = 'manual' | 'automation'
export type WorkActivityOutcome = 'success' | 'stopped' | 'failed' | 'interrupted' | 'unresolved'
export type WorkActivityPendingActionKind =
  | 'ask_user'
  | 'permission'
  | 'plan_approval'
  | 'ready_for_review'
  | 'conflict'
  | 'failure'
  | 'interrupted'

export interface WorkActivityTaskFact {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled' | 'error' | 'deleted'
  activeForm?: string
}

export interface WorkActivityPendingActionFact {
  kind: Exclude<WorkActivityPendingActionKind, 'failure' | 'interrupted'>
  summary: string
  occurredAt: number
}

export interface WorkActivityRunFact {
  status: 'running' | 'success' | 'failed' | 'stopped' | 'interrupted'
  startedAt: number
  finishedAt?: number
  error?: string
}

export interface WorkActivitySessionFact {
  sessionId: string
  parentSessionId?: string
  rootSessionId?: string
  workspaceId?: string
  workspaceName: string
  title: string
  source: WorkActivitySource
  automationName?: string
  archived: boolean
  createdAt: number
  updatedAt: number
  active: boolean
  delegationStatus?: AgentDelegationStatus
  run?: WorkActivityRunFact
  pendingActions: WorkActivityPendingActionFact[]
  phaseSummary?: string
  tasks: WorkActivityTaskFact[]
  viewedAt?: number
  acknowledgedOutcomeAt?: number
  removedOutcomeAt?: number
}

export interface WorkActivityChildView {
  sessionId: string
  title: string
  active: boolean
  status: 'attention_required' | 'working' | 'completed'
  reason: string
  phaseSummary: string
  delegationStatus?: AgentDelegationStatus
  tasks: WorkActivityTaskFact[]
}

export interface WorkSessionView {
  id: string
  rootSessionId: string
  workspaceId?: string
  workspaceName: string
  title: string
  source: WorkActivitySource
  automationName?: string
  state: WorkActivityState
  reason: string
  pendingActionKind?: WorkActivityPendingActionKind
  phaseSummary: string
  startedAt?: number
  stateChangedAt: number
  unread: boolean
  archived: boolean
  outcome?: WorkActivityOutcome
  activeSessionIds: string[]
  completedChildren: number
  totalChildren: number
  tasks: WorkActivityTaskFact[]
  children: WorkActivityChildView[]
}

export interface WorkActivityProjection {
  sessions: WorkSessionView[]
  counts: Record<WorkActivityState, number>
  generatedAt: number
}

export interface WorkActivityStopResult {
  rootSessionId: string
  stoppedSessionIds: string[]
  runningChildCount: number
}

export type WorkActivityNotificationTarget =
  | { type: 'session'; rootSessionId: string }
  | { type: 'work_activity' }

/** Main 已完成去重、合并和前后台路由后的 Renderer 呈现指令。 */
export interface WorkActivityNotificationEvent {
  channel: 'toast' | 'system'
  notification: {
    kind: 'attention' | 'completion'
    title: string
    body: string
    target: WorkActivityNotificationTarget
    soundType: 'permissionRequest' | 'exitPlanMode' | 'taskComplete'
    playSound: boolean
  }
}

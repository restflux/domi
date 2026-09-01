export const EXECUTION_POLICY_MODES = ['controlled', 'autonomous', 'full-access'] as const

export type ExecutionPolicyMode = typeof EXECUTION_POLICY_MODES[number]

export const AGENT_WORKFLOWS = ['direct', 'read-only', 'plan-first'] as const

export type AgentWorkflow = typeof AGENT_WORKFLOWS[number]

export interface PersistedAgentExecutionSettings {
  executionPolicy?: unknown
  workflow?: unknown
  /** @deprecated 仅用于迁移旧 Pi 工具模式。 */
  piToolProfile?: unknown
  /** @deprecated 仅用于读取旧 Runtime 和历史存储。 */
  permissionMode?: unknown
}

export interface NormalizedAgentExecutionSettings {
  executionPolicy: ExecutionPolicyMode
  workflow: AgentWorkflow
}

export interface AgentExecutionControlsUpdate {
  executionPolicy?: ExecutionPolicyMode
  workflow?: AgentWorkflow
}

export type PolicyApprovalScope = 'single' | 'session'

export type PolicyDecisionCategory =
  | 'routine'
  | 'workspace-boundary'
  | 'opaque-command'
  | 'process-network'
  | 'local-baseline'
  | 'destructive-git'
  | 'external-impact'
  | 'sensitive-file'
  | 'user-denied'
  | 'unattended'

export interface PolicyAllowDecision {
  outcome: 'allow'
  category: PolicyDecisionCategory
  approval?: PolicyApprovalScope
  reason: string
}

export interface PolicyDenyDecision {
  outcome: 'deny'
  category: PolicyDecisionCategory
  reason: string
}

export type PolicyDecision = PolicyAllowDecision | PolicyDenyDecision

export interface PolicyApprovalRequest {
  scope: PolicyApprovalScope
  category: Exclude<PolicyDecisionCategory, 'routine' | 'user-denied' | 'unattended'>
  reason: string
  toolName: string
  /** 稳定、脱敏的策略判定代码；不得包含 command、argv、路径或 remote。 */
  decisionCode?: string
}

export type PolicyApprovalResponse = 'approved' | 'denied'

export function isExecutionPolicyMode(value: unknown): value is ExecutionPolicyMode {
  return typeof value === 'string'
    && (EXECUTION_POLICY_MODES as readonly string[]).includes(value)
}

export function isAgentWorkflow(value: unknown): value is AgentWorkflow {
  return typeof value === 'string'
    && (AGENT_WORKFLOWS as readonly string[]).includes(value)
}

export function normalizeAgentExecutionSettings(
  settings: PersistedAgentExecutionSettings,
): NormalizedAgentExecutionSettings {
  const legacyWorkflow: AgentWorkflow = settings.permissionMode === 'plan'
    ? 'read-only'
    : 'direct'
  const persistedWorkflow = isAgentWorkflow(settings.workflow)
    ? settings.workflow
    : legacyWorkflow
  const migratedWorkflow: AgentWorkflow = settings.piToolProfile === 'readOnly'
    ? 'read-only'
    : settings.piToolProfile === 'noBash'
      ? 'direct'
      : persistedWorkflow === 'plan-first'
        ? 'read-only'
        : persistedWorkflow

  return {
    // Controlled / Autonomous are retained as compatibility inputs only. Domi's
    // user-facing Execute mode always runs with the current Windows user's full access;
    // host-owned delivery, Local maintenance, trust, and destructive data transactions
    // keep their independent confirmation boundaries.
    executionPolicy: 'full-access',
    workflow: migratedWorkflow,
  }
}

import type { AgentWorkflow, ExecutionPolicyMode } from '@domi/shared'

export interface AgentControlDisplayOption<T extends string> {
  value: T
  label: string
  description: string
}

export interface AgentWorkflowRuntimeDisplay {
  label: string
  description: string
  kind: 'research' | 'execute' | 'temporary-execute'
}

/** 用户可选择的持久模式只有研究与执行；Plan First 仅保留为运行期兼容状态。 */
export const AGENT_WORKFLOW_DISPLAY_OPTIONS: readonly AgentControlDisplayOption<AgentWorkflow>[] = [
  { value: 'read-only', label: '研究', description: '只读调研；需要修改时可申请仅执行本次' },
  { value: 'direct', label: '执行', description: '直接修改和验证；关键宿主事务仍单独确认' },
]

/** 仅供旧审计/状态数据兼容展示；普通界面不再提供 Execution Policy 选择。 */
export const EXECUTION_POLICY_DISPLAY_OPTIONS: readonly AgentControlDisplayOption<ExecutionPolicyMode>[] = [
  { value: 'full-access', label: '完全访问', description: '使用当前 Windows 用户权限；Domi 没有 OS 沙箱' },
]

export function getAgentWorkflowDisplay(workflow: AgentWorkflow): AgentControlDisplayOption<AgentWorkflow> {
  return workflow === 'direct'
    ? AGENT_WORKFLOW_DISPLAY_OPTIONS[1]!
    : AGENT_WORKFLOW_DISPLAY_OPTIONS[0]!
}

export function getAgentWorkflowRuntimeDisplay(
  workflow: AgentWorkflow,
  temporaryExecution: boolean,
): AgentWorkflowRuntimeDisplay {
  if (workflow !== 'direct' && temporaryExecution) {
    return {
      label: '本次执行',
      description: '当前任务已临时获得执行权限，任务结束后恢复研究模式。',
      kind: 'temporary-execute',
    }
  }
  const display = getAgentWorkflowDisplay(workflow)
  return {
    label: display.label,
    description: workflow === 'direct'
      ? '可直接修改和运行命令；Domi 没有 OS 沙箱，关键宿主事务仍单独确认。'
      : '只读调研；需要修改时可申请仅执行本次。',
    kind: workflow === 'direct' ? 'execute' : 'research',
  }
}

export function getExecutionPolicyDisplay(_policy: ExecutionPolicyMode): AgentControlDisplayOption<ExecutionPolicyMode> {
  return EXECUTION_POLICY_DISPLAY_OPTIONS[0]!
}

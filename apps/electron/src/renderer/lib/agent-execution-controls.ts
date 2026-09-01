import type {
  AgentSessionMeta,
  NormalizedAgentExecutionSettings,
} from '@domi/shared'
import { normalizeAgentExecutionSettings } from '@domi/shared'

export interface AgentSendControlOverrides {
  executionPolicyOverride?: NormalizedAgentExecutionSettings['executionPolicy']
  workflowOverride?: NormalizedAgentExecutionSettings['workflow']
}

export interface ExecutionIsolationIndicator {
  label: '策略边界（非OS沙箱）' | '未沙箱化'
  emphasis: 'bounded' | 'danger'
}

export interface TemporaryExecutionChange {
  active: boolean
  runToken: number
}

/** 只允许同一 run 的撤销事件清除临时执行，防止迟到终态覆盖替换运行。 */
export function updateTemporaryExecutionRunTokens(
  previous: Map<string, number>,
  sessionId: string,
  change: TemporaryExecutionChange,
): Map<string, number> {
  const current = previous.get(sessionId)
  if (change.active) {
    if (current === change.runToken || (current !== undefined && current > change.runToken)) return previous
    const next = new Map(previous)
    next.set(sessionId, change.runToken)
    return next
  }
  if (current !== change.runToken) return previous
  const next = new Map(previous)
  next.delete(sessionId)
  return next
}

/** 模式选择会立即持久化；旧 Plan First 输入只作为 Research 兼容值。 */
export function buildAgentWorkflowUpdate(
  workflow: AgentSessionMeta['workflow'],
): { workflow: NormalizedAgentExecutionSettings['workflow'] } {
  return { workflow: workflow === 'direct' ? 'direct' : 'read-only' }
}

/** Renderer 读取会话 Execution Controls；typed 持久化字段优先，旧字段仅作迁移输入。 */
export function resolveAgentExecutionControls(
  session: AgentSessionMeta | undefined,
): NormalizedAgentExecutionSettings {
  return normalizeAgentExecutionSettings({
    executionPolicy: session?.executionPolicy,
    workflow: session?.workflow,
    piToolProfile: session?.piToolProfile,
    permissionMode: session?.permissionMode,
  })
}

/** Pi-only 发送协议只携带 typed Execution Controls。 */
export function buildAgentSendControlOverrides(
  controls: NormalizedAgentExecutionSettings,
): AgentSendControlOverrides {
  return {
    executionPolicyOverride: controls.executionPolicy,
    workflowOverride: controls.workflow,
  }
}

export function getExecutionIsolationIndicator(
  executionPolicy: NormalizedAgentExecutionSettings['executionPolicy'],
): ExecutionIsolationIndicator {
  return executionPolicy === 'full-access'
    ? { label: '未沙箱化', emphasis: 'danger' }
    : { label: '策略边界（非OS沙箱）', emphasis: 'bounded' }
}

export function formatExecutionControlsError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : '工作方式或安全保护更新失败，请重试'
}

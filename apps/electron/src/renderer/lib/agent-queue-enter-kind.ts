import type { AgentQueueMessageKind } from '@domi/shared'

export type AgentQueueEnterKind = Extract<AgentQueueMessageKind, 'followUp' | 'steering'>

/** Domi 默认与 picli 相反：普通提交进入 follow-up，不提前影响当前工作。 */
export const DEFAULT_AGENT_QUEUE_ENTER_KIND: AgentQueueEnterKind = 'followUp'

export function getAgentQueueSubmitKind(alternate: boolean): AgentQueueEnterKind {
  return alternate ? 'steering' : DEFAULT_AGENT_QUEUE_ENTER_KIND
}

export function getAgentQueueKindLabel(kind: AgentQueueEnterKind): '加入队列' | '调整方向' {
  return kind === 'followUp' ? '加入队列' : '调整方向'
}

import type { AgentIslandPhase } from '@domi/shared'

export interface AgentIslandViewedState {
  phase: AgentIslandPhase
  unread: boolean
  attention: boolean
}

/** 只允许“已完成且未读”的会话被普通查看动作清除；错误/待交互保持 attention。 */
export function markAgentIslandViewed(state: AgentIslandViewedState | undefined): boolean {
  if (state?.phase !== 'completed' || !state.unread) return false
  state.unread = false
  state.attention = false
  return true
}

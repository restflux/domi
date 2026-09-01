export interface AgentBottomFollowSnapshot {
  sessionId: string
  requestRevision: number
}

export interface AgentBottomFollowDecision {
  shouldScrollToBottom: boolean
}

/**
 * 新 turn 仍需立即置底并短暂覆盖紧随其后的布局增长，但不能吞掉用户主动向上滚动。
 * use-stick-to-bottom 在 ignoreEscapes=false 时会让滚轮立即中断这段跟随。
 */
export const AGENT_BOTTOM_FOLLOW_SCROLL_OPTIONS = {
  animation: 'instant',
  ignoreEscapes: false,
  duration: 350,
} as const

/**
 * 只有当前会话真正发起了新的用户 turn，才覆盖旧的阅读位置并重新锁定到底部。
 * 会话首次挂载、消息持久化替换、普通流式更新和切换会话都交给滚动位置记忆处理。
 */
export function resolveAgentBottomFollow(
  previous: AgentBottomFollowSnapshot,
  current: AgentBottomFollowSnapshot,
): AgentBottomFollowDecision {
  return {
    shouldScrollToBottom: current.sessionId === previous.sessionId
      && current.requestRevision > previous.requestRevision,
  }
}

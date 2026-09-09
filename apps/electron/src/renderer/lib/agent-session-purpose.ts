import type { AgentSessionMeta } from '@domi/shared'

/** 侧聊只在父会话侧板展示；普通导航不能根据标题或协作关系推断用途。 */
export function isAgentSessionVisibleInNavigation(
  session: Pick<AgentSessionMeta, 'sideChatParentSessionId'> | undefined,
): boolean {
  return !session?.sideChatParentSessionId
}

interface SessionSearchNavigationResult {
  id: string
  type: 'chat' | 'agent'
}

/** 保留 Chat 与未知元数据结果的原行为，只隐藏已知的侧聊会话。 */
export function filterSessionSearchResultsForNavigation<T extends SessionSearchNavigationResult>(
  results: readonly T[],
  sessions: readonly AgentSessionMeta[],
): T[] {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]))
  return results.filter((result) => (
    result.type === 'chat' || isAgentSessionVisibleInNavigation(sessionsById.get(result.id))
  ))
}

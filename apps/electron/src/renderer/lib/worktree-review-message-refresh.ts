import type { AgentEvent } from '@domi/shared'
import type { createStore } from 'jotai/vanilla'
import { agentMessageRefreshAtom, type AgentStreamState } from '@/atoms/agent-atoms'
import { inspectSessionTargetAtomFamily, sessionTargetStateAtomFamily } from '@/atoms/session-target-atoms'

/**
 * ReadyForReview 会在工具返回前同步写入验收消息，但该消息不属于 SDK 实时流。
 * 工具成功完成时立即刷新持久化历史与 Session Target 权威快照，避免
 * 消息区出现验收正文而输入区及顶栏仍停留在 working、无法预览。
 */
export function shouldRefreshMessagesAfterToolResult(
  event: AgentEvent,
  streamState: AgentStreamState | undefined,
): boolean {
  if (event.type !== 'tool_result' || event.isError) return false
  const toolName = event.toolName
    ?? streamState?.toolActivities.find((activity) => activity.toolUseId === event.toolUseId)?.toolName
  return toolName === 'ReadyForReview'
}

export async function refreshWorktreeReviewAfterToolResult(
  store: ReturnType<typeof createStore>,
  sessionId: string,
  event: AgentEvent,
  streamState: AgentStreamState | undefined,
): Promise<boolean> {
  if (!shouldRefreshMessagesAfterToolResult(event, streamState)) return false
  store.set(agentMessageRefreshAtom, (prev) => {
    const map = new Map(prev)
    map.set(sessionId, (prev.get(sessionId) ?? 0) + 1)
    return map
  })
  await store.set(inspectSessionTargetAtomFamily(sessionId), { silent: true })
  return true
}

/** 终止型工具不保证工具结果一定进入实时流，完成时再以 Main 快照收敛工作中目标。 */
export async function refreshWorkingWorktreeAfterStreamComplete(store: ReturnType<typeof createStore>, sessionId: string): Promise<void> {
  const snapshot = store.get(sessionTargetStateAtomFamily(sessionId)).snapshot
  if (snapshot?.checkout.kind !== 'isolated' || snapshot.ownership !== 'owner' || snapshot.delivery?.state !== 'working') return
  await store.set(inspectSessionTargetAtomFamily(sessionId), { silent: true })
}

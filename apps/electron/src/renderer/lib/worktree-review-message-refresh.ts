import type { AgentEvent } from '@domi/shared'
import type { AgentStreamState } from '@/atoms/agent-atoms'

/**
 * ReadyForReview 会在工具返回前同步写入验收消息，但该消息不属于 SDK 实时流。
 * 工具成功完成时立即刷新持久化历史，避免自动续跑链路只依赖 STREAM_COMPLETE
 * 而因完成事件时序导致新验收卡长期不可见。
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

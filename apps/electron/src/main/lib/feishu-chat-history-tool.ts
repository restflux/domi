import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { FeishuChatMessage } from '@domi/shared'

type FeishuPiSdk = typeof import('@earendil-works/pi-coding-agent')

export interface FeishuChatHistoryToolDependencies {
  fetchHistory(options?: { pageSize?: number; beforeTimestamp?: number }): Promise<FeishuChatMessage[]>
  formatHistory(messages: FeishuChatMessage[]): string
}

/** 将飞书群聊历史业务函数桥接为 Pi custom tool。 */
export function buildFeishuChatHistoryTool(
  sdk: FeishuPiSdk,
  dependencies: FeishuChatHistoryToolDependencies,
): ToolDefinition {
  return sdk.defineTool({
    name: 'mcp__feishu_chat__fetch_group_chat_history',
    label: '获取飞书群聊历史',
    description: '获取飞书群聊的历史消息。当你需要了解更多群聊上下文来完成任务时使用；返回发送者、时间和内容。',
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, description: '要获取的消息数量（默认20，最多50）' })),
      before_timestamp: Type.Optional(Type.Number({ description: '获取此毫秒时间戳之前的消息，用于向前翻页' })),
    }),
    execute: async (_toolCallId, params) => {
      const args = params as { limit?: number; before_timestamp?: number }
      const messages = await dependencies.fetchHistory({
        pageSize: args.limit,
        beforeTimestamp: args.before_timestamp,
      })
      const text = messages.length === 0
        ? '没有更多历史消息。'
        : `${dependencies.formatHistory(messages)}\n\n（如需更早的消息，使用 before_timestamp: ${messages[0]?.createTime ?? 0}）`
      return { content: [{ type: 'text' as const, text }], details: { count: messages.length } }
    },
  })
}

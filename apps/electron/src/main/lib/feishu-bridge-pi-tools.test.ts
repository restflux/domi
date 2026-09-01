import { describe, expect, test } from 'bun:test'
import type { FeishuChatMessage } from '@domi/shared'
import { buildFeishuChatHistoryTool } from './feishu-chat-history-tool'

describe('飞书群聊 Pi custom tool', () => {
  test('Given history dependencies When tool executes Then pagination maps to the business function and returns Pi details', async () => {
    const calls: Array<{ pageSize?: number; beforeTimestamp?: number }> = []
    const messages: FeishuChatMessage[] = [{
      messageId: 'message-1',
      senderId: 'user-1',
      senderType: 'user',
      senderName: 'Alice',
      msgType: 'text',
      content: '请继续处理',
      createTime: 123_456,
    }]
    const sdk = {
      defineTool: (definition: unknown) => definition,
    } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const tool = buildFeishuChatHistoryTool(sdk, {
      fetchHistory: async (options) => {
        calls.push(options ?? {})
        return messages
      },
      formatHistory: () => '[10:00] Alice: 请继续处理',
    })

    const result = await tool.execute(
      'tool-call-1',
      { limit: 7, before_timestamp: 999_000 },
      undefined,
      undefined,
      {} as never,
    )

    expect(tool.name).toBe('mcp__feishu_chat__fetch_group_chat_history')
    expect(calls).toEqual([{ pageSize: 7, beforeTimestamp: 999_000 }])
    expect(result.details).toEqual({ count: 1 })
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('before_timestamp: 123456'),
    })
  })

  test('Given no more messages When tool executes Then it returns an explicit empty-history result', async () => {
    const sdk = { defineTool: (definition: unknown) => definition } as unknown as typeof import('@earendil-works/pi-coding-agent')
    const tool = buildFeishuChatHistoryTool(sdk, {
      fetchHistory: async () => [],
      formatHistory: () => '',
    })

    const result = await tool.execute('tool-call-2', {}, undefined, undefined, {} as never)

    expect(result.content).toEqual([{ type: 'text', text: '没有更多历史消息。' }])
    expect(result.details).toEqual({ count: 0 })
  })
})

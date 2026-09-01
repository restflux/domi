import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@domi/shared'
import { buildToolPresentationIndex } from './tool-presentation-index'

function toolResult(toolUseId: string, content: unknown, isError = false): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
        is_error: isError,
      }],
    },
  } as unknown as SDKMessage
}

describe('工具展示索引', () => {
  test('一次索引同时保留文本、错误状态与图片', () => {
    const index = buildToolPresentationIndex([
      toolResult('tool-1', [
        { type: 'text', text: '读取失败' },
        { type: 'image', data: 'base64-data', mimeType: 'image/png' },
      ], true),
    ])

    expect(index.get('tool-1')).toEqual({
      completed: true,
      result: '读取失败',
      isError: true,
      images: [{ data: 'base64-data', mimeType: 'image/png' }],
    })
  })

  test('任务通知与稍后到达的工具结果合并到同一项', () => {
    const notification = {
      type: 'system',
      subtype: 'task_notification',
      tool_use_id: 'agent-1',
      usage: {
        duration_ms: 1200,
        total_tokens: 240,
        tool_uses: 3,
      },
    } as unknown as SDKMessage

    const index = buildToolPresentationIndex([
      notification,
      toolResult('agent-1', '子任务完成'),
    ])

    expect(index.get('agent-1')).toEqual({
      completed: true,
      result: '子任务完成',
      isError: false,
      images: [],
      subAgentMeta: {
        durationMs: 1200,
        totalTokens: 240,
        toolUses: 3,
      },
    })
  })

  test('重复结果保持旧实现的首条结果语义', () => {
    const index = buildToolPresentationIndex([
      toolResult('tool-1', '第一条'),
      toolResult('tool-1', '第二条'),
    ])

    expect(index.get('tool-1')?.result).toBe('第一条')
  })
})

import { describe, expect, test } from 'bun:test'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import { serializePiAssistantDelta } from './pi-assistant-delta'

function partial(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'deepseek',
    model: 'deepseek-v4-pro',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

describe('Pi assistant delta serialization', () => {
  test('preserves interleaved text and thinking block indexes without copying the cumulative partial', () => {
    const cumulative = partial([
      { type: 'thinking', thinking: '已有思考' },
      { type: 'text', text: '已有正文' },
    ])

    expect(serializePiAssistantDelta({
      type: 'thinking_delta',
      contentIndex: 0,
      delta: '新增思考',
      partial: cumulative,
    })).toEqual({ type: 'thinking_delta', contentIndex: 0, delta: '新增思考' })

    expect(serializePiAssistantDelta({
      type: 'text_delta',
      contentIndex: 1,
      delta: '新增正文',
      partial: cumulative,
    })).toEqual({ type: 'text_delta', contentIndex: 1, delta: '新增正文' })
  })

  test('serializes tool-call identity and final arguments from the addressed content block', () => {
    const cumulative = partial([{
      type: 'toolCall',
      id: 'tool-1',
      name: 'edit',
      arguments: {
        path: 'a.ts',
        edits: [
          { oldText: 'a', newText: 'b' },
          { oldText: 'c', newText: 'd' },
        ],
      },
    }])

    expect(serializePiAssistantDelta({
      type: 'toolcall_start',
      contentIndex: 0,
      partial: cumulative,
    })).toEqual({
      type: 'toolcall_start',
      contentIndex: 0,
      toolCall: { id: 'tool-1', name: 'MultiEdit', arguments: {} },
    })

    expect(serializePiAssistantDelta({
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: '{"path":',
      partial: cumulative,
    })).toEqual({
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: '{"path":',
      toolCall: { id: 'tool-1', name: 'MultiEdit' },
    })

    const toolCall = cumulative.content[0]
    if (!toolCall || toolCall.type !== 'toolCall') throw new Error('expected tool call fixture')
    expect(serializePiAssistantDelta({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall,
      partial: cumulative,
    } as AssistantMessageEvent)).toEqual({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: {
        id: 'tool-1',
        name: 'MultiEdit',
        arguments: toolCall.arguments,
      },
    })
  })
})

import { describe, expect, test } from 'bun:test'
import { AnthropicAdapter } from './anthropic-adapter.ts'
import { OpenAIAdapter } from './openai-adapter.ts'
import { OpenAIResponsesAdapter } from './openai-responses-adapter.ts'
import { GoogleAdapter } from './google-adapter.ts'

describe('Provider 适配器 usage 解析（token 用量采集）', () => {
  test('Given OpenAI 流末尾 usage chunk When parseSSELine Then 产出 usage 事件（含缓存命中）', () => {
    const adapter = new OpenAIAdapter()
    const events = adapter.parseSSELine(JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: 1_200,
        completion_tokens: 300,
        total_tokens: 1_500,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    }))

    expect(events).toEqual([{
      type: 'usage',
      inputTokens: 1_200,
      outputTokens: 300,
      cacheReadTokens: 800,
    }])
  })

  test('Given Anthropic message_delta.usage When parseSSELine Then 产出 usage 事件（含缓存读写）', () => {
    const adapter = new AnthropicAdapter()
    const events = adapter.parseSSELine(JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: {
        input_tokens: 2_000,
        output_tokens: 400,
        cache_read_input_tokens: 600,
        cache_creation_input_tokens: 100,
      },
    }))

    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 2_700,
      outputTokens: 400,
      cacheReadTokens: 600,
      cacheCreationTokens: 100,
    })
    expect(events).toContainEqual({ type: 'done', stopReason: 'end_turn' })
  })

  test('Given Google 流末尾 usageMetadata When parseSSELine Then 产出 usage 事件（含缓存命中）', () => {
    const adapter = new GoogleAdapter()
    const events = adapter.parseSSELine(JSON.stringify({
      usageMetadata: {
        promptTokenCount: 3_000,
        candidatesTokenCount: 500,
        cachedContentTokenCount: 900,
      },
    }))

    expect(events).toEqual([{
      type: 'usage',
      inputTokens: 3_000,
      outputTokens: 500,
      cacheReadTokens: 900,
    }])
  })

  test('Given OpenAI Responses response.completed.usage When parseSSELine Then 产出 usage 事件', () => {
    const adapter = new OpenAIResponsesAdapter()
    const events = adapter.parseSSELine(JSON.stringify({
      type: 'response.completed',
      response: {
        status: 'completed',
        usage: {
          input_tokens: 1_500,
          output_tokens: 250,
          total_tokens: 1_750,
          input_tokens_details: { cached_tokens: 700 },
        },
      },
    }))

    expect(events).toContainEqual({
      type: 'usage',
      inputTokens: 1_500,
      outputTokens: 250,
      cacheReadTokens: 700,
    })
  })

  test('Given 无 usage 的普通流块 When parseSSELine Then 不产出 usage 事件', () => {
    const adapter = new OpenAIAdapter()
    const events = adapter.parseSSELine(JSON.stringify({
      choices: [{ delta: { content: '你好' } }],
    }))
    expect(events.some((e) => e.type === 'usage')).toBe(false)
  })

  test('Given Google 带内容与 usageMetadata 的块 When parseSSELine Then 以内容为主不产出重复 usage', () => {
    const adapter = new GoogleAdapter()
    const events = adapter.parseSSELine(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
    }))
    expect(events.map((e) => e.type)).toEqual(['chunk'])
  })
})

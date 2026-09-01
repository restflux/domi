import { describe, expect, test } from 'bun:test'
import { createFetchedOpenAIChannelModel, parseOpenAIModelCapabilities } from './channel-model-capabilities'

describe('供应商模型元数据解析', () => {
  test('Given OpenAI-compatible model item includes capabilities When parsing Then preserves supported authoritative fields', () => {
    expect(parseOpenAIModelCapabilities({
      id: 'new-model',
      context_window: 1_000_000,
      max_output_tokens: 131_072,
      input_modalities: ['text', 'image', 'video'],
      reasoning: {
        supported: true,
        efforts: ['low', 'high', 'max', 'turbo'],
        default_effort: 'low',
      },
    })).toEqual({
      input: ['text', 'image'],
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      reasoning: true,
      reasoningLevels: ['low', 'high', 'max'],
      defaultReasoningLevel: 'low',
      thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
    })
  })

  test('Given model item only has identity When creating channel model Then does not invent capabilities', () => {
    expect(createFetchedOpenAIChannelModel({ id: 'identity-only' })).toEqual({
      id: 'identity-only',
      name: 'identity-only',
      enabled: true,
      source: 'fetched',
    })
  })

  test('Given invalid limits and unknown modalities When parsing Then ignores them', () => {
    expect(parseOpenAIModelCapabilities({
      id: 'invalid-fields',
      contextWindow: -1,
      maxTokens: 1.5,
      input: ['video'],
    })).toBeUndefined()
  })

  test('Given malformed third-party capability shapes When parsing Then fails closed instead of throwing', () => {
    expect(parseOpenAIModelCapabilities({
      id: 'malformed-fields',
      input_modalities: 'image' as unknown as string[],
      reasoning_efforts: { effort: 'high' } as unknown as string[],
      default_reasoning_effort: 42 as unknown as string,
    })).toBeUndefined()

    expect(parseOpenAIModelCapabilities({
      id: 'partially-malformed-fields',
      input_modalities: [null, 42, 'image'] as unknown as string[],
      reasoning_efforts: [{ effort: 'high' }, 'max'] as unknown as string[],
    })).toEqual({
      input: ['image'],
      reasoningLevels: ['max'],
      thinkingLevelMap: { max: 'max' },
    })
  })
})

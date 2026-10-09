import { describe, expect, test } from 'bun:test'
import magpieFixtures from './fixtures/magpie-model-capabilities.json'
import { resolveReasoningCapability } from '@domi/shared'
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


describe('magpie 实际模型档位声明', () => {
  // 2026-10-09 只读采样：/models 的能力字段与用户 Pi 模型定义，不含端点或凭据。
  for (const fixture of magpieFixtures) {
    test(`Given ${fixture.model.id} 的实际声明 When 解析 Then 档位与 Pi 定义一致`, () => {
      const parsed = parseOpenAIModelCapabilities(fixture.model)
      const capability = resolveReasoningCapability({ catalog: parsed })
      expect(capability?.levels ?? ['off']).toEqual(fixture.expectedLevels)
    })
  }

  test('Given none 和未知 ultra When 解析 Then none 映射为 Off 并忽略未知档位', () => {
    expect(parseOpenAIModelCapabilities({
      id: 'router/model', reasoning: true,
      supported_reasoning_levels: [{ effort: 'none' }, { effort: 'high' }, { effort: 'ultra' }],
    })).toMatchObject({ reasoningLevels: ['off', 'high'], thinkingLevelMap: { off: 'none', high: 'high' } })
  })

  test('Given 缺失、畸形与明确空集合 When 解析 Then 区分未知能力与禁止可选推理', () => {
    expect(parseOpenAIModelCapabilities({ id: 'missing', reasoning: true })).toEqual({ reasoning: true })
    expect(parseOpenAIModelCapabilities({ id: 'invalid', supported_reasoning_levels: {} as unknown as [] })).toBeUndefined()
    expect(parseOpenAIModelCapabilities({ id: 'empty', reasoning: true, supported_reasoning_levels: [] }))
      .toMatchObject({ reasoning: false, reasoningLevels: [] })
  })
})


test('Given 结构化档位包含坏条目、大小写与重复 When 解析 Then 只保留有效档位与真实映射', () => {
  expect(parseOpenAIModelCapabilities({
    id: 'router/mixed', supported_reasoning_levels: [
      null, 42, { effort: [] }, { effort: 'HIGH' }, { effort: 'high' }, 'none', { effort: 'ultra' },
    ] as unknown as NonNullable<Parameters<typeof parseOpenAIModelCapabilities>[0]['supported_reasoning_levels']>,
    default_reasoning_effort: 'none',
  })).toMatchObject({ reasoningLevels: ['high', 'off'], defaultReasoningLevel: 'off', thinkingLevelMap: { off: 'none', high: 'high', max: null } })
})

import { describe, expect, test } from 'bun:test'
import { resolveReasoningProfile } from '@domi/shared'
import { injectDeepSeekReasoningLevel } from './pi-deepseek-reasoning-request-settings'

const DEEPSEEK_ANTHROPIC = {
  provider: 'deepseek',
  transport: 'anthropic-messages',
} as const

describe('Pi DeepSeek V4 reasoning request settings', () => {
  test('Given DeepSeek V4 profiles When resolving Anthropic transport Then exposes Off/Low/High/Max UI levels', () => {
    expect(resolveReasoningProfile({
      modelId: 'deepseek-v4-flash',
      transport: 'anthropic-messages',
    })).toMatchObject({
      id: 'deepseek-v4-flash',
      levels: ['off', 'low', 'high', 'max'],
      defaultLevel: 'high',
    })
    expect(resolveReasoningProfile({
      modelId: 'deepseek-v4-pro',
      transport: 'anthropic-messages',
    })).toMatchObject({
      id: 'deepseek-v4-pro',
      levels: ['off', 'low', 'high', 'max'],
      defaultLevel: 'high',
    })
  })

  test('Given legacy Pi budget thinking When Low is selected Then emits DeepSeek low effort', () => {
    expect(injectDeepSeekReasoningLevel({
      model: 'deepseek-v4-flash',
      messages: [],
      thinking: { type: 'enabled', budget_tokens: 8192, display: 'summarized' },
      output_config: { effort: 'high' },
    }, {
      ...DEEPSEEK_ANTHROPIC,
      thinkingLevel: 'low',
    })).toEqual({
      model: 'deepseek-v4-flash',
      messages: [],
      thinking: { type: 'enabled' },
      output_config: { effort: 'low' },
    })
  })

  test('Given legacy Pi budget thinking When High is selected Then emits DeepSeek high effort', () => {
    expect(injectDeepSeekReasoningLevel({
      model: 'deepseek-v4-flash',
      messages: [],
      thinking: { type: 'enabled', budget_tokens: 16384, display: 'summarized' },
      output_config: { effort: 'medium' },
    }, {
      ...DEEPSEEK_ANTHROPIC,
      thinkingLevel: 'high',
    })).toEqual({
      model: 'deepseek-v4-flash',
      messages: [],
      thinking: { type: 'enabled' },
      output_config: { effort: 'high' },
    })
  })

  test('Given legacy Pi budget thinking When Max is selected Then emits DeepSeek max effort', () => {
    expect(injectDeepSeekReasoningLevel({
      model: 'deepseek-v4-pro',
      stream: true,
      thinking: { type: 'enabled', budget_tokens: 32768, display: 'summarized' },
    }, {
      ...DEEPSEEK_ANTHROPIC,
      thinkingLevel: 'max',
    })).toEqual({
      model: 'deepseek-v4-pro',
      stream: true,
      thinking: { type: 'enabled' },
      output_config: { effort: 'max' },
    })
  })

  test('Given reasoning is disabled When rewriting Then removes stale output config', () => {
    expect(injectDeepSeekReasoningLevel({
      model: 'deepseek-v4-pro',
      thinking: { type: 'enabled', budget_tokens: 16384 },
      output_config: { effort: 'max' },
      metadata: { trace: 'keep' },
    }, {
      ...DEEPSEEK_ANTHROPIC,
      thinkingLevel: 'off',
    })).toEqual({
      model: 'deepseek-v4-pro',
      thinking: { type: 'disabled' },
      metadata: { trace: 'keep' },
    })
  })

  test('Given Pi already emits the canonical target payload When rewriting Then returns the same object', () => {
    const enabledPayload = {
      model: 'deepseek-v4-pro',
      thinking: { type: 'enabled', future_mode: 'native' },
      output_config: { effort: 'max', future_option: true },
      messages: [],
    }
    const disabledPayload = {
      model: 'deepseek-v4-pro',
      thinking: { type: 'disabled', future_mode: 'native' },
      messages: [],
    }

    expect(injectDeepSeekReasoningLevel(enabledPayload, {
      ...DEEPSEEK_ANTHROPIC,
      thinkingLevel: 'max',
    })).toBe(enabledPayload)
    expect(injectDeepSeekReasoningLevel(disabledPayload, {
      ...DEEPSEEK_ANTHROPIC,
      thinkingLevel: 'off',
    })).toBe(disabledPayload)
  })

  test('Given an unrelated payload or transport When rewriting Then leaves it unchanged', () => {
    const nonV4 = { model: 'deepseek-reasoner', thinking: { type: 'enabled', budget_tokens: 4096 } }
    const qwenTransport = { model: 'deepseek-v4-pro', thinking: { type: 'enabled', budget_tokens: 4096 } }
    const otherProvider = { model: 'deepseek-v4-pro', thinking: { type: 'enabled', budget_tokens: 4096 } }
    const nonObject = 'not-a-request'
    const v4Profile = resolveReasoningProfile({
      modelId: 'deepseek-v4-pro',
      transport: 'anthropic-messages',
    })

    expect(injectDeepSeekReasoningLevel(nonV4, {
      ...DEEPSEEK_ANTHROPIC,
      profile: v4Profile,
      thinkingLevel: 'max',
    })).toBe(nonV4)
    expect(injectDeepSeekReasoningLevel(qwenTransport, {
      provider: 'qwen-token-plan-individual',
      transport: 'openai-completions',
      thinkingLevel: 'max',
    })).toBe(qwenTransport)
    expect(injectDeepSeekReasoningLevel(otherProvider, {
      provider: 'anthropic-compatible',
      transport: 'anthropic-messages',
      thinkingLevel: 'max',
    })).toBe(otherProvider)
    expect(injectDeepSeekReasoningLevel(nonObject, {
      ...DEEPSEEK_ANTHROPIC,
      thinkingLevel: 'max',
    })).toBe(nonObject)
  })

  test('Given a DeepSeek V4 model over OpenAI transport When resolving profile Then does not install the Anthropic shim', () => {
    expect(resolveReasoningProfile({
      modelId: 'deepseek-v4-pro',
      transport: 'openai-completions',
    })).toBeUndefined()
  })
})

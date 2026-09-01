import { describe, expect, setDefaultTimeout, test } from 'bun:test'
import { DEEPSEEK_PRESET_MODELS, type ChannelModel } from '@domi/shared'
import {
  buildModel,
  getCodexCatalogModels,
  resolveImageCapabilityConsensus,
  resolvePiImageInputCapability,
  resolvePiModelCatalogStatus,
  resolvePiReasoningCapability,
  resolvePiSupportsFinishReason,
} from './pi-model-registry'

setDefaultTimeout(60_000)

const sdkPromise = import('@earendil-works/pi-coding-agent')

async function buildFinishReasonModel(finishReasonMode?: 'auto' | 'required' | 'not-supported') {
  const sdk = await sdkPromise
  return buildModel(sdk, {
    sessionId: `finish-reason-${finishReasonMode ?? 'missing'}`,
    prompt: 'hi',
    apiKey: 'test-key',
    provider: 'custom',
    baseUrl: 'https://router.example.com/v1/chat/completions',
    model: 'private-router-model',
    finishReasonMode,
    permissionMode: 'plan',
    authorizeToolCall: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
    systemPrompt: 'system',
    piAgentDir: '/tmp/pi-agent',
    piSessionDir: '/tmp/pi-session',
  })
}

function getSupportsFinishReason(model: { compat?: unknown }): boolean | undefined {
  return (model.compat as { supportsFinishReason?: boolean } | undefined)?.supportsFinishReason
}

async function buildOpenAIResponsesModel(model: string) {
  const sdk = await sdkPromise
  return buildModel(sdk, {
    sessionId: `context-window-${model}`,
    prompt: 'hi',
    apiKey: 'test-key',
    provider: 'openai-responses',
    baseUrl: 'https://router.example.com/v1',
    model,
    permissionMode: 'plan',
    authorizeToolCall: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
    systemPrompt: 'system',
    piAgentDir: '/tmp/pi-agent',
    piSessionDir: '/tmp/pi-session',
  })
}

describe('Pi 模型图片输入能力', () => {
  test('Given catalog missing but temporary adaptation declares image input When resolving Then uses the fallback', async () => {
    await expect(resolvePiImageInputCapability('opencode-go-openai', 'ox-alpha-free', {
      temporaryAdaptation: { input: ['text', 'image'] },
    })).resolves.toBe('supported')
  })

  test('Given catalog text-only model When resolving image capability Then reports unsupported', async () => {
    await expect(resolvePiImageInputCapability('deepseek', 'deepseek-v4-pro')).resolves.toBe('unsupported')
    await expect(resolvePiImageInputCapability('deepseek', 'deepseek-v4-flash')).resolves.toBe('unsupported')
  })

  test('Given catalog or temporary adaptation vision model When resolving image capability Then reports supported', async () => {
    await expect(resolvePiImageInputCapability('openai-responses', 'gpt-5.6-sol')).resolves.toBe('supported')
    await expect(resolvePiImageInputCapability('openai-codex', 'gpt-5.6-sol')).resolves.toBe('supported')
    const deepseekVision = DEEPSEEK_PRESET_MODELS.find((model) => model.id === 'deepseek-v4-flash-vision-exp')
    await expect(resolvePiImageInputCapability('deepseek', 'deepseek-v4-flash-vision-exp', deepseekVision)).resolves.toBe('supported')
  })

  test('Given a compatible router uses an exact Pi catalog model ID When resolving image capability Then uses global catalog consensus', async () => {
    await expect(resolvePiImageInputCapability('custom', 'claude-sonnet-4-6')).resolves.toBe('supported')
    await expect(resolvePiImageInputCapability('custom', 'gemini-3.5-flash')).resolves.toBe('supported')
    await expect(resolvePiImageInputCapability('custom', 'deepseek-v4-pro')).resolves.toBe('unsupported')
    await expect(resolvePiImageInputCapability('qwen', 'qwen3.6-flash')).resolves.toBe('supported')
    await expect(resolvePiImageInputCapability('qwen-token-plan', 'qwen3.6-flash')).resolves.toBe('supported')
    await expect(resolvePiImageInputCapability('qwen-token-plan-individual', 'qwen3.8-max')).resolves.toBe('supported')
  })

  test('Given conflicting global catalog declarations When resolving consensus Then fails closed', () => {
    expect(resolveImageCapabilityConsensus(['supported', 'supported'])).toBe('supported')
    expect(resolveImageCapabilityConsensus(['unsupported', 'unsupported'])).toBe('unsupported')
    expect(resolveImageCapabilityConsensus(['supported', 'unsupported'])).toBe('unknown')
    expect(resolveImageCapabilityConsensus([])).toBe('unknown')
  })

  test('Given unknown, cross-provider, or missing model When resolving image capability Then fails closed as unknown', async () => {
    await expect(resolvePiImageInputCapability('custom', 'private-unknown-model')).resolves.toBe('unknown')
    await expect(resolvePiImageInputCapability('deepseek', 'gpt-5.6-sol')).resolves.toBe('unknown')
    await expect(resolvePiImageInputCapability('deepseek', undefined)).resolves.toBe('unknown')
  })

  test('Given legacy context suffix When resolving image capability Then strips it before catalog lookup', async () => {
    await expect(resolvePiImageInputCapability('deepseek', 'deepseek-v4-pro[1m]')).resolves.toBe('unsupported')
  })
})

describe('临时模型适配', () => {
  test('reports whether authoritative Pi catalog already covers a model', async () => {
    await expect(resolvePiModelCatalogStatus('opencode-go-openai', 'ox-alpha-free')).resolves.toBe('missing')
    await expect(resolvePiModelCatalogStatus('qwen-token-plan-individual', 'qwen3.8-max')).resolves.toBe('catalog')
  })

  test('Given Pi catalog missing Ox Alpha When resolving capability Then exposes configured Low/High/Max without Off', async () => {
    await expect(resolvePiReasoningCapability('opencode-go-openai', 'ox-alpha-free', {
      temporaryAdaptation: {
        reasoning: true,
        reasoningLevels: ['low', 'high', 'max'],
        defaultReasoningLevel: 'low',
        thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
      },
    })).resolves.toEqual({
      source: 'temporary-adaptation',
      levels: ['low', 'high', 'max'],
      defaultLevel: 'low',
    })
  })

  test('Given Ox Alpha temporary adaptation When building model Then registers its exact limits and effort map', async () => {
    const sdk = await sdkPromise
    const { model, contextWindowSource } = await buildModel(sdk, {
      sessionId: 'ox-alpha-free',
      prompt: 'hi',
      apiKey: 'test-key',
      provider: 'opencode-go-openai',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      model: 'ox-alpha-free',
      channelModel: {
        id: 'ox-alpha-free',
        name: 'Ox Alpha Free',
        enabled: true,
        temporaryAdaptation: {
          input: ['text', 'image'],
          contextWindow: 1_000_000,
          maxTokens: 131_072,
          reasoning: true,
          reasoningLevels: ['low', 'high', 'max'],
          defaultReasoningLevel: 'low',
          thinkingLevelMap: { low: 'low', high: 'high', max: 'max' },
        },
      },
      permissionMode: 'plan',
      authorizeToolCall: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(model.contextWindow).toBe(1_000_000)
    expect(contextWindowSource).toBe('temporary_adaptation')
    expect(model.maxTokens).toBe(131_072)
    expect(model.input).toEqual(['text', 'image'])
    expect(model.reasoning).toBe(true)
    expect(model.thinkingLevelMap).toEqual({ low: 'low', high: 'high', max: 'max' })
    expect(model.compat).toMatchObject({ supportsReasoningEffort: true })
  })

  test('Given provider returns model metadata When local adaptation disagrees Then provider fields win', async () => {
    const sdk = await sdkPromise
    const channelModel: ChannelModel = {
      id: 'live-new-model',
      name: 'Live New Model',
      enabled: true,
      providerMetadata: {
        input: ['text'],
        contextWindow: 300_000,
        maxTokens: 20_000,
        reasoning: false,
      },
      temporaryAdaptation: {
        input: ['text', 'image'],
        contextWindow: 100_000,
        maxTokens: 10_000,
        reasoning: true,
        reasoningLevels: ['low', 'high'],
      },
    }
    await expect(resolvePiReasoningCapability(
      'opencode-go-openai',
      channelModel.id,
      channelModel,
    )).resolves.toBeUndefined()
    const { model, contextWindowSource } = await buildModel(sdk, {
      sessionId: 'provider-metadata-wins',
      prompt: 'hi',
      apiKey: 'test-key',
      provider: 'opencode-go-openai',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      model: channelModel.id,
      channelModel,
      permissionMode: 'plan',
      authorizeToolCall: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })
    expect(model.contextWindow).toBe(300_000)
    expect(contextWindowSource).toBe('provider_metadata')
    expect(model.maxTokens).toBe(20_000)
    expect(model.input).toEqual(['text'])
    expect(model.reasoning).toBe(false)
  })

  test('Given Pi catalog has exact model When temporary adaptation disagrees Then catalog remains authoritative', async () => {
    const sdk = await sdkPromise
    const { model, contextWindowSource } = await buildModel(sdk, {
      sessionId: 'catalog-overrides-adaptation',
      prompt: 'hi',
      apiKey: 'test-key',
      provider: 'qwen-token-plan-individual',
      baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.8-max',
      channelModel: {
        id: 'qwen3.8-max',
        name: 'Qwen3.8 Max',
        enabled: true,
        temporaryAdaptation: {
          input: ['text'],
          contextWindow: 123,
          maxTokens: 456,
          reasoning: false,
        },
      },
      permissionMode: 'plan',
      authorizeToolCall: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(model.contextWindow).toBe(1_000_000)
    expect(contextWindowSource).toBe('provider_catalog')
    expect(model.input).toEqual(['text', 'image'])
    expect(model.reasoning).toBe(true)
  })
})

describe('DeepSeek V4 reasoning 能力', () => {
  test('Given DeepSeek Anthropic channel When resolving capability Then exposes Off/Low/High/Max', async () => {
    await expect(resolvePiReasoningCapability('deepseek', 'deepseek-v4-flash')).resolves.toEqual({
      source: 'profile',
      levels: ['off', 'low', 'high', 'max'],
      defaultLevel: 'high',
    })
    await expect(resolvePiReasoningCapability('deepseek', 'deepseek-v4-pro')).resolves.toEqual({
      source: 'profile',
      levels: ['off', 'low', 'high', 'max'],
      defaultLevel: 'high',
    })
    await expect(resolvePiReasoningCapability('deepseek', 'deepseek-v4-flash-vision-exp')).resolves.toEqual({
      source: 'profile',
      levels: ['off', 'low', 'high', 'max'],
      defaultLevel: 'high',
    })
  })

  test('Given Qwen OpenAI channel uses a DeepSeek model When resolving Then does not reuse the Anthropic profile', async () => {
    await expect(resolvePiReasoningCapability('qwen-token-plan-individual', 'deepseek-v4-pro')).resolves.toMatchObject({
      source: 'pi-catalog',
    })
  })
})

describe('OpenAI-compatible finish_reason 兼容模式', () => {
  test('Given auto 或旧渠道缺字段 When 映射 Pi compat Then 不覆盖 SDK 默认', async () => {
    expect(resolvePiSupportsFinishReason(undefined)).toBeUndefined()
    expect(resolvePiSupportsFinishReason('auto')).toBeUndefined()
    expect(getSupportsFinishReason((await buildFinishReasonModel()).model)).toBeUndefined()
    expect(getSupportsFinishReason((await buildFinishReasonModel('auto')).model)).toBeUndefined()
  })

  test('Given required When 映射 Pi compat Then 明确要求终态 finish_reason', async () => {
    expect(resolvePiSupportsFinishReason('required')).toBe(true)
    expect(getSupportsFinishReason((await buildFinishReasonModel('required')).model)).toBe(true)
  })

  test('Given not-supported When 映射 Pi compat Then 允许 Pi 根据流内容推断终态', async () => {
    expect(resolvePiSupportsFinishReason('not-supported')).toBe(false)
    expect(getSupportsFinishReason((await buildFinishReasonModel('not-supported')).model)).toBe(false)
  })

  test('Given 非 OpenAI Completions 协议 When 设置兼容模式 Then 不注入无关 compat', () => {
    expect(resolvePiSupportsFinishReason('not-supported', 'anthropic-messages')).toBeUndefined()
    expect(resolvePiSupportsFinishReason('required', 'openai-responses')).toBeUndefined()
  })
})

describe('Qwen Token Plan Individual 模型注册', () => {
  test('Given Individual provider When 构建模型 Then 使用 Pi 目录中的 OpenAI 协议与兼容能力', async () => {
    const sdk = await sdkPromise
    const { model, contextWindowSource } = await buildModel(sdk, {
      sessionId: 'qwen-token-plan-individual',
      prompt: 'hi',
      apiKey: 'test-key',
      provider: 'qwen-token-plan-individual',
      baseUrl: 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.8-max',
      permissionMode: 'plan',
      authorizeToolCall: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(model.api).toBe('openai-completions')
    expect(model.baseUrl).toBe('https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1')
    expect(model.contextWindow).toBe(1_000_000)
    expect(model.input).toEqual(['text', 'image'])
    expect(model.compat).toMatchObject({
      thinkingFormat: 'qwen',
      supportsDeveloperRole: false,
      supportsStore: false,
      supportsReasoningEffort: true,
    })
    expect(contextWindowSource).toBe('provider_catalog')
  })
})

describe('DeepSeek V4 Flash Vision (Exp) 模型适配', () => {
  const visionModel = DEEPSEEK_PRESET_MODELS.find((model) => model.id === 'deepseek-v4-flash-vision-exp')!

  test('Given DeepSeek vision 模型 When 获取图片输入能力 Then 报告 supported', async () => {
    await expect(resolvePiImageInputCapability('deepseek', visionModel.id, visionModel)).resolves.toBe('supported')
  })

  test('Given DeepSeek vision 模型 When 构建模型 Then 保留 1M 上下文与图片输入', async () => {
    const sdk = await sdkPromise
    const { model, contextWindowSource } = await buildModel(sdk, {
      sessionId: 'deepseek-vision',
      prompt: 'hi',
      apiKey: 'test-key',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: visionModel.id,
      channelModel: visionModel,
      permissionMode: 'plan',
      authorizeToolCall: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(model.contextWindow).toBe(1_000_000)
    expect(contextWindowSource).toBe('provider_catalog')
    expect(model.input).toEqual(['text', 'image'])
    expect(model.maxTokens).toBe(384_000)
    expect(model.reasoning).toBe(true)
  })
})

describe('Pi 模型上下文窗口目录优先级', () => {
  test('Given 第三方同名 GPT-5.6 When 构建模型 Then 使用当前 provider catalog 的 272K', async () => {
    const { model, contextWindowSource } = await buildOpenAIResponsesModel('gpt-5.6-sol')
    expect(model.contextWindow).toBe(272_000)
    expect(contextWindowSource).toBe('provider_catalog')
  })

  test('Given OpenAI Responses GPT-5.4 mini When 构建模型 Then 保留目录中的 400K', async () => {
    const { model, contextWindowSource } = await buildOpenAIResponsesModel('gpt-5.4-mini')
    expect(model.contextWindow).toBe(400_000)
    expect(contextWindowSource).toBe('provider_catalog')
  })

  test('Given 未命中目录的自定义模型 When 构建模型 Then 标记为名称 fallback', async () => {
    const { model, contextWindowSource } = await buildOpenAIResponsesModel('private-router-model')
    expect(model.contextWindow).toBe(200_000)
    expect(contextWindowSource).toBe('name_fallback')
  })

  test('Given Codex 模型目录 When 合并兼容 patch Then 不再把 GPT-5.6 抬高到旧 372K', async () => {
    const models = await getCodexCatalogModels()
    expect(models.find((model) => model.id === 'gpt-5.6-sol')?.contextWindow).toBe(272_000)
    expect(models.find((model) => model.id === 'gpt-5.4-mini')?.contextWindow).toBe(272_000)
  })

  test('Given Codex OAuth runtime When 构建 GPT-5.6 Then 最终会话模型仍使用 272K', async () => {
    const sdk = await sdkPromise
    const { model, contextWindowSource } = await buildModel(sdk, {
      sessionId: 'context-window-codex',
      prompt: 'hi',
      apiKey: '',
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      codexOAuthCredentials: {
        access: 'test-access',
        refresh: 'test-refresh',
        expires: Date.now() + 60_000,
      },
      permissionMode: 'plan',
      authorizeToolCall: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input }),
      systemPrompt: 'system',
      piAgentDir: '/tmp/pi-agent',
      piSessionDir: '/tmp/pi-session',
    })

    expect(model.contextWindow).toBe(272_000)
    expect(contextWindowSource).toBe('provider_catalog')
  })
})

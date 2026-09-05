import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from 'bun:test'
import { getModels } from '@earendil-works/pi-ai/compat'
import { catalogCredentials, PiRemoteModelCatalog, piRemoteModelCatalog } from './pi-remote-model-catalog'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEEPSEEK_PRESET_MODELS, type ChannelModel } from '@domi/shared'
import {
  buildModel,
  getCodexCatalogModels,
  refreshCodexModelCatalog,
  resolveImageCapabilityConsensus,
  resolvePiImageInputCapability,
  resolvePiModelCatalogStatus,
  resolvePiReasoningCapability,
  resolvePiSupportsFinishReason,
} from './pi-model-registry'

setDefaultTimeout(60_000)

const sdkPromise = import('@earendil-works/pi-coding-agent')
let catalogRead: ReturnType<typeof spyOn<typeof piRemoteModelCatalog, 'getModels'>>
let catalogRefresh: ReturnType<typeof spyOn<typeof piRemoteModelCatalog, 'refresh'>>
beforeEach(() => {
  catalogRead = spyOn(piRemoteModelCatalog, 'getModels').mockImplementation(async (provider) =>
    getModels(provider as Parameters<typeof getModels>[0]))
  catalogRefresh = spyOn(piRemoteModelCatalog, 'refresh').mockResolvedValue(undefined)
})
afterEach(() => {
  catalogRead.mockRestore()
  catalogRefresh.mockRestore()
})

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

async function buildOpenAICompletionsModel(baseUrl: string) {
  const sdk = await sdkPromise
  return buildModel(sdk, {
    sessionId: `openai-completions-${baseUrl}`,
    prompt: 'hi',
    apiKey: 'test-key',
    provider: 'openai',
    baseUrl,
    model: 'private-router-model',
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

function getSupportsDeveloperRole(model: { compat?: unknown }): boolean | undefined {
  return (model.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole
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

describe('OpenAI Chat Completions developer role 兼容模式', () => {
  test('Given OpenAI 官方地址 When 构建模型 Then 保留 developer role 支持', async () => {
    const { model } = await buildOpenAICompletionsModel('https://api.openai.com/v1')

    expect(getSupportsDeveloperRole(model)).toBeUndefined()
  })

  test('Given 第三方 OpenAI 中转地址 When 构建模型 Then 降级为 system role', async () => {
    const { model } = await buildOpenAICompletionsModel('http://175.178.153.250/v1')

    expect(getSupportsDeveloperRole(model)).toBe(false)
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

  test('Given Pi 远端目录出现新 Codex 模型 When 强制刷新 Then 返回新模型且限定刷新范围', async () => {
    const [baseModel] = await getCodexCatalogModels()
    expect(baseModel).toBeDefined()
    const astraModel = { ...baseModel!, id: 'gpt-6-astra', name: 'GPT-6 Astra' }
    let refreshOptions: Parameters<Parameters<typeof refreshCodexModelCatalog>[0]['refresh']>[0] | undefined
    const runtime: Parameters<typeof refreshCodexModelCatalog>[0] = {
      async refresh(options) {
        refreshOptions = options
        return { aborted: false, errors: new Map() }
      },
      getModels: () => [astraModel],
    }

    const signal = new AbortController().signal
    const models = await refreshCodexModelCatalog(runtime, signal)

    expect(models.find((model) => model.id === 'gpt-6-astra')?.name).toBe('GPT-6 Astra')
    expect(refreshOptions).toMatchObject({
      allowNetwork: true,
      force: true,
      providers: ['openai-codex'],
      signal,
    })
  })

  test('Given Pi 远端目录刷新失败 When 拉取 Codex 模型 Then 暴露原始失败原因', async () => {
    const runtime: Parameters<typeof refreshCodexModelCatalog>[0] = {
      async refresh() {
        return {
          aborted: false,
          errors: new Map([['openai-codex', new Error('catalog unavailable')]]),
        }
      },
      getModels: () => [],
    }

    await expect(refreshCodexModelCatalog(runtime, new AbortController().signal))
      .rejects.toThrow('刷新 ChatGPT (Codex) 模型目录失败: catalog unavailable')
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

describe('中转 GPT 自动能力适配', () => {
  function remoteGpt() {
    const base = getModels('openai')[0]!
    return {
      ...base, id: 'gpt-6-astra', name: 'GPT-6 Astra', api: 'openai-responses' as const,
      provider: 'openai', contextWindow: 1_048_576, maxTokens: 131_072,
      reasoning: true, input: ['text', 'image'] as ('text' | 'image')[],
      thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: null, max: 'max' },
    }
  }

  function publish() {
    const model = remoteGpt()
    catalogRead.mockImplementation(async (provider) => provider === 'openai' ? [model] : [])
    return model
  }

  async function build(provider: 'custom' | 'openai-responses', channelModel?: ChannelModel) {
    return buildModel(await sdkPromise, {
      sessionId: 'remote-gpt', prompt: 'hi', apiKey: 'test-key', provider,
      model: 'gpt-6-astra', baseUrl: 'https://router.example.com/v1', channelModel,
      permissionMode: 'plan', systemPrompt: 'system', piAgentDir: '/tmp/pi-agent', piSessionDir: '/tmp/pi-session',
      authorizeToolCall: async (_name, input) => ({ behavior: 'allow', updatedInput: input }),
    })
  }

  test.each(['custom', 'openai-responses'] as const)('Given %s 中转存在精确 GPT ID When 自动适配 Then 上下文输出与思考档位一致且不改协议地址ID', async (provider) => {
    const expected = publish()
    expect(await resolvePiModelCatalogStatus(provider, 'gpt-6-astra')).toBe('catalog')
    expect(await resolvePiReasoningCapability(provider, 'gpt-6-astra')).toMatchObject({
      source: 'pi-catalog', levels: ['low', 'medium', 'high', 'max'],
    })
    const { model, contextWindowSource } = await build(provider)
    expect(model.contextWindow).toBe(expected.contextWindow)
    expect(model.maxTokens).toBe(expected.maxTokens)
    expect(model.thinkingLevelMap).toEqual(expected.thinkingLevelMap)
    expect(model.id).toBe('gpt-6-astra')
    expect(model.baseUrl).toBe('https://router.example.com/v1')
    expect(model.api).toBe(provider === 'custom' ? 'openai-completions' : 'openai-responses')
    expect(contextWindowSource).toBe('provider_catalog')
  })

  test('Given Pi JSON 缓存含新模型 When 全新 runtime 离线加载 Then 能力查询与请求模型使用同一份参数', async () => {
    const sdk = await sdkPromise
    const agentDir = mkdtempSync(join(tmpdir(), 'domi-remote-catalog-'))
    try {
      const model = remoteGpt()
      writeFileSync(join(agentDir, 'models-store.json'), JSON.stringify({
        openai: { models: [model], checkedAt: Date.now(), lastModified: Date.now() + 86_400_000 },
      }))
      const cachedCatalog = new PiRemoteModelCatalog(() => sdk.ModelRuntime.create({
        credentials: catalogCredentials,
        modelsPath: join(agentDir, 'models.json'), modelsStorePath: join(agentDir, 'models-store.json'),
        allowModelNetwork: false, refreshOnCreate: false,
      }), async () => 'fixture')
      catalogRead.mockImplementation((provider) => cachedCatalog.getModels(provider))
      const restored = await cachedCatalog.getModels('openai')
      expect(restored.find((item) => item.id === model.id)?.contextWindow).toBe(1_048_576)
      const built = await build('openai-responses')
      expect(built.model.thinkingLevelMap).toEqual(model.thinkingLevelMap)
      expect(built.model.maxTokens).toBe(model.maxTokens)
      expect(await resolvePiReasoningCapability('openai-responses', model.id)).toMatchObject({
        levels: ['low', 'medium', 'high', 'max'],
      })
    } finally {
      rmSync(agentDir, { recursive: true, force: true })
    }
  })

  test('Given 中转提供限制 When 与远端目录及临时适配冲突 Then 中转元数据优先', async () => {
    publish()
    const configured: ChannelModel = {
      id: 'gpt-6-astra', name: 'GPT-6', enabled: true,
      providerMetadata: { contextWindow: 64_000, maxTokens: 8_000, reasoningLevels: ['low', 'high'], input: ['text'] },
      temporaryAdaptation: { contextWindow: 32_000, maxTokens: 4_000, reasoningLevels: ['max'] },
    }
    expect(await resolvePiReasoningCapability('custom', configured.id, configured)).toMatchObject({
      levels: ['low', 'high'], source: 'provider-metadata',
    })
    expect(await resolvePiImageInputCapability('custom', configured.id, configured)).toBe('unsupported')
    const { model } = await build('custom', configured)
    expect(model.contextWindow).toBe(64_000)
    expect(model.maxTokens).toBe(8_000)
    expect(model.thinkingLevelMap).toEqual({ low: 'low', high: 'high' })
    expect(model.input).toEqual(['text'])
  })

  test('Given 中转只声明支持推理 When 目录包含 Max Then 补全目录档位而不使用默认旧档位', async () => {
    publish()
    expect(await resolvePiReasoningCapability('custom', 'gpt-6-astra', {
      providerMetadata: { reasoning: true },
    })).toMatchObject({ levels: ['low', 'medium', 'high', 'max'] })
  })

  test('Given 仅 Codex 有同名模型或中转使用未知别名 When 查询 Then 不借用订阅限制或模糊匹配', async () => {
    const model = publish()
    expect(await resolvePiModelCatalogStatus('custom', 'gpt6')).toBe('missing')
    expect(await resolvePiModelCatalogStatus('custom', 'gpt-6-astra-fast')).toBe('missing')
    expect(await resolvePiReasoningCapability('custom', 'gpt-5.5-fast')).toBeUndefined()
    expect(await resolvePiModelCatalogStatus('anthropic-compatible', 'gpt-6-astra')).toBe('missing')
    catalogRead.mockImplementation(async (provider) => provider === 'openai-codex'
      ? [{ ...model, provider, api: 'openai-codex-responses', contextWindow: 272_000 }]
      : [])
    expect(await resolvePiModelCatalogStatus('custom', 'gpt-6-astra')).toBe('missing')
    expect(await resolvePiModelCatalogStatus('openai-codex', 'gpt-6-astra')).toBe('catalog')
  })

  test('Given 刷新失败且模型未匹配 When 用户已有临时适配 Then 继续使用原有配置', async () => {
    catalogRefresh.mockRejectedValue(new Error('offline'))
    catalogRead.mockResolvedValue([])
    const configured: ChannelModel = {
      id: 'gpt-6-astra', name: 'GPT-6', enabled: true,
      temporaryAdaptation: { contextWindow: 400_000, maxTokens: 32_000, reasoningLevels: ['high', 'max'] },
    }
    const { model } = await build('custom', configured)
    expect(model.contextWindow).toBe(400_000)
    expect(model.maxTokens).toBe(32_000)
    expect(await resolvePiReasoningCapability('custom', configured.id, configured)).toMatchObject({
      source: 'temporary-adaptation', levels: ['high', 'max'],
    })
  })
})

import { describe, expect, test } from 'bun:test'
import type { ChannelModel, ProviderType } from '@domi/shared'
import { executeVisionRelay, type VisionRelayServiceDependencies } from './vision-relay-service'

const normalizedImage = {
  filename: 'screen.png', mediaType: 'image/png' as const, data: Buffer.from('image'),
  width: 100, height: 50, animatedFirstFrame: false,
  warnings: ['图片分辨率较低，实体识别或 OCR 可能不准确。'],
}

function dependencies(overrides: Partial<VisionRelayServiceDependencies> = {}): VisionRelayServiceDependencies {
  return {
    getSettings: () => ({ enabled: true, channelId: 'vision-channel', modelId: 'vision-model', qualityPreset: 'balanced', authorizationVersion: 'auth-v1' }),
    getChannel: () => ({
      id: 'vision-channel', name: 'Vision API', provider: 'openai', baseUrl: 'https://vision.example/v1', credentialVersion: 'credential-v1', enabled: true,
      models: [{ id: 'vision-model', enabled: true }],
    }),
    resolveImageCapability: async (_provider: ProviderType, modelId: string | undefined) => modelId === 'text-model' ? 'unsupported' : 'supported',
    normalizeImage: async () => normalizedImage,
    executeProvider: async () => '{"answer":"A login error","observations":["red banner"],"extractedText":"Failed","limitations":[],"confidence":"high"}',
    ...overrides,
  }
}

const input = {
  sessionId: 'session-1',
  sourceProvider: 'deepseek' as const,
  sourceModelId: 'text-model',
  triggeredBy: 'user' as const,
  imagePath: 'D:\\repo\\screen.png',
  question: 'What failed?',
  analysisMode: 'ui' as const,
  accessScope: { roots: [{ path: 'D:\\repo', dev: 1, ino: 1 }], files: [] },
}

describe('Vision Relay service', () => {
  test('Given 源与目标使用明确的模型适配 When 执行视觉助手 Then 按完整配置校验并调用一次 Provider', async () => {
    const sourceChannelModel: Pick<ChannelModel, 'providerMetadata' | 'temporaryAdaptation'> = {
      temporaryAdaptation: { input: ['text'] },
    }
    const targetModel: ChannelModel = {
      id: 'vision-model', name: 'Vision', enabled: true,
      temporaryAdaptation: { input: ['text', 'image'] },
    }
    let providerCalls = 0
    const result = await executeVisionRelay({ ...input, sourceChannelModel }, dependencies({
      getChannel: () => ({
        id: 'vision-channel', name: 'Vision API', provider: 'custom', baseUrl: 'https://vision.example/v1',
        credentialVersion: 'credential-v1', enabled: true, models: [targetModel],
      }),
      resolveImageCapability: async (_provider: ProviderType, _modelId: string | undefined,
        model?: Pick<ChannelModel, 'providerMetadata' | 'temporaryAdaptation'>) => {
        const inputs = model?.temporaryAdaptation?.input
        return inputs ? inputs.includes('image') ? 'supported' : 'unsupported' : 'unknown'
      },
      executeProvider: async () => {
        providerCalls += 1
        return '{"answer":"适配模型已读取图片","observations":[],"limitations":[],"confidence":"medium"}'
      },
    }))
    expect(result).toMatchObject({ ok: true, observation: { answer: '适配模型已读取图片' } })
    expect(providerCalls).toBe(1)
  })

  test('revalidates policy, target capability and returns untrusted observation', async () => {
    const result = await executeVisionRelay(input, dependencies())
    expect(result).toMatchObject({
      ok: true,
      observation: {
        kind: 'untrusted_visual_observation',
        answer: 'A login error',
        source: {
          relay: {
            provider: 'openai',
            channelName: 'Vision API',
            modelId: 'vision-model',
            qualityPreset: 'balanced',
            analysisMode: 'ui',
          },
        },
        warnings: ['图片分辨率较低，实体识别或 OCR 可能不准确。'],
        safety: { untrustedSource: true, instructionsMustNotBeFollowed: true },
      },
    })
  })

  test('Given 目标模型明确限制为文本 When 执行视觉助手 Then 在读取图片前拒绝且不调用 Provider', async () => {
    let imageReads = 0
    let providerCalls = 0
    const result = await executeVisionRelay(input, dependencies({
      getChannel: () => ({
        id: 'vision-channel', name: 'Vision API', provider: 'custom', baseUrl: 'https://vision.example/v1',
        credentialVersion: 'credential-v1', enabled: true,
        models: [{ id: 'vision-model', enabled: true, providerMetadata: { input: ['text'] }, temporaryAdaptation: { input: ['text', 'image'] } }],
      }),
      resolveImageCapability: async (_provider, modelId, model) => modelId === 'text-model'
        ? 'unsupported'
        : model?.providerMetadata?.input?.includes('image') ? 'supported' : 'unsupported',
      normalizeImage: async () => { imageReads += 1; return normalizedImage },
      executeProvider: async () => { providerCalls += 1; return '{}' },
    }))
    expect(result).toMatchObject({ ok: false, code: 'VISION_ROUTE_UNAVAILABLE' })
    expect(imageReads).toBe(0)
    expect(providerCalls).toBe(0)
  })

  test('Given 源模型明确支持图片 When 执行视觉助手 Then 不绕过纯文本资格校验', async () => {
    let providerCalls = 0
    const result = await executeVisionRelay({
      ...input, sourceChannelModel: { providerMetadata: { input: ['text', 'image'] } },
    }, dependencies({
      resolveImageCapability: async (_provider, _modelId, model) => model?.providerMetadata?.input?.includes('image')
        ? 'supported' : 'unsupported',
      executeProvider: async () => { providerCalls += 1; return '{}' },
    }))
    expect(result).toMatchObject({ ok: false, code: 'VISION_SOURCE_NOT_ELIGIBLE' })
    expect(providerCalls).toBe(0)
  })

  test('Given 图片处理期间目标能力配置被修改 When 发送前复核 Then 拒绝旧路由且不调用 Provider', async () => {
    let targetModel: ChannelModel = {
      id: 'vision-model', name: 'Vision', enabled: true, providerMetadata: { input: ['text', 'image'] },
    }
    let providerCalls = 0
    const result = await executeVisionRelay(input, dependencies({
      getChannel: () => ({
        id: 'vision-channel', name: 'Vision API', provider: 'custom', baseUrl: 'https://vision.example/v1',
        credentialVersion: 'credential-v1', enabled: true, models: [targetModel],
      }),
      normalizeImage: async () => {
        targetModel = { ...targetModel, providerMetadata: { input: ['text'] } }
        return normalizedImage
      },
      executeProvider: async () => { providerCalls += 1; return '{}' },
    }))
    expect(result).toMatchObject({ ok: false, code: 'VISION_ROUTE_UNAVAILABLE' })
    expect(providerCalls).toBe(0)
  })

  test('requires a focused question and rejects unsupported analysis modes before sending', async () => {
    let providerCalls = 0
    const deps = dependencies({ executeProvider: async () => { providerCalls += 1; return '{}' } })
    expect(await executeVisionRelay({ ...input, question: '   ' }, deps)).toMatchObject({ ok: false, code: 'VISION_INVALID_REQUEST' })
    expect(await executeVisionRelay({ ...input, analysisMode: 'browse' as never }, deps)).toMatchObject({ ok: false, code: 'VISION_INVALID_REQUEST' })
    expect(providerCalls).toBe(0)
  })

  test('passes normalized question, mode and current quality to exactly one provider request', async () => {
    const calls: unknown[] = []
    const result = await executeVisionRelay({ ...input, question: `  ${'x'.repeat(1_010)}  ` }, dependencies({
      executeProvider: async (request) => {
        calls.push(request)
        return '{"answer":"ok","observations":[],"limitations":[],"confidence":"medium"}'
      },
    }))
    expect(result.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ question: 'x'.repeat(1_000), analysisMode: 'ui', qualityPreset: 'balanced' })
  })

  test('unknown source or target capability fails closed', async () => {
    const unknownSource = await executeVisionRelay(input, dependencies({
      resolveImageCapability: async (_provider, modelId) => modelId === 'text-model' ? 'unknown' : 'supported',
    }))
    expect(unknownSource).toMatchObject({ ok: false, code: 'VISION_SOURCE_NOT_ELIGIBLE' })

    const unknownTarget = await executeVisionRelay(input, dependencies({
      resolveImageCapability: async (_provider, modelId) => modelId === 'text-model' ? 'unsupported' : 'unknown',
    }))
    expect(unknownTarget).toMatchObject({ ok: false, code: 'VISION_ROUTE_UNAVAILABLE' })
  })

  test('automation, delegation and disabled routes do not send provider requests', async () => {
    let providerCalls = 0
    const deps = dependencies({ executeProvider: async () => { providerCalls += 1; return '{}' } })
    expect(await executeVisionRelay({ ...input, triggeredBy: 'automation' }, deps)).toMatchObject({ ok: false, code: 'VISION_CONTEXT_NOT_ALLOWED' })
    expect(await executeVisionRelay({ ...input, triggeredBy: 'delegation' }, deps)).toMatchObject({ ok: false, code: 'VISION_CONTEXT_NOT_ALLOWED' })
    expect(await executeVisionRelay({ ...input, triggeredBy: undefined }, deps)).toMatchObject({ ok: false, code: 'VISION_CONTEXT_NOT_ALLOWED' })
    expect(await executeVisionRelay(input, dependencies({ getSettings: () => ({ enabled: false, qualityPreset: 'balanced' }) }))).toMatchObject({ ok: false, code: 'VISION_NOT_CONFIGURED' })
    expect(providerCalls).toBe(0)
  })

  test('route endpoint changes while the image is being normalized are revalidated before provider execution', async () => {
    let baseUrl = 'https://vision.example/v1'
    let providerCalls = 0
    const deps = dependencies({
      getChannel: () => ({
        id: 'vision-channel', name: 'Vision API', provider: 'openai', baseUrl, credentialVersion: 'credential-v1', enabled: true,
        models: [{ id: 'vision-model', enabled: true }],
      }),
      normalizeImage: async () => {
        baseUrl = 'https://evil.example/v1'
        return normalizedImage
      },
      executeProvider: async () => {
        providerCalls += 1
        return '{}'
      },
    })
    expect(await executeVisionRelay(input, deps)).toMatchObject({ ok: false, code: 'VISION_ROUTE_UNAVAILABLE' })
    expect(providerCalls).toBe(0)
  })
})

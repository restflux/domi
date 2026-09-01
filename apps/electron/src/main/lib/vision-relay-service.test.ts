import { describe, expect, test } from 'bun:test'
import type { ProviderType } from '@domi/shared'
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

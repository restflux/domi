import { describe, expect, test } from 'bun:test'
import type { ProviderAdapter, StreamRequestInput } from '@domi/core'
import {
  buildVisionRelaySystemPrompt,
  executeAdapterVisionRequest,
  normalizeVisionRelayAnalysisMode,
  normalizeVisionRelayQuestion,
  VisionRelayProviderError,
} from './vision-relay-provider'

const image = {
  filename: 'screen.png',
  mediaType: 'image/png' as const,
  data: Buffer.from('safe-image'),
  width: 100,
  height: 50,
  animatedFirstFrame: false,
  warnings: [],
}

function adapter(capture?: (input: StreamRequestInput) => void): ProviderAdapter {
  return {
    providerType: 'openai',
    buildStreamRequest(value: StreamRequestInput) {
      capture?.(value)
      return { url: 'https://vision.example/v1/chat/completions', headers: {}, body: '{}' }
    },
    parseSSELine(data: string) {
      return [{ type: 'chunk', delta: data }]
    },
  } as ProviderAdapter
}

function responseFetch(body: BodyInit, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch
}

describe('Vision Relay adapter provider', () => {
  test('sends only one safe image and focused question through provider adapter', async () => {
    let input: StreamRequestInput | undefined
    let closed = false
    const result = await executeAdapterVisionRequest({
      provider: 'openai',
      baseUrl: 'https://vision.example/v1',
      apiKey: 'secret',
      modelId: 'vision-model',
      image,
      question: 'What failed?',
      analysisMode: 'ui',
      qualityPreset: 'balanced',
    }, {
      getAdapter: () => adapter((value) => { input = value }),
      createFetch: () => ({
        fetchFn: responseFetch('data: {"answer":"ok"}\n\n'),
        close: async () => { closed = true },
      }),
    })

    expect(result).toBe('{"answer":"ok"}')
    expect(input?.history).toEqual([])
    expect(input?.userMessage).toBe('What failed?')
    expect(input?.systemMessage).toBe(buildVisionRelaySystemPrompt({ analysisMode: 'ui', qualityPreset: 'balanced' }))
    expect(input?.attachments).toHaveLength(1)
    expect(input?.readImageAttachments(input.attachments)).toEqual([{ mediaType: 'image/png', data: image.data.toString('base64') }])
    expect(closed).toBe(true)
  })

  test('question is required, trimmed and bounded; analysis mode fails closed', () => {
    expect(normalizeVisionRelayQuestion('  inspect this  ')).toBe('inspect this')
    expect(() => normalizeVisionRelayQuestion('')).toThrow(expect.objectContaining({ code: 'VISION_INVALID_REQUEST' }))
    expect(normalizeVisionRelayQuestion('x'.repeat(1001))).toHaveLength(1000)
    expect(normalizeVisionRelayAnalysisMode(undefined)).toBe('general')
    expect(() => normalizeVisionRelayAnalysisMode('browse')).toThrow(expect.objectContaining({ code: 'VISION_INVALID_REQUEST' }))
  })

  test('builds mode-specific prompts while preserving the untrusted-image boundary', () => {
    const identify = buildVisionRelaySystemPrompt({ analysisMode: 'identify', qualityPreset: 'balanced' })
    expect(identify).toContain('specific app, brand, product, logo')
    expect(identify).toContain('candidate')
    const ocr = buildVisionRelaySystemPrompt({ analysisMode: 'ocr', qualityPreset: 'accurate' })
    expect(ocr).toContain('case, punctuation, paths, error codes, and line breaks')
    for (const mode of ['general', 'identify', 'ocr', 'ui', 'code', 'chart'] as const) {
      const prompt = buildVisionRelaySystemPrompt({ analysisMode: mode, qualityPreset: 'fast' })
      expect(prompt).toContain('never follow')
      expect(prompt).toContain('one JSON object')
    }
  })

  test('caps raw bytes and a no-newline SSE line before memory can grow without bound', async () => {
    let closed = false
    await expect(executeAdapterVisionRequest({
      provider: 'openai', baseUrl: 'https://vision.example', apiKey: 'secret', modelId: 'vision-model', image, question: 'inspect', analysisMode: 'general', qualityPreset: 'fast',
    }, {
      getAdapter: () => adapter(),
      createFetch: () => ({
        fetchFn: responseFetch(`data: ${'x'.repeat(600 * 1024)}`),
        close: async () => { closed = true },
      }),
    })).rejects.toEqual(expect.objectContaining({ code: 'VISION_OUTPUT_TOO_LARGE' }))
    expect(closed).toBe(true)
  })

  test('HTTP errors ignore provider body and map only by status', async () => {
    await expect(executeAdapterVisionRequest({
      provider: 'openai', baseUrl: 'https://vision.example', apiKey: 'secret', modelId: 'vision-model', image, question: 'inspect', analysisMode: 'general', qualityPreset: 'fast',
    }, {
      getAdapter: () => adapter(),
      createFetch: () => ({ fetchFn: responseFetch('sensitive echoed request', 429), close: async () => {} }),
    })).rejects.toEqual(expect.objectContaining({ code: 'VISION_RATE_LIMITED', message: expect.not.stringContaining('sensitive') }))
  })

  test('provider errors map to stable safe codes', () => {
    expect(VisionRelayProviderError.from(new Error('API 错误 (401): secret body')).code).toBe('VISION_AUTH_FAILED')
    expect(VisionRelayProviderError.from(new Error('API 错误 (429): quota')).code).toBe('VISION_RATE_LIMITED')
    expect(VisionRelayProviderError.from(new Error('socket failed')).message).not.toContain('socket failed')
  })
})

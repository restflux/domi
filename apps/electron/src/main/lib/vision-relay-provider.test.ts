import { describe, expect, test } from 'bun:test'
import type { ProviderAdapter, StreamRequestInput } from '@domi/core'
import {
  buildVisionRelaySystemPrompt,
  executeAdapterVisionRequest,
  normalizeVisionRelayAnalysisMode,
  normalizeVisionRelayQuestion,
  resolveVisionProviderTimeoutMs,
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

function reasoningAdapter(events: 'reasoning' | 'chunk' = 'reasoning'): ProviderAdapter {
  return {
    providerType: 'openai',
    buildStreamRequest: () => ({ url: 'https://vision.example/v1/chat/completions', headers: {}, body: '{}' }),
    parseSSELine(data: string) {
      // 思考流事件；正文 JSON 以 chunk 形式返回
      if (events === 'reasoning' && !data.startsWith('{')) return [{ type: 'reasoning', delta: data }]
      return [{ type: 'chunk', delta: data }]
    },
  } as unknown as ProviderAdapter
}

function sseBody(lines: readonly string[]): string {
  return lines.map((line) => `data: ${line}\n\n`).join('')
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

  test('thinking 模型的长 reasoning 流不占用正文与字节上限，短正文照带返回', async () => {
    // 约 1MB 的 reasoning SSE 流，旧 512KB 原始上限会误判超限
    const reasoningLines = Array.from({ length: 6_000 }, () => 'r'.repeat(150))
    const result = await executeAdapterVisionRequest({
      provider: 'openai', baseUrl: 'https://vision.example', apiKey: 'secret', modelId: 'vision-model', image, question: 'inspect', analysisMode: 'ui', qualityPreset: 'accurate',
    }, {
      getAdapter: () => reasoningAdapter('reasoning'),
      createFetch: () => ({
        fetchFn: responseFetch(sseBody([...reasoningLines, '{"answer":"ok"}'])),
        close: async () => {},
      }),
    })
    expect(result).toBe('{"answer":"ok"}')
  })

  test('thinking 被并入正文时先剥离思考段再计上限并返回纯 JSON', async () => {
    const thinking = Array.from({ length: 40 }, () => `<think>${'t'.repeat(500)}</think>`).join('')
    const chunks = [
      '<think>', ...Array.from({ length: 30 }, () => 't'.repeat(500)), '</think>',
      '{"answer":"ok"}',
    ]
    const result = await executeAdapterVisionRequest({
      provider: 'openai', baseUrl: 'https://vision.example', apiKey: 'secret', modelId: 'vision-model', image, question: 'inspect', analysisMode: 'general', qualityPreset: 'balanced',
    }, {
      getAdapter: () => reasoningAdapter('chunk'),
      createFetch: () => ({ fetchFn: responseFetch(sseBody([thinking, ...chunks])), close: async () => {} }),
    })
    expect(result).toBe('{"answer":"ok"}')
  })

  test('纯正文超过放宽后的上限仍拒绝', async () => {
    await expect(executeAdapterVisionRequest({
      provider: 'openai', baseUrl: 'https://vision.example', apiKey: 'secret', modelId: 'vision-model', image, question: 'inspect', analysisMode: 'general', qualityPreset: 'fast',
    }, {
      getAdapter: () => reasoningAdapter('chunk'),
      createFetch: () => ({ fetchFn: responseFetch(sseBody(['x'.repeat(30_501)])), close: async () => {} }),
    })).rejects.toEqual(expect.objectContaining({ code: 'VISION_OUTPUT_TOO_LARGE' }))
  })

  test('原始响应流超过放宽后的字节上限仍拒绝', async () => {
    const lines = Array.from({ length: 40 }, () => 'y'.repeat(130_000))
    await expect(executeAdapterVisionRequest({
      provider: 'openai', baseUrl: 'https://vision.example', apiKey: 'secret', modelId: 'vision-model', image, question: 'inspect', analysisMode: 'general', qualityPreset: 'fast',
    }, {
      getAdapter: () => reasoningAdapter('chunk'),
      createFetch: () => ({ fetchFn: responseFetch(sseBody(lines)), close: async () => {} }),
    })).rejects.toEqual(expect.objectContaining({ code: 'VISION_OUTPUT_TOO_LARGE' }))
  })

  test('provider 超时按质量档区分，精确档给思考模型留足时间', () => {
    expect(resolveVisionProviderTimeoutMs('fast')).toBe(60_000)
    expect(resolveVisionProviderTimeoutMs('balanced')).toBe(120_000)
    expect(resolveVisionProviderTimeoutMs('accurate')).toBe(180_000)
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

  test('HTTP 状态码附加到安全消息，响应体不泄露', async () => {
    const error = await executeAdapterVisionRequest({
      provider: 'openai', baseUrl: 'https://vision.example', apiKey: 'secret', modelId: 'vision-model', image, question: 'inspect', analysisMode: 'general', qualityPreset: 'fast',
    }, {
      getAdapter: () => adapter(),
      createFetch: () => ({ fetchFn: responseFetch('internal upstream detail', 502), close: async () => {} }),
    }).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(VisionRelayProviderError)
    const providerError = error as VisionRelayProviderError
    expect(providerError.code).toBe('VISION_PROVIDER_ERROR')
    expect(providerError.httpStatus).toBe(502)
    expect(providerError.message).toContain('（HTTP 502）')
    expect(providerError.message).not.toContain('internal upstream detail')
  })

  test('认证失败同样附加状态码便于区分', async () => {
    const error = await executeAdapterVisionRequest({
      provider: 'openai', baseUrl: 'https://vision.example', apiKey: 'secret', modelId: 'vision-model', image, question: 'inspect', analysisMode: 'general', qualityPreset: 'fast',
    }, {
      getAdapter: () => adapter(),
      createFetch: () => ({ fetchFn: responseFetch('forbidden', 403), close: async () => {} }),
    }).catch((thrown: unknown) => thrown)
    expect((error as VisionRelayProviderError).code).toBe('VISION_AUTH_FAILED')
    expect((error as VisionRelayProviderError).message).toContain('（HTTP 403）')
  })

  test('provider errors map to stable safe codes', () => {
    expect(VisionRelayProviderError.from(new Error('API 错误 (401): secret body')).code).toBe('VISION_AUTH_FAILED')
    expect(VisionRelayProviderError.from(new Error('API 错误 (429): quota')).code).toBe('VISION_RATE_LIMITED')
    expect(VisionRelayProviderError.from(new Error('socket failed')).message).not.toContain('socket failed')
  })
})

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'

// 可变的模拟凭据：测试中可切换「已配置 / 未配置」状态
let mockedCredentials: Record<string, string> = { apiKey: 'test-key' }

mock.module('../chat-tool-config', () => ({
  getChatToolsConfig: () => ({ customTools: [], toolStates: {}, toolCredentials: {} }),
  saveChatToolsConfig: () => undefined,
  updateToolState: () => undefined,
  updateToolCredentials: () => undefined,
  getToolState: () => ({ enabled: false }),
  getToolCredentials: () => mockedCredentials,
  addCustomTool: () => undefined,
  deleteCustomTool: () => undefined,
}))

mock.module('../attachment-service', () => ({
  isImageAttachment: (mediaType: string) => mediaType.startsWith('image/'),
  getMimeType: () => 'application/octet-stream',
  readAttachmentAsBase64: () => 'aW1hZ2UtYnl0ZXM=', // "image-bytes"
  deleteAttachment: () => undefined,
  deleteConversationAttachments: () => undefined,
  saveAttachment: (input: { conversationId: string; filename: string; mediaType: string; data: string }) => ({
    attachment: {
      id: 'att-1',
      filename: input.filename,
      mediaType: input.mediaType,
      localPath: `${input.conversationId}/att-1.png`,
      size: 10,
    },
  }),
}))

let buildImagesRequest: typeof import('./gpt-image-tool').buildImagesRequest
let executeGptImageTool: typeof import('./gpt-image-tool').executeGptImageTool
import type { GptImageContext } from './gpt-image-tool'

beforeAll(async () => {
  ;({ buildImagesRequest, executeGptImageTool } = await import('./gpt-image-tool'))
})

const originalFetch = globalThis.fetch

afterAll(() => {
  globalThis.fetch = originalFetch
})

const baseContext: GptImageContext = {
  conversationId: 'conv-1',
}

describe('GPT Image 请求构造（与 Codex image_generation.imagegen 对齐）', () => {
  test('Given 无参考图 When buildImagesRequest Then 走 images/generations 且带 auto 默认参数', () => {
    const { path, body } = buildImagesRequest('a cat', [], 'gpt-image-2', {
      size: undefined,
      numberOfImages: 1,
    })

    expect(path).toBe('images/generations')
    expect(body).toEqual({
      model: 'gpt-image-2',
      prompt: 'a cat',
      size: 'auto',
      quality: 'auto',
      background: 'auto',
      n: 1,
    })
  })

  test('Given 指定 size 与多张 When buildImagesRequest Then size 与 n 透传', () => {
    const { path, body } = buildImagesRequest('a cat', [], 'gpt-image-2', {
      size: '1536x1024',
      numberOfImages: 3,
    })

    expect(path).toBe('images/generations')
    expect(body.size).toBe('1536x1024')
    expect(body.n).toBe(3)
  })

  test('Given 带参考图 When buildImagesRequest Then 走 images/edits 且 images 为 image_url 数组', () => {
    const { path, body } = buildImagesRequest(
      'make it blue',
      [{ image_url: 'data:image/png;base64,AAAA' }],
      'gpt-image-2',
      { size: 'auto', numberOfImages: 1 },
    )

    expect(path).toBe('images/edits')
    expect(body).toEqual({
      model: 'gpt-image-2',
      prompt: 'make it blue',
      images: [{ image_url: 'data:image/png;base64,AAAA' }],
      size: 'auto',
      quality: 'auto',
      background: 'auto',
      n: 1,
    })
  })
})

describe('GPT Image Chat 工具执行', () => {
  test('Given 文生图调用 When 执行 Then POST generations 且 b64_json 保存为附件', async () => {
    mockedCredentials = { apiKey: 'test-key' }
    const fetchMock = mock(async () => {
      return new Response(JSON.stringify({
        created: 1,
        data: [{ b64_json: 'cG5nLWJ5dGVz' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await executeGptImageTool(
      { id: 'call-1', name: 'imagegen', arguments: { prompt: 'a cat' } },
      baseContext,
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/images/generations')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    const sentBody = JSON.parse(init.body as string)
    expect(sentBody).toMatchObject({ model: 'gpt-image-2', prompt: 'a cat', size: 'auto' })

    expect(result.isError).toBeFalsy()
    expect(result.generatedAttachments).toHaveLength(1)
    expect(result.generatedAttachments![0]!.filename).toMatch(/^gpt-image-.+\.png$/)
    expect(result.content).toContain('1 张')
  })

  test('Given 带参考图的编辑调用 When 执行 Then POST edits 且携带 data URL 参考图', async () => {
    mockedCredentials = { apiKey: 'test-key' }
    const fetchMock = mock(async () => {
      return new Response(JSON.stringify({ data: [{ b64_json: 'cG5nLWJ5dGVz' }] }), { status: 200 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await executeGptImageTool(
      {
        id: 'call-2',
        name: 'imagegen',
        arguments: { prompt: 'make it blue', useReferenceImages: 'true' },
      },
      {
        ...baseContext,
        currentAttachments: [{
          id: 'img-1',
          filename: 'ref.png',
          mediaType: 'image/png',
          localPath: 'conv-1/ref.png',
          size: 10,
        }],
      },
    )

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/images/edits')
    const sentBody = JSON.parse(init.body as string)
    expect(sentBody.images).toEqual([{ image_url: 'data:image/png;base64,aW1hZ2UtYnl0ZXM=' }])
    expect(result.isError).toBeFalsy()
  })

  test('Given 未配置 API Key When 执行 Then 返回配置错误', async () => {
    mockedCredentials = {}

    const result = await executeGptImageTool(
      { id: 'call-3', name: 'imagegen', arguments: { prompt: 'a cat' } },
      baseContext,
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('未配置 API Key')
  })

  test('Given API 返回错误 When 执行 Then 透传错误信息', async () => {
    mockedCredentials = { apiKey: 'test-key' }
    const fetchMock = mock(async () => {
      return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const result = await executeGptImageTool(
      { id: 'call-4', name: 'imagegen', arguments: { prompt: 'a cat' } },
      baseContext,
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('429')
  })
})

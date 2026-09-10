import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'

mock.module('../channel-manager', () => ({ getChannelById: () => undefined, decryptApiKey: () => '' }))
mock.module('../settings-service', () => ({ getSettings: () => ({}), updateSettings: () => undefined }))

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
import { ImageGenerationRun } from '../image-generation/run'

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

test('Chat两种工具共享运行锁，跨工具重复调用不会再次生成', async () => {
  const { executeNanoBananaTool } = await import('./nano-banana-tool')
  const context = { ...baseContext, imageGenerationRun: new ImageGenerationRun() }
  mockedCredentials = { apiKey: 'test-key' }
  let requests = 0
  globalThis.fetch = (async () => { requests++; throw new Error('secret URL') }) as unknown as typeof fetch
  const first = await executeGptImageTool({ id: 'one', name: 'imagegen', arguments: { prompt: 'cat' } }, context)
  const second = await executeNanoBananaTool({ id: 'two', name: 'generate_image', arguments: { prompt: 'cat, changed' } }, context)
  expect(first.isError).toBe(true)
  expect(first.content).toContain('服务端可能仍在处理')
  expect(second.isError).toBe(true)
  expect(second.content).toContain('上一次生图结果尚未确认')
  expect(requests).toBe(1)
})

test('Chat下载失败后再调用只取回旧结果，交付成功后允许下一张', async () => {
  mockedCredentials = { apiKey: 'test-key' }
  const context = { ...baseContext, imageGenerationRun: new ImageGenerationRun() }
  let posts = 0
  let downloads = 0
  globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method === 'POST') { posts++; return Response.json({ data: [{ url: 'https://example.com/image?secret' }] }) }
    if (++downloads === 1) throw new Error('secret URL')
    return new Response('image')
  }) as unknown as typeof fetch
  const call = { id: 'one', name: 'imagegen', arguments: { prompt: 'cat' } }
  expect((await executeGptImageTool(call, context)).isError).toBe(true)
  const recovered = await executeGptImageTool({ ...call, id: 'two' }, context)
  expect(recovered.isError).toBeFalsy()
  expect(recovered.content).toContain('未重新生成')
  expect(recovered.generatedAttachments).toHaveLength(1)
  expect(posts).toBe(1)
  await executeGptImageTool({ ...call, id: 'three' }, context)
  expect(posts).toBe(2)
})

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
  test('发送时固定的模型不受随后全局设置变化影响', async () => {
    mockedCredentials = { apiKey: 'new-key', model: 'another-model' }
    const fetchMock = mock(async () => new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] })))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const result = await executeGptImageTool({ id: 'snapshot', name: 'imagegen', arguments: { prompt: 'cat' } }, {
      ...baseContext,
      preparedConfig: { apiKey: 'snapshot-key', model: 'gpt-image-2.5-flare', baseUrl: 'https://example.com/v1', protocol: 'openai-images', quality: 'max' },
    })
    expect(result.isError).not.toBe(true)
    expect(result.imageGeneration?.model).toBe('gpt-image-2.5-flare')
    expect(JSON.stringify(result)).not.toContain('snapshot-key')
    mockedCredentials = { apiKey: 'test-key' }
  })
  test('发送时无可用配置时不能在工具执行中悄悄启用新凭据', async () => {
    mockedCredentials = { apiKey: 'new-key' }
    const fetchMock = mock(async () => { throw new Error('不应发起网络') })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const result = await executeGptImageTool({ id: 'unavailable', name: 'imagegen', arguments: { prompt: 'cat' } }, { ...baseContext, preparedConfig: null })
    expect(result.isError).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    mockedCredentials = { apiKey: 'test-key' }
  })
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

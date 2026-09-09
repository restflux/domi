import { afterEach, describe, expect, test } from 'bun:test'
import { generateImages, clearImageGenerationHistory } from './service'
import type { ImageGenerationConfig } from './config-core'
const originalFetch = globalThis.fetch
const config: ImageGenerationConfig = { apiKey: 'secret-key', baseUrl: 'https://example.com/v1', model: 'gpt-image-2.5-flare', protocol: 'openai-images', channelId: 'channel-1', quality: 'max', size: '1024x1024', numberOfImages: 2 }
afterEach(() => { globalThis.fetch = originalFetch; clearImageGenerationHistory('session') })
describe('共享生图请求', () => {
  test('等待网络时取消，即使服务器随后返回图片也不报告完成', async () => {
    const controller = new AbortController()
    let respond!: (response: Response) => void
    globalThis.fetch = (() => new Promise<Response>((resolve) => { respond = resolve })) as unknown as typeof fetch
    const pending = generateImages(config, 'cat', 'session', [], { signal: controller.signal })
    controller.abort()
    respond(new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] })))
    await expect(pending).rejects.toThrow()
  })
  test('上游畸形 JSON 反射凭据时不把响应正文写进错误', async () => {
    globalThis.fetch = (async () => new Response('secret-key is not JSON')) as unknown as typeof fetch
    await expect(generateImages(config, 'cat', 'session', [])).rejects.toThrow('无效 JSON')
  })

  test('Given 强类型用户选择 When 模型指定不同参数 Then 发送用户参数并返回不含密钥的实际元数据', async () => {
    let body: Record<string, unknown> = {}
    globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ data: [{ b64_json: 'image' }] })
    }) as unknown as typeof fetch
    const result = await generateImages(config, '图片', 'session', [], { size: '1536x1024', numberOfImages: 4 })
    expect(body).toMatchObject({ model: config.model, quality: 'max', size: '1024x1024', n: 2 })
    expect(result.metadata).toEqual({ model: config.model, protocol: config.protocol, channelId: 'channel-1', size: '1024x1024', quality: 'max', numberOfImages: 2 })
    expect(JSON.stringify(result)).not.toContain(config.apiKey)
  })
  test('Given 请求取消 When 调用 Then 不发起网络请求', async () => {
    let calls = 0
    globalThis.fetch = (async () => { calls++; throw new Error('should not call') }) as unknown as typeof fetch
    const controller = new AbortController(); controller.abort()
    await expect(generateImages(config, '图片', 'session', [], { signal: controller.signal })).rejects.toThrow()
    expect(calls).toBe(0)
  })
  test('Given API 返回无图或回显密钥错误 When 调用 Then 报错且不泄露密钥', async () => {
    globalThis.fetch = (async () => Response.json({ data: [] })) as unknown as typeof fetch
    await expect(generateImages(config, '图片', 'session', [])).rejects.toThrow('未生成')
    globalThis.fetch = (async () => new Response(config.apiKey, { status: 400 })) as unknown as typeof fetch
    await expect(generateImages(config, '图片', 'session', [])).rejects.toThrow('生图 API 请求失败 (400)')
  })
  test('Given Gemini 签名与思考 parts When 同渠道续编辑 Then 完整回传；切换模型或渠道不串历史', async () => {
    const bodies: Array<{ contents: unknown[] }> = []
    const signedParts = [{ thought: true, text: 'private thinking' }, { inlineData: { data: 'image', mimeType: 'image/png' }, thoughtSignature: 'signed', customField: { retained: true } }]
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(url)).not.toContain('secret-key')
      expect(new Headers(init?.headers).get('x-goog-api-key')).toBe(config.apiKey)
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ candidates: [{ content: { parts: signedParts } }] })
    }) as unknown as typeof fetch
    const gemini: ImageGenerationConfig = { ...config, protocol: 'gemini', model: 'gemini-image', numberOfImages: 1, quality: undefined, size: undefined }
    const result = await generateImages(gemini, '图片', 'session', [])
    expect(result.images).toHaveLength(1)
    expect(result.text).toEqual([])
    await generateImages(gemini, '改成蓝色', 'session', [])
    expect(bodies[1]!.contents[1]).toEqual({ role: 'model', parts: signedParts })
    await generateImages({ ...gemini, model: 'other-model' }, '图片', 'session', [])
    await generateImages({ ...gemini, channelId: 'other-channel' }, '图片', 'session', [])
    expect(bodies[2]!.contents).toHaveLength(1)
    expect(bodies[3]!.contents).toHaveLength(1)
    clearImageGenerationHistory('session')
    await generateImages(gemini, '图片', 'session', [])
    expect(bodies[4]!.contents).toHaveLength(1)
  })
})

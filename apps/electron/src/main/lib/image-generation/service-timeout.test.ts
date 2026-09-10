import { afterEach, expect, spyOn, test } from 'bun:test'
import { generateImages } from './service'
import { ImageGenerationRun } from './run'
import type { ImageGenerationConfig } from './config-core'

const config: ImageGenerationConfig = { apiKey: 'secret', baseUrl: 'https://example.com/v1', model: 'image', protocol: 'openai-images' }
const originalFetch = globalThis.fetch

test('未知结果锁住本轮，改提示词或协议不能重复POST；新用户运行独立', async () => {
  const run = new ImageGenerationRun()
  let posts = 0
  globalThis.fetch = (async () => { posts++; throw new Error('https://secret.invalid/token') }) as unknown as typeof fetch
  await expect(generateImages(config, 'cat', 'session', [], { run })).rejects.toThrow('服务端可能仍在处理')
  await expect(generateImages({ ...config, protocol: 'gemini' }, 'cat again changed', 'session', [], { run })).rejects.toThrow('上一次生图结果尚未确认')
  expect(posts).toBe(1)
  globalThis.fetch = (async () => { posts++; return Response.json({ data: [{ b64_json: 'new' }] }) }) as unknown as typeof fetch
  const result = await generateImages(config, 'unrelated dog', 'session', [], { run: new ImageGenerationRun() })
  expect(result.images[0]?.data).toBe('new')
  expect(posts).toBe(2)
})

test('图片下载失败只恢复GET，成功部分不重下，恢复后元数据仍属原生成', async () => {
  const run = new ImageGenerationRun()
  const requests: string[] = []
  let fail = true
  globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push(init?.method === 'POST' ? 'POST' : String(url))
    if (init?.method === 'POST') return Response.json({ data: [{ url: 'https://example.com/1' }, { url: 'https://example.com/2?secret' }] })
    if (String(url).endsWith('?secret') && fail) throw new Error('https://example.com/2?secret')
    return new Response('image')
  }) as unknown as typeof fetch
  await expect(generateImages(config, 'cat', 'session', [], { run })).rejects.toThrow('只会取回原结果')
  fail = false
  const recovered = await generateImages({ ...config, model: 'different' }, 'changed request', 'session', [], { run })
  expect(requests).toEqual(['POST', 'https://example.com/1', 'https://example.com/2?secret', 'https://example.com/2?secret'])
  expect(recovered.images).toHaveLength(2)
  expect(recovered.metadata.model).toBe(config.model)
  expect(recovered.text.join('')).toContain('未重新生成')
  expect(JSON.stringify(recovered)).not.toContain('secret')
  run.acknowledgeResult()
  await generateImages(config, 'next', 'session', [], { run })
  expect(requests.filter(value => value === 'POST')).toHaveLength(2)
})

test('下载不受已到期的生成期限影响，用户取消仍贯穿下载', async () => {
  const generation = new AbortController()
  const download = new AbortController()
  const user = new AbortController()
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 600_000 ? generation.signal : download.signal)
  let cancel = false
  globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ data: [{ url: 'https://example.com/image' }] })
    generation.abort(new DOMException('timeout', 'TimeoutError'))
    if (cancel) user.abort()
    init?.signal?.throwIfAborted()
    return new Response('image')
  }) as unknown as typeof fetch
  try {
    expect((await generateImages(config, 'cat', 'session', [])).images).toHaveLength(1)
    timeout.mockImplementation(() => new AbortController().signal)
    cancel = true
    await expect(generateImages(config, 'cat', 'session', [], { signal: user.signal })).rejects.toThrow('下载已由用户取消')
  } finally { timeout.mockRestore() }
})

test('并发调用不多发POST，结束运行释放缓存且不可再执行', async () => {
  const run = new ImageGenerationRun()
  let release!: (response: Response) => void
  let calls = 0
  globalThis.fetch = (async () => { calls++; return new Promise<Response>(resolve => { release = resolve }) }) as unknown as typeof fetch
  const first = generateImages(config, 'cat', 'session', [], { run })
  await expect(generateImages(config, 'cat again', 'session', [], { run })).rejects.toThrow('正在执行')
  run.dispose()
  release(Response.json({ data: [{ b64_json: 'late' }] }))
  await expect(first).rejects.toThrow()
  await expect(generateImages(config, 'cat', 'session', [], { run })).rejects.toThrow('运行已结束')
  expect(calls).toBe(1)
})
afterEach(() => { globalThis.fetch = originalFetch })

test('请求发送前取消不锁住运行，发送后取消则阻止自动再次提交', async () => {
  const run = new ImageGenerationRun()
  let requests = 0
  const user = new AbortController()
  globalThis.fetch = (async () => { requests++; user.abort(); throw user.signal.reason }) as unknown as typeof fetch
  await expect(generateImages(config, 'cat', 'session', [], { run, signal: AbortSignal.abort() })).rejects.toThrow('未提交新的生图请求')
  expect(requests).toBe(0)
  await expect(generateImages(config, 'cat', 'session', [], { run, signal: user.signal })).rejects.toThrow('已由用户取消')
  await expect(generateImages(config, 'cat retry', 'session', [], { run })).rejects.toThrow('上一次生图结果尚未确认')
  expect(requests).toBe(1)
})

test('读取图片响应体超时保留原结果，恢复只GET且缓存不可序列化', async () => {
  const run = new ImageGenerationRun()
  const download = new AbortController()
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === 120_000 ? download.signal : new AbortController().signal)
  const methods: string[] = []
  let fail = true
  globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    methods.push(init?.method ?? 'GET')
    if (init?.method === 'POST') return Response.json({ data: [{ url: 'https://example.com/image?private-signature' }] })
    if (fail) return new Response(new ReadableStream({ start(controller) {
      download.abort(new DOMException('private-signature', 'TimeoutError'))
      controller.error(download.signal.reason)
    } }))
    return new Response('downloaded')
  }) as unknown as typeof fetch
  try {
    await expect(generateImages(config, 'cat', 'session', [], { run })).rejects.toThrow('图片下载超时（2分钟）')
    expect(JSON.stringify(run)).toBe('{}')
    fail = false
    timeout.mockImplementation(() => new AbortController().signal)
    expect((await generateImages(config, 'retry', 'session', [], { run })).images).toHaveLength(1)
    expect(methods).toEqual(['POST', 'GET', 'GET'])
  } finally { timeout.mockRestore(); run.dispose() }
})

test('Gemini多张生成中途失败，不因换工具而重发已经完成的生成', async () => {
  const run = new ImageGenerationRun()
  let requests = 0
  globalThis.fetch = (async () => {
    if (++requests === 2) throw new Error('connection closed')
    return Response.json({ candidates: [{ content: { parts: [{ inlineData: { data: 'image', mimeType: 'image/png' } }] } }] })
  }) as unknown as typeof fetch
  await expect(generateImages({ ...config, protocol: 'gemini', numberOfImages: 2 }, 'cat', 'partial', [], { run })).rejects.toThrow('服务端可能仍在处理')
  await expect(generateImages(config, 'try another supplier', 'partial', [], { run })).rejects.toThrow('上一次生图结果尚未确认')
  expect(requests).toBe(2)
})

test('生成超时告知服务端状态和计费未知，不回显底层错误', async () => {
  const controller = new AbortController()
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(() => controller.signal)
  globalThis.fetch = (async () => { controller.abort(new DOMException('timeout secret', 'TimeoutError')); throw controller.signal.reason }) as unknown as typeof fetch
  try {
    await expect(generateImages(config, 'cat', 'session', [])).rejects.toThrow('服务端可能仍在处理')
  } finally { timeout.mockRestore() }
})

test('生成与下载分别使用10分钟和2分钟预算，不共用剩余时限', async () => {
  const signals: AbortSignal[] = []
  const timeout = spyOn(AbortSignal, 'timeout')
  globalThis.fetch = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    signals.push(init!.signal!)
    return init?.method === 'POST' ? Response.json({ data: [{ url: 'https://example.com/result.png' }] }) : new Response('image')
  }) as unknown as typeof fetch
  try {
    await generateImages(config, 'cat', 'session', [])
    expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([600_000, 120_000])
    expect(signals[0]).not.toBe(signals[1])
  } finally { timeout.mockRestore() }
})

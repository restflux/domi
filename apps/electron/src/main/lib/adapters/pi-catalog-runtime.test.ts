import { afterEach, expect, test, spyOn } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPiCatalogRuntime, catalogCredentials } from './pi-catalog-runtime'

const directories: string[] = []
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | undefined
const model = {
  id: 'gpt-catalog-fixture', name: '目录测试模型', provider: 'openai',
  api: 'openai-responses', baseUrl: 'https://api.openai.com/v1',
  reasoning: true, input: ['text'], contextWindow: 900000, maxTokens: 90000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'domi-public-catalog-'))
  directories.push(path)
  return path
}
afterEach(async () => {
  fetchSpy?.mockRestore()
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

function respond(status = 200) {
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const target = new URL(String(url))
    expect(target.origin).toBe('https://pi.dev')
    expect(target.pathname.startsWith('/api/models/providers/')).toBe(true)
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
    expect(new Headers(init?.headers).has('x-api-key')).toBe(false)
    const provider = target.pathname.split('/').at(-1)
    return new Response(status === 200 ? JSON.stringify([{ ...model, provider }]) : null, {
      status,
      headers: { 'content-type': 'application/json', 'last-modified': 'Tue, 01 Jan 2030 00:00:00 GMT', etag: 'fixture' },
    })
  }, { preconnect: globalThis.fetch.preconnect }))
}

test('Given 原始 SDK 空凭据 When 刷新 Codex Then 静默跳过网络的回归可复现', async () => {
  respond()
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent')
  const dir = await directory()
  const runtime = await ModelRuntime.create({ credentials: catalogCredentials, modelsPath: join(dir, 'models.json'), refreshOnCreate: false })
  const result = await runtime.refresh({ allowNetwork: true, force: true, providers: ['openai-codex'] })
  expect(result.errors.size).toBe(0)
  expect(fetchSpy).not.toHaveBeenCalled()
})

for (const provider of ['openai', 'openai-codex']) {
  test(`Given ${provider} 无推理凭据 When 刷新公共目录 Then 实际请求无认证且重启恢复新模型`, async () => {
    respond()
    const dir = await directory()
    const runtime = await createPiCatalogRuntime(dir)
    const result = await runtime.refresh({ allowNetwork: true, force: true, providers: [provider] })
    expect([...result.errors]).toEqual([])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(runtime.getModels(provider).find((entry) => entry.id === model.id)?.contextWindow).toBe(900000)
    expect(await readFile(join(dir, 'models-store.json'), 'utf8')).toContain(model.id)
    fetchSpy?.mockClear()
    const restored = await createPiCatalogRuntime(dir)
    await restored.refresh({ allowNetwork: false })
    expect(restored.getModels(provider).find((entry) => entry.id === model.id)?.maxTokens).toBe(90000)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
}

test('Given 上游404或未知provider When 刷新 Then 不冒充远端成功', async () => {
  respond(404)
  const runtime = await createPiCatalogRuntime(await directory())
  for (const provider of ['openai', 'unknown-provider']) {
    const result = await runtime.refresh({ allowNetwork: true, force: true, providers: [provider] })
    expect(result.errors.has(provider)).toBe(true)
  }
})

test('Given 已落盘目录 When 网络失败 Then 保留缓存并返回失败', async () => {
  respond()
  const runtime = await createPiCatalogRuntime(await directory())
  await runtime.refresh({ allowNetwork: true, force: true, providers: ['openai'] })
  fetchSpy?.mockImplementation(Object.assign(async () => { throw new Error('模拟离线') }, { preconnect: globalThis.fetch.preconnect }))
  const result = await runtime.refresh({ allowNetwork: true, force: true, providers: ['openai'] })
  expect(result.errors.has('openai')).toBe(true)
  expect(runtime.getModels('openai').some((entry) => entry.id === model.id)).toBe(true)
})

test('Given 已有缓存后上游404 When 再次离线启动 Then 旧目录未被失效标记覆盖', async () => {
  respond()
  const dir = await directory()
  const runtime = await createPiCatalogRuntime(dir)
  await runtime.refresh({ allowNetwork: true, force: true, providers: ['openai'] })
  fetchSpy?.mockRestore()
  respond(404)
  expect((await runtime.refresh({ allowNetwork: true, force: true, providers: ['openai'] })).errors.has('openai')).toBe(true)
  const restored = await createPiCatalogRuntime(dir)
  await restored.refresh({ allowNetwork: false })
  expect(restored.getModels('openai').some((entry) => entry.id === model.id)).toBe(true)
})

test('Given 缓存ETag When 远端304 Then 确认更新且保留模型', async () => {
  respond()
  const runtime = await createPiCatalogRuntime(await directory())
  await runtime.refresh({ allowNetwork: true, force: true, providers: ['openai'] })
  fetchSpy?.mockRestore()
  respond(304)
  expect((await runtime.refresh({ allowNetwork: true, force: true, providers: ['openai'] })).errors.size).toBe(0)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(runtime.getModels('openai').some((entry) => entry.id === model.id)).toBe(true)
})

test('Given 过期订阅凭据 When Domi刷新Codex列表 Then 只请求公共目录而不刷新OAuth', async () => {
  const { listCodexModels } = await import('./pi-model-registry')
  const { installPiRequestProxyFetch } = await import('./pi-request-proxy')
  installPiRequestProxyFetch()
  respond()
  const result = await listCodexModels({
    agentDir: await directory(),
    credentials: { access: 'fixture-unused-access', refresh: 'fixture-unused-refresh', expires: 0 },
  })
  expect(result.some((entry) => entry.id === model.id)).toBe(true)
  expect(fetchSpy).toHaveBeenCalledTimes(1)
})

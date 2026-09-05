import { describe, expect, test } from 'bun:test'
import type { Api, Model, ModelsRefreshOptions } from '@earendil-works/pi-ai'
import { PiRemoteModelCatalog } from './pi-remote-model-catalog'

const futureModel: Model<Api> = {
  id: 'gpt-future', name: 'Future', provider: 'openai', api: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1', reasoning: true, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 900_000, maxTokens: 90_000,
}

function fixture() {
  let revision = '1'
  let cached: readonly Model<Api>[] = []
  let visible: readonly Model<Api>[] = []
  let failing = false
  const calls: ModelsRefreshOptions[] = []
  const catalog = new PiRemoteModelCatalog(async () => ({
    getModels: () => visible,
    async refresh(options) {
      calls.push(options)
      if (options.allowNetwork && failing) {
        return { aborted: false, errors: new Map([['openai', new Error('offline')]]) }
      }
      if (options.allowNetwork) {
        cached = [futureModel]
        revision = '2'
      }
      visible = cached
      return { aborted: false, errors: new Map() }
    },
  }), async () => revision)
  return {
    catalog, calls,
    fail() { failing = true },
    replaceCache(models: readonly Model<Api>[]) { cached = models; revision += 'x' },
  }
}

describe('Pi 远端能力目录', () => {
  test('Given 官方目录新增模型 When 刷新 Then 查询立即使用新能力且只刷新指定供应商', async () => {
    const { catalog, calls } = fixture()
    await catalog.refresh(['openai'])
    expect((await catalog.getModels('openai'))[0]?.contextWindow).toBe(900_000)
    expect(calls[0]).toMatchObject({ allowNetwork: false })
    expect(calls.find((call) => call.allowNetwork)).toMatchObject({ allowNetwork: true, force: true, providers: ['openai'] })
  })

  test('Given 缓存已有模型 When 离线恢复或缓存被其他 runtime 更新 Then 不访问网络且读取最新缓存', async () => {
    const f = fixture()
    f.replaceCache([futureModel])
    expect((await f.catalog.getModels('openai'))[0]?.maxTokens).toBe(90_000)
    f.replaceCache([{ ...futureModel, contextWindow: 1_000_000 }])
    expect((await f.catalog.getModels('openai'))[0]?.contextWindow).toBe(1_000_000)
    expect(f.calls.every((call) => call.allowNetwork === false)).toBe(true)
  })

  test('Given 目录刷新失败 When 查询能力 Then 保留旧目录并允许手动重试', async () => {
    const f = fixture()
    f.replaceCache([futureModel])
    await f.catalog.getModels('openai')
    f.fail()
    await expect(f.catalog.refresh(['openai'])).rejects.toThrow('已保留已有目录')
    expect((await f.catalog.getModels('openai'))[0]?.id).toBe(futureModel.id)
    await expect(f.catalog.refresh(['openai'])).rejects.toThrow('已保留已有目录')
  })

  test('Given 多个自动能力查询 When 同时刷新 Then 合并等待且有效期内不重复联网', async () => {
    const f = fixture()
    await Promise.all(Array.from({ length: 5 }, () => f.catalog.refresh(['openai'], undefined, false)))
    expect(f.calls.filter((call) => call.allowNetwork)).toHaveLength(1)
    await f.catalog.refresh(['openai'])
    expect(f.calls.filter((call) => call.allowNetwork)).toHaveLength(2)
  })

  test('Given 自动刷新失败 When 紧接着再次查询 Then 暂时退避而非反复阻塞', async () => {
    const f = fixture()
    f.fail()
    await expect(f.catalog.refresh(['openai'], undefined, false)).rejects.toThrow()
    await f.catalog.refresh(['openai'], undefined, false)
    expect(f.calls.filter((call) => call.allowNetwork)).toHaveLength(1)
  })
})

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UsageQueryResult } from '@domi/shared'
import { UsageStatsSummary } from './UsageStatsSummary.tsx'

function result(overrides?: Partial<UsageQueryResult>): UsageQueryResult {
  return {
    entries: [],
    summary: {
      entryCount: 2,
      totalProviderRequests: 7,
      providerRequestCoverage: 'partial',
      exactRequestEntryCount: 1,
      minimumRequestEntryCount: 0,
      unknownRequestEntryCount: 1,
      totalInputTokens: 200,
      totalUncachedInputTokens: 70,
      totalOutputTokens: 50,
      totalCacheReadTokens: 100,
      totalCacheCreationTokens: 30,
      totalTokens: 250,
      pricedEntryCount: 1,
      unpricedEntryCount: 1,
      costIsPartial: true,
      totalCostUsd: 0.01,
    },
    byDay: [],
    byChannel: [],
    byModel: [],
    stats: {
      totalTokens: 250,
      todayTokens: 120,
      cacheHitRate: 0.5,
      peakDay: { date: '2026-08-12', totalTokens: 150 },
      costUsd: 0.01,
    },
    ...overrides,
  }
}

describe('UsageStatsSummary', () => {
  test('分列展示真实请求、运行记录、输入输出缓存与部分覆盖', () => {
    const html = renderToStaticMarkup(<UsageStatsSummary result={result()} />)

    expect(html).toContain('模型请求')
    expect(html).toContain('7+')
    expect(html).toContain('1 条历史记录未采集')
    expect(html).toContain('运行记录')
    expect(html).toContain('非缓存输入')
    expect(html).toContain('缓存读取')
    expect(html).toContain('缓存写入')
    expect(html).toContain('输出 Token')
    expect(html).toContain('总 Token')
    expect(html).toContain('缓存命中率')
    expect(html).toContain('50.0%')
    expect(html).toContain('已记录费用')
    expect(html).toContain('1 条运行记录暂无费用')
  })

  test('历史请求数完全缺失且没有输入 token 时显示可信占位', () => {
    const data = result({
      stats: { totalTokens: 5, todayTokens: 5 },
      summary: {
        entryCount: 1,
        totalProviderRequests: 0,
        providerRequestCoverage: 'none',
        exactRequestEntryCount: 0,
        minimumRequestEntryCount: 0,
        unknownRequestEntryCount: 1,
        totalInputTokens: 0,
        totalUncachedInputTokens: 0,
        totalOutputTokens: 5,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalTokens: 5,
        pricedEntryCount: 0,
        unpricedEntryCount: 1,
        costIsPartial: false,
      },
    })
    const html = renderToStaticMarkup(<UsageStatsSummary result={data} />)

    expect(html).toContain('历史未采集请求数')
    expect(html).toContain('缓存命中率')
    expect(html).toContain('--')
    expect(html).not.toContain('NaN%')
    expect(html).not.toContain('Infinity%')
  })
})

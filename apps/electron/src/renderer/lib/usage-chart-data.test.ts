import { describe, expect, test } from 'bun:test'
import type { UsageDayGroup } from '@domi/shared'
import {
  aggregateUsageByWeek,
  buildCumulativeUsageWeeks,
  buildDailyUsageSeries,
  findNearestUsagePointIndex,
  findUsageWeekColumnIndex,
  startOfUsageWeek,
} from './usage-chart-data.ts'

const usage: UsageDayGroup[] = [
  {
    date: '2026-08-17', entryCount: 2, providerRequestCount: 4, providerRequestCoverage: 'complete',
    inputTokens: 100, uncachedInputTokens: 20, cacheReadTokens: 75, cacheCreationTokens: 5,
    outputTokens: 20, totalTokens: 120, costUsd: 0.1,
  },
  {
    date: '2026-08-19', entryCount: 1, providerRequestCount: 1, providerRequestCoverage: 'partial',
    inputTokens: 50, uncachedInputTokens: 10, cacheReadTokens: 40, cacheCreationTokens: 0,
    outputTokens: 10, totalTokens: 60,
  },
  {
    date: '2026-08-24', entryCount: 3, providerRequestCount: 6, providerRequestCoverage: 'complete',
    inputTokens: 200, uncachedInputTokens: 50, cacheReadTokens: 140, cacheCreationTokens: 10,
    outputTokens: 40, totalTokens: 240, costUsd: 0.2,
  },
]

describe('用量图表数据', () => {
  test('Given 日期窗口中有空档 When 构建每日序列 Then 补零并保留完整用量明细', () => {
    const points = buildDailyUsageSeries(usage, new Date(2026, 7, 17), new Date(2026, 7, 19))

    expect(points.map((point) => point.date)).toEqual(['2026-08-17', '2026-08-18', '2026-08-19'])
    expect(points[1]).toMatchObject({ entryCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    expect(points[2]).toMatchObject({ entryCount: 1, inputTokens: 50, outputTokens: 10, totalTokens: 60 })
  })

  test('Given 查询窗口从周中开始 When 按本地周一聚合 Then 首周仍包含窗口起始周的已有数据', () => {
    const weeks = aggregateUsageByWeek(usage, new Date(2026, 7, 19), new Date(2026, 7, 30))

    expect(weeks).toHaveLength(2)
    expect(weeks[0]).toMatchObject({
      date: '2026-08-17',
      endDate: '2026-08-23',
      entryCount: 3,
      providerRequestCount: 5,
      providerRequestCoverage: 'partial',
      inputTokens: 150,
      uncachedInputTokens: 30,
      cacheReadTokens: 115,
      cacheCreationTokens: 5,
      outputTokens: 30,
      totalTokens: 180,
      costUsd: 0.1,
    })
    expect(weeks[1]).toMatchObject({ date: '2026-08-24', endDate: '2026-08-30', totalTokens: 240, costUsd: 0.2 })
  })

  test('Given 同一自然周内的日期 When 查找热力图周列 Then 命中同一列且下周进入下一列', () => {
    const weeks = aggregateUsageByWeek(usage, new Date(2026, 7, 17), new Date(2026, 7, 30))

    expect(findUsageWeekColumnIndex('2026-08-17', weeks)).toBe(0)
    expect(findUsageWeekColumnIndex('2026-08-23', weeks)).toBe(0)
    expect(findUsageWeekColumnIndex('2026-08-24', weeks)).toBe(1)
  })

  test('Given 周汇总 When 构建累计周列 Then 每列包含截至该周末的累计值', () => {
    const weeks = aggregateUsageByWeek(usage, new Date(2026, 7, 17), new Date(2026, 7, 30))
    const cumulative = buildCumulativeUsageWeeks(weeks)

    expect(cumulative.map((week) => week.totalTokens)).toEqual([180, 420])
    expect(cumulative[1]).toMatchObject({
      entryCount: 6,
      providerRequestCount: 11,
      providerRequestCoverage: 'partial',
      inputTokens: 350,
      uncachedInputTokens: 80,
      cacheReadTokens: 255,
      cacheCreationTokens: 15,
      outputTokens: 70,
      costUsd: 0.3,
    })
  })

  test('Given 周日日期 When 计算本地周起点 Then 返回前一个周一', () => {
    expect(startOfUsageWeek(new Date(2026, 7, 23))).toEqual(new Date(2026, 7, 17))
  })

  test('Given 指针位于图表不同位置 When 查找最近点 Then 边界夹紧且中间按最近索引命中', () => {
    expect(findNearestUsagePointIndex(-10, 100, 5)).toBe(0)
    expect(findNearestUsagePointIndex(51, 100, 5)).toBe(2)
    expect(findNearestUsagePointIndex(99, 100, 5)).toBe(4)
    expect(findNearestUsagePointIndex(50, 100, 1)).toBe(0)
  })
})

import { describe, expect, test } from 'bun:test'
import { createUsageStatsQueryPlan } from './usage-stats-query-plan.ts'

describe('UsageStatsSettings 查询区间', () => {
  test('Given 用户切换趋势区间 When 生成查询计划 Then 只有趋势查询带时间过滤', () => {
    const plan = createUsageStatsQueryPlan('week')

    expect(plan.overview).toEqual({ limit: 20 })
    expect(plan.trend.from).toBeNumber()
    expect(plan.trend.limit).toBe(0)
  })
})

import { describe, expect, test } from 'bun:test'
import { buildContextUsageMetrics } from './context-usage-metrics'

describe('buildContextUsageMetrics', () => {
  test('Given 当前上下文与窗口阈值 When 构建用量概览 Then 返回窗口和压缩余量', () => {
    expect(buildContextUsageMetrics({
      inputTokens: 106_000,
      contextWindow: 272_000,
      compactThreshold: 217_600,
    })).toEqual({
      remainingContextTokens: 166_000,
      remainingUntilCompactionTokens: 111_600,
    })
  })

  test('Given 已经超过阈值 When 构建用量概览 Then 压缩余量归零', () => {
    expect(buildContextUsageMetrics({
      inputTokens: 220_000,
      contextWindow: 272_000,
      compactThreshold: 217_600,
    })).toEqual({
      remainingContextTokens: 52_000,
      remainingUntilCompactionTokens: 0,
    })
  })
})

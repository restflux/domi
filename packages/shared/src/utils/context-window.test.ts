import { describe, expect, test } from 'bun:test'
import {
  CODEX_GPT_54_MINI_CONTEXT_WINDOW,
  CODEX_GPT_56_CONTEXT_WINDOW,
  inferAgentSdkContextWindow,
  inferContextWindow,
  resolveSDKResultContextWindow,
} from './context-window'
import { calculatePiAutoCompactionThresholdTokens } from './pi-compaction'

describe('SDK result 上下文窗口解析', () => {
  test('Given result 保存了目录来源 When 解析 Then 保留窗口来源而不是误标为 runtime', () => {
    expect(resolveSDKResultContextWindow({
      modelUsage: { 'gpt-5.4-mini': { contextWindow: 400_000 } },
      _channelModelId: 'gpt-5.4-mini',
      _channelProvider: 'openai-responses',
      _contextWindowSource: 'provider_catalog',
    })).toEqual({ contextWindow: 400_000, source: 'provider_catalog' })
  })

  test('Given Pi result 没有 modelUsage 但持久化了目录窗口 When 解析 Then 恢复真实数值与来源', () => {
    expect(resolveSDKResultContextWindow({
      _channelModelId: 'gpt-5.4-mini',
      _channelProvider: 'openai-responses',
      _contextWindow: 400_000,
      _contextWindowSource: 'provider_catalog',
    })).toEqual({ contextWindow: 400_000, source: 'provider_catalog' })
  })

  test('Given 主模型明确上报 200K 且子模型名称 fallback 为 1M When 解析 Then 不让低可信 fallback 覆盖主模型', () => {
    expect(resolveSDKResultContextWindow({
      modelUsage: {
        'main-model': { contextWindow: 200_000 },
        'claude-sonnet-5': {},
      },
      _channelModelId: 'main-model',
      _channelProvider: 'openai-responses',
    })).toEqual({ contextWindow: 200_000, source: 'runtime' })
  })

  test('Given result 没有 modelUsage When 解析 Then 按渠道模型名保守推断', () => {
    expect(resolveSDKResultContextWindow({
      _channelModelId: 'gpt-5.6-sol',
      _channelProvider: 'openai-responses',
    })).toEqual({ contextWindow: 272_000, source: 'name_fallback' })
  })
})

describe('GPT-5.x 上下文窗口 fallback', () => {
  test('Given 当前 Codex GPT-5.6 When 按名称推断 Then 使用保守的 272K 基线', () => {
    expect(CODEX_GPT_56_CONTEXT_WINDOW).toBe(272_000)
    expect(inferContextWindow('gpt-5.6-sol')).toBe(272_000)
    expect(inferAgentSdkContextWindow('gpt-5.6-sol', 'openai-responses')).toBe(272_000)
    expect(calculatePiAutoCompactionThresholdTokens(CODEX_GPT_56_CONTEXT_WINDOW)).toBe(217_600)
  })

  test('Given Codex GPT-5.4 mini When 按名称推断 Then 不把 OpenAI API 的 400K 规格套到 Codex', () => {
    expect(CODEX_GPT_54_MINI_CONTEXT_WINDOW).toBe(272_000)
    expect(inferAgentSdkContextWindow('gpt-5.4-mini', 'openai-codex')).toBe(272_000)
  })
})

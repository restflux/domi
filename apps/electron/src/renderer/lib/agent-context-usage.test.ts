import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@domi/shared'
import {
  buildAgentContextWindowOwner,
  calculateAgentSessionCacheMetrics,
  decideIdleContextUsageMerge,
  formatAgentContextUsageSummary,
  mergeAgentContextUsageHydrationState,
  mergeStableAgentContextUsageSnapshot,
  restoreAgentContextUsageFromMessages,
} from './agent-context-usage'

const target = {
  runtime: 'pi' as const,
  channelId: 'channel-1',
  modelId: 'gpt-5.4-mini',
  provider: 'openai-responses' as const,
}

function makeResult(extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    usage: {
      input_tokens: 50_000,
      output_tokens: 2_000,
      cache_read_input_tokens: 20_000,
      cache_creation_input_tokens: 1_000,
    },
    modelUsage: {
      'gpt-5.4-mini': { contextWindow: 400_000 },
    },
    _channelModelId: 'gpt-5.4-mini',
    _channelProvider: 'openai-responses',
    _channelId: 'channel-1',
    _agentRuntime: 'pi',
    _contextWindow: 400_000,
    _contextWindowSource: 'provider_catalog',
    ...extra,
  } as SDKMessage
}

function makeAssistant(): SDKMessage {
  return {
    type: 'assistant',
    message: {
      content: [{ type: 'text', text: '完成' }],
      model: 'gpt-5.4-mini',
      usage: {
        input_tokens: 1_000,
        output_tokens: 100,
        cache_read_input_tokens: 4_000,
        cache_creation_input_tokens: 500,
      },
    },
    parent_tool_use_id: null,
    _channelModelId: 'gpt-5.4-mini',
    _channelProvider: 'openai-responses',
    _channelId: 'channel-1',
    _agentRuntime: 'pi',
    _contextWindow: 400_000,
    _contextWindowSource: 'provider_catalog',
  } as SDKMessage
}

describe('calculateAgentSessionCacheMetrics', () => {
  function cacheAssistant(
    uuid: string,
    input: number,
    cacheRead: number,
    cacheCreation = 0,
  ): SDKMessage {
    return {
      type: 'assistant',
      uuid,
      parent_tool_use_id: null,
      message: {
        content: [{ type: 'text', text: uuid }],
        usage: {
          input_tokens: input,
          output_tokens: 1,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreation,
        },
      },
    } as SDKMessage
  }

  test('Given 两次请求大小悬殊 When 计算会话命中率 Then 按 Token 加权而不是算术平均', () => {
    const metrics = calculateAgentSessionCacheMetrics([
      cacheAssistant('a-1', 1_000, 9_000),
      makeResult(),
      cacheAssistant('a-2', 99_000, 1_000),
      makeResult(),
    ])

    expect(metrics).toEqual({
      inputTokens: 110_000,
      cacheReadTokens: 10_000,
      hitRate: 10_000 / 110_000,
      measuredRequests: 2,
      totalRequests: 2,
    })
    expect(metrics?.hitRate).not.toBe(0.455)
  })

  test('Given 一个 turn 含多次工具循环 Assistant 和聚合 Result When 计算 Then 每次请求只计一次且不重复计入 Result', () => {
    const metrics = calculateAgentSessionCacheMetrics([
      cacheAssistant('tool-call', 2_000, 8_000),
      { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result' }] } } as SDKMessage,
      cacheAssistant('final-answer', 4_000, 6_000),
      makeResult({
        usage: {
          input_tokens: 6_000,
          output_tokens: 2,
          cache_read_input_tokens: 14_000,
          cache_creation_input_tokens: 0,
        },
      }),
    ])

    expect(metrics).toEqual({
      inputTokens: 20_000,
      cacheReadTokens: 14_000,
      hitRate: 0.7,
      measuredRequests: 2,
      totalRequests: 2,
    })
  })

  test('Given 兼容端点只有 Result usage When 计算 Then 每个 Result 作为该 turn 唯一兜底', () => {
    const metrics = calculateAgentSessionCacheMetrics([
      makeResult({ usage: { input_tokens: 3_000, output_tokens: 1, cache_read_input_tokens: 7_000, cache_creation_input_tokens: 0 } }),
      makeResult({ usage: { input_tokens: 8_000, output_tokens: 1, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0 } }),
    ])

    expect(metrics).toEqual({
      inputTokens: 20_000,
      cacheReadTokens: 9_000,
      hitRate: 0.45,
      measuredRequests: 2,
      totalRequests: 2,
    })
  })

  test('Given persisted 与 live 尾部重叠 When 计算 Then 不重复累计同一请求', () => {
    const assistant = cacheAssistant('same-request', 2_000, 8_000)
    const result = makeResult({ usage: { input_tokens: 2_000, output_tokens: 1, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 0 } })

    const metrics = calculateAgentSessionCacheMetrics(
      [assistant, result],
      [structuredClone(assistant), structuredClone(result)],
    )

    expect(metrics).toEqual({
      inputTokens: 10_000,
      cacheReadTokens: 8_000,
      hitRate: 0.8,
      measuredRequests: 1,
      totalRequests: 1,
    })
  })

  test('Given partial、重试残片与合成压缩 Result When 计算 Then 只累计真实 final request', () => {
    const partial = cacheAssistant('retry-request', 100_000, 100_000) as SDKMessage & { _partial?: boolean }
    partial._partial = true
    const final = cacheAssistant('retry-request', 2_000, 8_000)
    const syntheticCompaction = makeResult({
      isSyntheticCompactionResult: true,
      usage: { input_tokens: 100_000, output_tokens: 0, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 },
    })

    expect(calculateAgentSessionCacheMetrics([partial, final, syntheticCompaction])).toEqual({
      inputTokens: 10_000,
      cacheReadTokens: 8_000,
      hitRate: 0.8,
      measuredRequests: 1,
      totalRequests: 1,
    })
  })

  test('Given 旧历史缺少缓存明细但最新请求有效 When 计算 Then 跳过旧请求并返回覆盖率', () => {
    const missing = cacheAssistant('missing', 1_000, 0) as SDKMessage & {
      message: { usage: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
    }
    delete missing.message.usage.cache_read_input_tokens
    delete missing.message.usage.cache_creation_input_tokens

    expect(calculateAgentSessionCacheMetrics([
      missing,
      makeResult(),
      cacheAssistant('valid', 2_000, 8_000),
      makeResult(),
    ])).toEqual({
      inputTokens: 10_000,
      cacheReadTokens: 8_000,
      hitRate: 0.8,
      measuredRequests: 1,
      totalRequests: 2,
    })
  })

  test('Given 全部请求缺字段或数据异常 When 计算 Then 返回暂无数据及覆盖数', () => {
    const missing = cacheAssistant('missing', 1_000, 0) as SDKMessage & {
      message: { usage: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
    }
    delete missing.message.usage.cache_read_input_tokens
    delete missing.message.usage.cache_creation_input_tokens
    const invalid = cacheAssistant('invalid', 1_000, -1)

    expect(calculateAgentSessionCacheMetrics([missing, makeResult(), invalid, makeResult()])).toEqual({
      inputTokens: 0,
      cacheReadTokens: 0,
      hitRate: undefined,
      measuredRequests: 0,
      totalRequests: 2,
    })
  })

  test('Given 完整 usage 的缓存读取为零 When 计算 Then 显示合法 0% 而不是暂无数据', () => {
    expect(calculateAgentSessionCacheMetrics([
      cacheAssistant('zero-hit', 10_000, 0),
      makeResult(),
    ])).toEqual({
      inputTokens: 10_000,
      cacheReadTokens: 0,
      hitRate: 0,
      measuredRequests: 1,
      totalRequests: 1,
    })
  })
})

describe('restoreAgentContextUsageFromMessages', () => {
  test('Given 历史 turn 同时有 assistant 与聚合 result When 恢复 Then 使用 assistant 的当前上下文 token 和 result 的目录窗口', () => {
    const restored = restoreAgentContextUsageFromMessages([
      { type: 'user', message: { content: [{ type: 'text', text: '开始' }] }, parent_tool_use_id: null } as SDKMessage,
      makeAssistant(),
      makeResult(),
    ], target)

    expect(restored).toEqual({
      inputTokens: 5_500,
      outputTokens: 100,
      cacheReadTokens: 4_000,
      cacheCreationTokens: 500,
      costUsd: undefined,
      contextWindow: 400_000,
      contextWindowSource: 'provider_catalog',
      contextWindowOwner: 'pi:channel-1:gpt-5.4-mini',
      contextUsageIsEstimated: false,
      model: 'gpt-5.4-mini',
    })
  })

  test('Given assistant 持久化了请求构成 When 恢复历史用量 Then 同步恢复上下文构成', () => {
    const assistant = makeAssistant() as SDKMessage & {
      _contextBreakdown?: {
        capturedAt: number
        system: number
        skills: number
        mcp: number
        tools: number
        conversation: number
      }
    }
    assistant._contextBreakdown = {
      capturedAt: 123,
      system: 10,
      skills: 20,
      mcp: 30,
      tools: 15,
      conversation: 25,
    }

    const restored = restoreAgentContextUsageFromMessages([assistant], target)

    expect(restored?.contextBreakdown).toEqual(assistant._contextBreakdown)
  })

  test('Given Pi result 没有 modelUsage 但持久化了目录窗口 When 恢复 Then 保留 400K 真实值', () => {
    const restored = restoreAgentContextUsageFromMessages([
      makeResult({ modelUsage: undefined }),
    ], target)
    expect(restored?.contextWindow).toBe(400_000)
    expect(restored?.contextWindowSource).toBe('provider_catalog')
  })

  test('Given 当前 turn 没有 assistant usage When 恢复 Then 使用 result usage 作为兼容端点兜底', () => {
    const restored = restoreAgentContextUsageFromMessages([makeResult()], target)
    expect(restored?.inputTokens).toBe(71_000)
    expect(restored?.outputTokens).toBe(2_000)
    expect(restored?.contextWindow).toBe(400_000)
  })

  test('Given 最近一次成功压缩发生在 usage 之后 When 恢复 Then 使用压缩后的估算 token', () => {
    const restored = restoreAgentContextUsageFromMessages([
      makeAssistant(),
      makeResult({
        modelUsage: { 'gpt-5.6-sol': { contextWindow: 272_000 } },
        _channelModelId: 'gpt-5.6-sol',
        _contextWindow: 272_000,
      }),
      {
        type: 'system',
        subtype: 'compact_boundary',
        compactionEstimatedTokensAfter: 12_000,
      } as SDKMessage,
      makeResult({
        isSyntheticCompactionResult: true,
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    ], {
      ...target,
      modelId: 'gpt-5.6-sol',
    })

    expect(restored).toMatchObject({
      inputTokens: 12_000,
      contextWindow: 272_000,
      contextUsageIsEstimated: true,
      contextWindowOwner: 'pi:channel-1:gpt-5.6-sol',
    })
    expect(restored?.outputTokens).toBeUndefined()
    expect(restored?.cacheReadTokens).toBeUndefined()
  })

  test('Given 自动压缩边界先于同一 run 的最终 result When 恢复 Then 仍识别 usage 已被压缩', () => {
    const restored = restoreAgentContextUsageFromMessages([
      makeAssistant(),
      {
        type: 'system',
        subtype: 'compact_boundary',
        summary: '已压缩',
      } as SDKMessage,
      makeResult(),
    ], target)

    expect(restored).toBeUndefined()
  })

  test('Given 历史 usage 后发生自动压缩但旧记录没有压缩后预估 When 恢复 Then 不显示压缩前的失效高占用', () => {
    const restored = restoreAgentContextUsageFromMessages([
      makeAssistant(),
      makeResult(),
      {
        type: 'system',
        subtype: 'compact_boundary',
        summary: '已压缩',
      } as SDKMessage,
    ], target)

    expect(restored).toBeUndefined()
  })

  test('Given 最近一轮有 assistant usage 但尚无 result When 恢复 Then 使用最新 assistant 而不是上一轮 result', () => {
    const latestAssistant = makeAssistant() as SDKMessage & {
      message: { usage: { input_tokens: number; output_tokens: number } }
    }
    latestAssistant.message.usage.input_tokens = 8_000
    latestAssistant.message.usage.output_tokens = 300

    const restored = restoreAgentContextUsageFromMessages([
      makeAssistant(),
      makeResult(),
      { type: 'user', message: { content: [{ type: 'text', text: '新一轮' }] }, parent_tool_use_id: null } as SDKMessage,
      latestAssistant,
    ], target)

    expect(restored?.inputTokens).toBe(12_500)
    expect(restored?.outputTokens).toBe(300)
  })

  test('Given 历史 usage 属于另一个 runtime 或渠道 When 当前目标已切换 Then 不恢复旧占用', () => {
    expect(restoreAgentContextUsageFromMessages([
      makeAssistant(),
      makeResult({ _agentRuntime: 'claude' }),
    ], target)).toBeUndefined()
    expect(restoreAgentContextUsageFromMessages([
      makeAssistant(),
      makeResult({ _channelId: 'channel-2' }),
    ], target)).toBeUndefined()
  })

  test('Given 历史 usage 属于另一个模型 When 当前目标已切换 Then 不恢复旧占用', () => {
    expect(restoreAgentContextUsageFromMessages([
      makeAssistant(),
      makeResult(),
    ], {
      ...target,
      modelId: 'gpt-5.6-sol',
    })).toBeUndefined()
  })

  test('Given 历史消息没有任何 usage When 恢复 Then 保持隐藏', () => {
    expect(restoreAgentContextUsageFromMessages([
      { type: 'user', message: { content: [{ type: 'text', text: 'hello' }] }, parent_tool_use_id: null } as SDKMessage,
    ], target)).toBeUndefined()
  })
})

describe('decideIdleContextUsageMerge', () => {
  test('Given 后台运行状态没有 usage When 切回会话且历史快照可用 Then 给运行状态补水而不是保持空白', () => {
    expect(decideIdleContextUsageMerge({
      state: {
        running: true,
        contextWindowOwner: 'pi:channel-1:gpt-5.4-mini',
      },
      restoredUsage: {
        inputTokens: 20_000,
        contextWindowOwner: 'pi:channel-1:gpt-5.4-mini',
        contextUsageIsEstimated: false,
      },
      currentOwner: 'pi:channel-1:gpt-5.4-mini',
    })).toBe('hydrate_running')
  })

  test('Given 后台运行状态属于另一个 owner When 当前 target 历史快照到达 Then 不给旧运行错误补水', () => {
    expect(decideIdleContextUsageMerge({
      state: {
        running: true,
        contextWindowOwner: 'claude:channel-1:gpt-5.4-mini',
      },
      restoredUsage: {
        inputTokens: 20_000,
        contextWindowOwner: 'pi:channel-1:gpt-5.4-mini',
        contextUsageIsEstimated: false,
      },
      currentOwner: 'pi:channel-1:gpt-5.4-mini',
    })).toBe('preserve_running')
  })

  test('Given 压缩已明确使旧 usage 失效 When 滞后的历史快照仍是压缩前值 Then 不重新水合旧高占用', () => {
    expect(decideIdleContextUsageMerge({
      state: {
        running: true,
        contextUsageInvalidated: true,
        contextWindowOwner: 'pi:channel-1:gpt-5.4-mini',
      },
      restoredUsage: {
        inputTokens: 259_797,
        contextWindowOwner: 'pi:channel-1:gpt-5.4-mini',
        contextUsageIsEstimated: false,
      },
      currentOwner: 'pi:channel-1:gpt-5.4-mini',
    })).toBe('preserve_running')
  })

  test('Given 后台运行状态已有实时 usage When 历史快照到达 Then 不覆盖当前运行用量', () => {
    expect(decideIdleContextUsageMerge({
      state: {
        running: true,
        inputTokens: 30_000,
        contextUsageOrigin: 'live',
        contextWindowOwner: 'pi:channel-1:gpt-5.4-mini',
      },
      restoredUsage: {
        inputTokens: 20_000,
        contextWindowOwner: 'pi:channel-1:gpt-5.4-mini',
        contextUsageIsEstimated: false,
      },
      currentOwner: 'pi:channel-1:gpt-5.4-mini',
    })).toBe('preserve_running')
  })

  test('Given 旧缓存已经水合 When 权威 IPC 提供新快照 Then 允许历史快照覆盖', () => {
    expect(decideIdleContextUsageMerge({
      state: {
        running: false,
        inputTokens: 10_000,
        contextUsageOrigin: 'history',
        contextWindowOwner: 'pi:channel-1:gpt-5.4-mini',
      },
      restoredUsage: {
        inputTokens: 20_000,
        contextWindowOwner: 'pi:channel-1:gpt-5.4-mini',
        contextUsageIsEstimated: false,
      },
      currentOwner: 'pi:channel-1:gpt-5.4-mini',
    })).toBe('restore_history')
  })

  test('Given 同 owner 的实时 usage When 历史消息刷新 Then 保留实时值', () => {
    expect(decideIdleContextUsageMerge({
      state: {
        running: false,
        inputTokens: 20_000,
        contextUsageOrigin: 'live',
        contextWindowOwner: 'pi:channel-1:gpt-5.4-mini',
      },
      restoredUsage: {
        inputTokens: 10_000,
        contextWindowOwner: 'pi:channel-1:gpt-5.4-mini',
        contextUsageIsEstimated: false,
      },
      currentOwner: 'pi:channel-1:gpt-5.4-mini',
    })).toBe('preserve_live')
  })

  test('Given 实时 usage owner 已过期且没有匹配历史 When 重新水合 Then 清除旧值', () => {
    expect(decideIdleContextUsageMerge({
      state: {
        running: false,
        inputTokens: 20_000,
        contextUsageOrigin: 'live',
        contextWindowOwner: 'claude:channel-1:gpt-5.4-mini',
      },
      currentOwner: 'pi:channel-1:gpt-5.4-mini',
    })).toBe('clear')
  })
})

describe('mergeAgentContextUsageHydrationState', () => {
  test('Given 运行中缺少 usage When 切回会话 Then 补入历史 usage 并保留实时运行字段', () => {
    const toolActivities = [{
      toolUseId: 'tool-1',
      toolName: 'Read',
      input: {},
      done: false,
    }]
    const state = {
      running: true,
      toolActivities,
      startedAt: 123,
      contextWindowOwner: 'pi:channel-1:gpt-5.4-mini',
      isCompacting: true,
    }
    const restoredUsage = {
      inputTokens: 20_000,
      outputTokens: 100,
      contextWindow: 400_000,
      contextWindowSource: 'provider_catalog' as const,
      contextWindowOwner: 'pi:channel-1:gpt-5.4-mini',
      contextUsageIsEstimated: false,
      model: 'gpt-5.4-mini',
    }

    const result = mergeAgentContextUsageHydrationState({
      state,
      restoredUsage,
      currentOwner: 'pi:channel-1:gpt-5.4-mini',
    })

    expect(result).toMatchObject({
      running: true,
      startedAt: 123,
      isCompacting: true,
      inputTokens: 20_000,
      contextWindow: 400_000,
      contextUsageOrigin: 'history',
    })
    expect(result?.toolActivities).toBe(toolActivities)
  })

  test('Given 压缩后旧 usage 已失效 When 历史消息尚无可靠新值 Then 水合仍保留显式失效状态', () => {
    const result = mergeAgentContextUsageHydrationState({
      state: {
        running: false,
        toolActivities: [],
        contextCompaction: { status: 'success' },
        contextUsageInvalidated: true,
      },
      restoredUsage: {
        inputTokens: 259_797,
        contextWindowOwner: 'pi:channel-1:gpt-5.4-mini',
        contextUsageIsEstimated: false,
      },
      currentOwner: 'pi:channel-1:gpt-5.4-mini',
    })

    expect(result).toMatchObject({
      running: false,
      contextCompaction: { status: 'success' },
      contextUsageInvalidated: true,
    })
    expect(result?.inputTokens).toBeUndefined()
  })

  test('Given 运行中已有实时 usage When 历史快照刷新 Then 保持原状态引用', () => {
    const state = {
      running: true,
      toolActivities: [],
      inputTokens: 30_000,
      contextUsageOrigin: 'live' as const,
      contextWindowOwner: 'pi:channel-1:gpt-5.4-mini',
    }
    expect(mergeAgentContextUsageHydrationState({
      state,
      restoredUsage: {
        inputTokens: 20_000,
        contextWindowOwner: 'pi:channel-1:gpt-5.4-mini',
        contextUsageIsEstimated: false,
      },
      currentOwner: 'pi:channel-1:gpt-5.4-mini',
    })).toBe(state)
  })
})

describe('运行中上下文用量展示', () => {
  test('Given 已有真实占用 When 下一轮 partial 暂无 usage Then 保留稳定快照', () => {
    const previous = {
      inputTokens: 21_953,
      outputTokens: 640,
      cacheReadTokens: 18_000,
      cacheCreationTokens: 953,
      contextWindow: 272_000,
      contextWindowSource: 'provider_catalog' as const,
    }

    expect(mergeStableAgentContextUsageSnapshot(previous, {
      inputTokens: undefined,
      contextWindow: 272_000,
      contextUsageInvalidated: false,
    })).toBe(previous)
    expect(mergeStableAgentContextUsageSnapshot(previous, {
      inputTokens: 0,
      contextWindow: 272_000,
      contextUsageInvalidated: false,
    })).toBe(previous)
  })

  test('Given 压缩成功但无新估算 When usage 被明确失效 Then 清空稳定快照', () => {
    expect(mergeStableAgentContextUsageSnapshot({
      inputTokens: 259_797,
      contextWindow: 272_000,
    }, {
      inputTokens: undefined,
      contextWindow: 272_000,
      contextUsageInvalidated: true,
    })).toBeNull()
  })

  test('Given 首个真实 usage 尚未到达 When 展示状态 Then 显示未知而不是 0k', () => {
    expect(formatAgentContextUsageSummary(undefined, 272_000)).toEqual({
      text: '— / 272k',
    })
    expect(formatAgentContextUsageSummary(0, 272_000)).toEqual({
      text: '— / 272k',
    })
  })

  test('Given 现场首轮真实 usage 已到达 When 后续模型继续生成 Then 展示最近真实占用', () => {
    expect(formatAgentContextUsageSummary(21_953, 272_000)).toEqual({
      text: '22k / 272k',
      percentage: '8%',
    })
  })
})

describe('buildAgentContextWindowOwner', () => {
  test('Given runtime/channel/model When 构建 owner Then 三者共同隔离状态', () => {
    expect(buildAgentContextWindowOwner('claude', 'channel-1', 'model-a')).toBe('claude:channel-1:model-a')
    expect(buildAgentContextWindowOwner('pi', 'channel-1', 'model-a')).toBe('pi:channel-1:model-a')
  })
})

import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@domi/shared'
import { calculateAgentSessionUsage, formatAgentUsageTokens } from './agent-session-usage'

function result(
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number },
  extra: Record<string, unknown> = {},
): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    usage,
    ...extra,
  } as SDKMessage
}

describe('agent session usage', () => {
  test('sums completed persisted provider input, output and cache usage without double counting', () => {
    expect(calculateAgentSessionUsage([
      result({ input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 80, cache_creation_input_tokens: 8 }, {
        _providerRequestCount: 2,
        _providerRequestCountAccuracy: 'exact',
      }),
      { type: 'assistant', message: { content: [] }, parent_tool_use_id: null } as SDKMessage,
      result({ input_tokens: 30, output_tokens: 6, cache_read_input_tokens: 20, cache_creation_input_tokens: 0 }),
    ])).toEqual({
      inputTokens: 150,
      uncachedInputTokens: 42,
      outputTokens: 10,
      cacheReadTokens: 100,
      cacheCreationTokens: 8,
      providerRequestCount: 3,
      providerRequestCoverage: 'partial',
    })
  })

  test('excludes synthetic compaction and invalid usage instead of mixing live estimates into totals', () => {
    expect(calculateAgentSessionUsage([
      result({ input_tokens: 100, output_tokens: 100 }, { isSyntheticCompactionResult: true }),
      result({ input_tokens: Number.NaN, output_tokens: 3 }),
      result({ input_tokens: 8, output_tokens: 2 }),
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'live output' }] },
        parent_tool_use_id: null,
        _domiLiveRunStartedAt: 100,
      } as unknown as SDKMessage,
    ])).toEqual({
      inputTokens: 8,
      uncachedInputTokens: 8,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      providerRequestCount: 1,
      providerRequestCoverage: 'partial',
    })
  })

  test('formats compact token values consistently for runtime, summaries and status labels', () => {
    expect(formatAgentUsageTokens(0)).toBe('—')
    expect(formatAgentUsageTokens(348)).toBe('348 tok')
    expect(formatAgentUsageTokens(1_000)).toBe('1k tok')
    expect(formatAgentUsageTokens(14_793)).toBe('14.8k tok')
    expect(formatAgentUsageTokens(4_800_196)).toBe('4.8m tok')
    expect(formatAgentUsageTokens(12_000_000)).toBe('12m tok')
  })
})

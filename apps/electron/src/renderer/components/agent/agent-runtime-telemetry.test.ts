import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@domi/shared'
import {
  estimateStreamingTextTokens,
  formatAgentRuntimeDuration,
  getAgentRuntimeOutputSnapshot,
  getAgentRuntimeProviderUsageSnapshot,
  reduceAgentRuntimeRailState,
  resolveAgentRuntimeOutputTokens,
  resolveAgentRuntimePhase,
  updateAgentRuntimeOutputEstimate,
  updateAgentTokenRateSamples,
} from './agent-runtime-telemetry'

function liveAssistant(
  content: Array<Record<string, unknown>>,
  runStartedAt = 100,
  extra: Record<string, unknown> = {},
): SDKMessage {
  return {
    type: 'assistant',
    message: { content },
    parent_tool_use_id: null,
    uuid: extra.uuid ?? 'assistant-1',
    _domiLiveRunStartedAt: runStartedAt,
    ...extra,
  } as unknown as SDKMessage
}

describe('agent runtime telemetry', () => {
  test('estimates only visible assistant text from the current run', () => {
    const snapshot = getAgentRuntimeOutputSnapshot([
      liveAssistant([{ type: 'text', text: 'hello 世界' }], 100),
      liveAssistant([{ type: 'text', text: 'old output' }], 99),
    ], 100)

    expect(snapshot.hasTextOutput).toBe(true)
    expect(snapshot.latestBlockKind).toBe('text')
    expect(snapshot.estimatedTextTokens).toBeCloseTo(estimateStreamingTextTokens('hello 世界'))
  })

  test('aggregates finalized provider usage from the current run and ignores partial or stale messages', () => {
    const snapshot = getAgentRuntimeProviderUsageSnapshot([
      liveAssistant([{ type: 'text', text: 'first' }], 100, {
        uuid: 'a-1',
        message: {
          content: [{ type: 'text', text: 'first' }],
          usage: { input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 80, cache_creation_input_tokens: 5 },
        },
      }),
      liveAssistant([{ type: 'text', text: 'partial' }], 100, {
        uuid: 'a-2',
        _partial: true,
        message: {
          content: [{ type: 'text', text: 'partial' }],
          usage: { input_tokens: 999, output_tokens: 999 },
        },
      }),
      liveAssistant([{ type: 'text', text: 'second' }], 100, {
        uuid: 'a-3',
        message: {
          content: [{ type: 'text', text: 'second' }],
          usage: { input_tokens: 30, output_tokens: 6, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 },
        },
      }),
      liveAssistant([{ type: 'text', text: 'old' }], 99, {
        message: { content: [], usage: { input_tokens: 500, output_tokens: 50 } },
      }),
    ], 100)

    expect(snapshot).toEqual({
      inputTokens: 225,
      uncachedInputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: 170,
      cacheCreationTokens: 5,
      providerRequestCount: 2,
    })
  })

  test('increments the current text estimate and falls back safely when a provider rewrites the block', () => {
    const initial = updateAgentRuntimeOutputEstimate([
      liveAssistant([{ type: 'text', text: 'hello' }]),
    ], 100)
    const appended = updateAgentRuntimeOutputEstimate([
      liveAssistant([{ type: 'text', text: 'hello 世界' }]),
    ], 100, initial.state)
    const rewritten = updateAgentRuntimeOutputEstimate([
      liveAssistant([{ type: 'text', text: '替换后的内容' }]),
    ], 100, appended.state)

    expect(appended.snapshot.estimatedTextTokens)
      .toBeCloseTo(estimateStreamingTextTokens('hello 世界'))
    expect(rewritten.snapshot.estimatedTextTokens)
      .toBeCloseTo(estimateStreamingTextTokens('替换后的内容'))
  })

  test('tool execution overrides response phase and hides rate samples', () => {
    const output = getAgentRuntimeOutputSnapshot([
      liveAssistant([{ type: 'text', text: 'streaming' }]),
    ], 100)
    const phase = resolveAgentRuntimePhase({
      streamState: {
        running: true,
        startedAt: 100,
        toolActivities: [{
          toolUseId: 'tool-1',
          toolName: 'Bash',
          input: {},
          intent: '运行测试',
          done: false,
        }],
      },
      output,
    })

    expect(phase).toEqual({ kind: 'tool', label: 'Using tools', detail: '运行测试' })
    expect(updateAgentTokenRateSamples({
      samples: [{ at: 1_000, tokens: 4 }],
      at: 1_500,
      tokens: 8,
      active: false,
    })).toEqual({ samples: [], rate: null })
  })

  test('uses English fixed phase labels without translating dynamic tool detail', () => {
    expect(resolveAgentRuntimePhase({
      streamState: undefined,
      output: { estimatedTextTokens: 0, hasTextOutput: false, latestBlockKind: null },
    })).toEqual({ kind: 'preparing', label: 'Preparing' })
    expect(resolveAgentRuntimePhase({
      streamState: undefined,
      output: { estimatedTextTokens: 0, hasTextOutput: false, latestBlockKind: 'thinking' },
    })).toEqual({ kind: 'thinking', label: 'Thinking' })
    expect(resolveAgentRuntimePhase({
      streamState: undefined,
      output: { estimatedTextTokens: 8, hasTextOutput: true, latestBlockKind: 'text' },
    })).toEqual({ kind: 'responding', label: 'Writing response' })
    expect(resolveAgentRuntimePhase({
      streamState: undefined,
      output: { estimatedTextTokens: 0, hasTextOutput: false, latestBlockKind: 'tool' },
    })).toEqual({ kind: 'tool', label: 'Using tools' })
    expect(resolveAgentRuntimePhase({
      streamState: { running: true, startedAt: 100, isCompacting: true, toolActivities: [] },
      output: { estimatedTextTokens: 0, hasTextOutput: false, latestBlockKind: null },
    })).toEqual({ kind: 'compacting', label: 'Compacting context' })
  })

  test('uses a short rolling window and does not emit a misleading zero rate', () => {
    let result = updateAgentTokenRateSamples({ samples: [], at: 1_000, tokens: 4, active: true })
    expect(result.rate).toBeNull()

    result = updateAgentTokenRateSamples({ samples: result.samples, at: 1_500, tokens: 8, active: true })
    expect(result.rate).toBe(8)

    result = updateAgentTokenRateSamples({ samples: result.samples, at: 3_000, tokens: 8, active: true })
    expect(result.rate).toBeNull()
  })

  test('adds only the unsettled current text estimate to finalized provider output', () => {
    expect(resolveAgentRuntimeOutputTokens({
      providerOutputTokens: 128,
      estimatedTextTokens: 12.4,
      hasTextOutput: true,
      streaming: true,
    })).toEqual({ value: 140, estimated: true })

    expect(resolveAgentRuntimeOutputTokens({
      providerOutputTokens: undefined,
      estimatedTextTokens: 12.4,
      hasTextOutput: true,
      streaming: true,
    })).toEqual({ value: 12, estimated: true })

    expect(resolveAgentRuntimeOutputTokens({
      providerOutputTokens: undefined,
      estimatedTextTokens: 0,
      hasTextOutput: false,
      streaming: true,
    })).toEqual({ value: null, estimated: false })
  })

  test('keeps a completed summary until dismissal and resets it for a new run', () => {
    const initial = {
      activeRunStartedAt: undefined,
      summary: null,
    }
    const running = reduceAgentRuntimeRailState(initial, { type: 'new_run', startedAt: 100 })
    expect(running).toEqual({ activeRunStartedAt: 100, summary: null })

    const completed = reduceAgentRuntimeRailState(running, {
      type: 'complete_run',
      summary: {
        runStartedAt: 100,
        elapsedSeconds: 12.4,
        inputTokens: null,
        outputTokens: 24,
        outputTokensEstimated: true,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        providerRequestCount: 0,
      },
    })
    expect(completed.summary).toEqual({
      runStartedAt: 100,
      elapsedSeconds: 12.4,
      inputTokens: null,
      outputTokens: 24,
      outputTokensEstimated: true,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      providerRequestCount: 0,
    })

    const providerFinalized = reduceAgentRuntimeRailState(completed, {
      type: 'provider_usage',
      startedAt: 100,
      usage: {
        inputTokens: 120,
        uncachedInputTokens: 20,
        outputTokens: 31,
        cacheReadTokens: 100,
        cacheCreationTokens: 0,
        providerRequestCount: 2,
      },
    })
    expect(providerFinalized.summary?.outputTokens).toBe(31)
    expect(providerFinalized.summary?.outputTokensEstimated).toBe(false)

    const dismissed = reduceAgentRuntimeRailState(providerFinalized, { type: 'dismiss_summary' })
    expect(dismissed.summary).toBeNull()
    const nextRun = reduceAgentRuntimeRailState(dismissed, { type: 'new_run', startedAt: 200 })
    expect(nextRun).toEqual({ activeRunStartedAt: 200, summary: null })
    expect(reduceAgentRuntimeRailState(nextRun, {
      type: 'reset',
      activeRunStartedAt: undefined,
    })).toEqual({ activeRunStartedAt: undefined, summary: null })
  })

  test('ignores stale completion and provider usage from another run', () => {
    const running = { activeRunStartedAt: 200, summary: null }
    expect(reduceAgentRuntimeRailState(running, {
      type: 'complete_run',
      summary: {
        runStartedAt: 100, elapsedSeconds: 1, inputTokens: null, outputTokens: 1,
        outputTokensEstimated: true, cacheReadTokens: 0, cacheCreationTokens: 0, providerRequestCount: 0,
      },
    })).toBe(running)

    const completed = {
      activeRunStartedAt: undefined,
      summary: {
        runStartedAt: 200, elapsedSeconds: 2, inputTokens: null, outputTokens: 2,
        outputTokensEstimated: true, cacheReadTokens: 0, cacheCreationTokens: 0, providerRequestCount: 0,
      },
    }
    expect(reduceAgentRuntimeRailState(completed, {
      type: 'provider_usage',
      startedAt: 100,
      usage: {
        inputTokens: 90,
        uncachedInputTokens: 10,
        outputTokens: 9,
        cacheReadTokens: 80,
        cacheCreationTokens: 0,
        providerRequestCount: 1,
      },
    })).toBe(completed)
  })

  test('formats stable tabular runtime durations', () => {
    expect(formatAgentRuntimeDuration(12.34)).toBe('12.3s')
    expect(formatAgentRuntimeDuration(72.34)).toBe('1m 12.3s')
  })
})

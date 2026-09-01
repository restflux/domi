import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from '@earendil-works/pi-ai/compat'
import {
  createPiOverflowRecoveryState,
  shouldDeferPiOverflowTerminalError,
  shouldDeferPiOverflowTerminalMessage,
} from './pi-overflow-recovery'

const RECOVERY_MODEL = {
  provider: 'test-provider',
  id: 'test-model',
  contextWindow: 200_000,
  maxTokens: 8_192,
}

function assistant(overrides: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    stopReason: 'stop',
    provider: RECOVERY_MODEL.provider,
    model: RECOVERY_MODEL.id,
    ...overrides,
  } as AssistantMessage
}

describe('Pi context overflow recognition', () => {
  test('defers prompt-too-long errors until native compaction settles', () => {
    const message = assistant({ stopReason: 'error', errorMessage: 'Prompt is too long for this model' })

    expect(shouldDeferPiOverflowTerminalMessage(message, RECOVERY_MODEL)).toBe(true)
    expect(shouldDeferPiOverflowTerminalError(message, RECOVERY_MODEL, false, false)).toBe(true)
  })

  test('defers zero-output length stops at the context boundary', () => {
    const message = assistant({
      stopReason: 'length',
      usage: {
        input: 198_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        totalTokens: 198_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    })

    expect(shouldDeferPiOverflowTerminalMessage(message, RECOVERY_MODEL)).toBe(true)
  })

  test('defers Pi 0.84 recoverable length stops below the model output limit', () => {
    const message = assistant({
      stopReason: 'length',
      usage: {
        input: 120_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 4_096,
        totalTokens: 124_096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    })

    expect(shouldDeferPiOverflowTerminalMessage(message, RECOVERY_MODEL)).toBe(true)
    expect(shouldDeferPiOverflowTerminalError(message, RECOVERY_MODEL, false, false)).toBe(true)
  })

  test('does not defer length tool calls because Pi core rejects and continues them inside the same loop', () => {
    const toolCallLength = assistant({
      stopReason: 'length',
      content: [{
        type: 'toolCall',
        id: 'call-truncated',
        name: 'write',
        arguments: { path: 'src/incomplete.ts' },
      }],
      usage: {
        input: 120_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 4_096,
        totalTokens: 124_096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    })

    expect(shouldDeferPiOverflowTerminalMessage(toolCallLength, RECOVERY_MODEL)).toBe(false)
  })

  test('uses the live session model and ignores a stale-model terminal', () => {
    const message = assistant({ stopReason: 'error', errorMessage: 'Prompt is too long for this model' })
    const switchedModel = { ...RECOVERY_MODEL, provider: 'other-provider', id: 'other-model' }

    expect(shouldDeferPiOverflowTerminalMessage(message, switchedModel)).toBe(false)
    expect(shouldDeferPiOverflowTerminalError(message, switchedModel, false, false)).toBe(false)
  })

  test('does not defer unrecoverable length stops, successful responses, retries, or aborts', () => {
    const exhaustedLength = assistant({
      stopReason: 'length',
      usage: {
        input: 120_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 8_192,
        totalTokens: 128_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    })
    const overflow = assistant({ stopReason: 'error', errorMessage: 'maximum context length exceeded' })

    expect(shouldDeferPiOverflowTerminalMessage(exhaustedLength, RECOVERY_MODEL)).toBe(false)
    expect(shouldDeferPiOverflowTerminalMessage(assistant({ stopReason: 'stop' }), RECOVERY_MODEL)).toBe(false)
    expect(shouldDeferPiOverflowTerminalError(overflow, RECOVERY_MODEL, true, false)).toBe(false)
    expect(shouldDeferPiOverflowTerminalError(overflow, RECOVERY_MODEL, false, true)).toBe(false)
  })
})

describe('Pi context overflow recovery lifecycle', () => {
  test('discards the deferred error after successful overflow compaction and retry', () => {
    const state = createPiOverflowRecoveryState()
    state.defer()

    expect(state.settleCompaction({ reason: 'overflow', aborted: false, hasResult: true, willRetry: true, discard: false })).toBe('discard')
    expect(state.isPending()).toBe(false)
  })

  test('releases the deferred error when compaction fails or is aborted', () => {
    const failed = createPiOverflowRecoveryState()
    failed.defer()
    expect(failed.settleCompaction({ reason: 'overflow', aborted: false, hasResult: false, willRetry: false, discard: false })).toBe('release')

    const aborted = createPiOverflowRecoveryState()
    aborted.defer()
    expect(aborted.settleCompaction({ reason: 'overflow', aborted: true, hasResult: false, willRetry: false, discard: false })).toBe('release')
  })

  test('ignores unrelated compaction events while overflow recovery is pending', () => {
    const state = createPiOverflowRecoveryState()
    state.defer()

    expect(state.settleCompaction({ reason: 'threshold', aborted: false, hasResult: true, willRetry: false, discard: false })).toBe('none')
    expect(state.isPending()).toBe(true)
  })

  test('discards pending overflow state when the user aborts or interrupts', () => {
    const aborted = createPiOverflowRecoveryState()
    aborted.defer()
    expect(aborted.settleCompaction({ reason: 'overflow', aborted: true, hasResult: false, willRetry: false, discard: true })).toBe('discard')

    const interrupted = createPiOverflowRecoveryState()
    interrupted.defer()
    expect(interrupted.settleFallback(true)).toBe('discard')
  })

  test('releases once on agent_settled when compaction_end is missing', () => {
    const state = createPiOverflowRecoveryState()
    state.defer()

    expect(state.settleFallback(false)).toBe('release')
    expect(state.settleFallback(false)).toBe('none')
  })
})

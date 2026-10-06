import { describe, expect, test } from 'bun:test'
import {
  createPiAssistantUuidTracker,
} from './pi-agent-adapter'
import { createPiRetryTerminalGate, mapPiNativeRetryEvent } from './pi-retry-control'

describe('Pi 1.0 native retry adapter', () => {
  test('keeps a partial assistant UUID through native recovery and releases it after the final response', () => {
    let nextUuid = 0
    const tracker = createPiAssistantUuidTracker(() => `assistant-${++nextUuid}`)

    const partialUuid = tracker.get()
    expect(tracker.get()).toBe(partialUuid)
    tracker.reset()
    expect(tracker.get()).toBe('assistant-2')
  })

  test('maps Pi 1.0 retry start and end events without requiring removed attempt events', () => {
    const context = { runStartedAt: 10_000 }
    expect(mapPiNativeRetryEvent({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 2,
      delayMs: 500,
      errorMessage: 'upstream timeout',
    }, context, 10_100)).toMatchObject([{
      status: 'starting',
      attempt: 1,
      maxAttempts: 2,
      delaySeconds: 0.5,
      reason: 'upstream timeout',
    }])
    expect(mapPiNativeRetryEvent({
      type: 'auto_retry_end',
      attempt: 1,
      maxAttempts: 2,
      success: false,
      finalError: 'connection reset',
    }, context, 10_900)).toMatchObject([{
      status: 'failed',
      attempt: 1,
      attemptData: { errorMessage: 'connection reset' },
    }])
  })

  test('defers a retryable terminal error until Pi reports whether it will retry', () => {
    const gate = createPiRetryTerminalGate<Error>()
    const error = new Error('transient')
    gate.defer(error)
    expect(gate.settle(true)).toBeUndefined()
    gate.defer(error)
    expect(gate.settle(false)).toBe(error)
    expect(gate.peek()).toBeUndefined()
  })
})

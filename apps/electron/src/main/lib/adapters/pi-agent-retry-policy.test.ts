import { describe, expect, test } from 'bun:test'
import { AgentSession } from '@earendil-works/pi-coding-agent'
import type { AssistantMessage } from '@earendil-works/pi-ai/compat'
import {
  createPiAssistantUuidTracker,
  mapSDKErrorToTypedError,
} from './pi-agent-adapter'
import { createPiRetryTerminalGate, mapPiNativeRetryEvent } from './pi-retry-control'

describe('Pi 1.0 native retry adapter', () => {
  test.each([
    'stream error: stream disconnected before completion: stream closed before response.completed',
    'stream disconnected before completion',
    'stream closed before response.completed',
  ])('Given 断流错误 "%s" Then 提供网络异常与手动重试入口', (message) => {
    const error = mapSDKErrorToTypedError('unknown_error', message)
    expect(error).toMatchObject({ code: 'network_error', title: '网络异常', canRetry: true, message })
    expect(error.actions).toContainEqual({ key: 'r', label: '重试', action: 'retry' })
  })

  test('Given 断流文本同时带账单错误 Then 不因网络措辞开启重试', () => {
    const error = mapSDKErrorToTypedError('unknown_error', 'insufficient_quota: stream closed before response.completed')
    expect(error).toMatchObject({ code: 'billing_error', canRetry: false })
    expect(error.actions?.some(action => action.action === 'retry')).toBe(false)
  })

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

describe('Pi 1.0.4 patched AgentSession retryNow (pi-coding-agent patch)', () => {
  interface RetrySettings {
    enabled: boolean
    maxRetries: number
    baseDelayMs: number
    maxAgentDelayMs: number
  }

  interface RetryStubSession {
    settingsManager: { getRetrySettings: () => RetrySettings }
    _retryAttempt: number
    _retryNowRequested: boolean
    _retryAbortController?: AbortController
    _emit: (event: { type: string; [key: string]: unknown }) => void
    _omitRecoveryAttempt: (message: AssistantMessage) => void
    _prepareRetry: (message: AssistantMessage) => Promise<boolean>
    retryNow: () => boolean
    abortRetry: () => void
    _finishCancelledRetry: () => void
  }

  const retrySettings: RetrySettings = {
    enabled: true,
    maxRetries: 8,
    baseDelayMs: 60_000,
    maxAgentDelayMs: 300_000,
  }

  /** 基于真实 AgentSession 原型构造最小桩，验证 patch 后的 retryNow/abortRetry 语义。 */
  function createRetryStubSession(): { session: RetryStubSession; events: Array<{ type: string; [key: string]: unknown }> } {
    const events: Array<{ type: string; [key: string]: unknown }> = []
    const session = Object.create(AgentSession.prototype) as RetryStubSession
    session.settingsManager = { getRetrySettings: () => retrySettings }
    session._retryAttempt = 0
    session._retryNowRequested = false
    session._emit = (event) => { events.push(event) }
    session._omitRecoveryAttempt = () => {}
    return { session, events }
  }

  function failedAssistant(): AssistantMessage {
    return {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'TypeError: Failed to fetch',
    } as unknown as AssistantMessage
  }

  test('Given retry backoff in progress When retryNow Then skip remaining wait without cancelling', async () => {
    const { session, events } = createRetryStubSession()

    const pending = session._prepareRetry(failedAssistant())
    expect(session.retryNow()).toBe(true)

    // 跳过等待：sleep 被中断但重试继续，不产生 cancelled 终态
    await expect(pending).resolves.toBe(true)
    expect(events.map((event) => event.type)).toEqual(['auto_retry_start'])
    expect(session._retryAttempt).toBe(1)
    expect(session._retryNowRequested).toBe(false)
    expect(session._retryAbortController).toBeUndefined()
  })

  test('Given retry backoff in progress When abortRetry Then cancel remains cancel', async () => {
    const { session, events } = createRetryStubSession()

    const pending = session._prepareRetry(failedAssistant())
    session.abortRetry()

    await expect(pending).resolves.toBe(false)
    expect(events.map((event) => event.type)).toEqual(['auto_retry_start', 'auto_retry_end'])
    expect(events[1]).toMatchObject({ success: false, finalError: 'Retry cancelled' })
    expect(session._retryAttempt).toBe(0)
  })

  test('Given no backoff in progress When retryNow Then report not applicable', () => {
    const { session } = createRetryStubSession()
    expect(session.retryNow()).toBe(false)
  })
})

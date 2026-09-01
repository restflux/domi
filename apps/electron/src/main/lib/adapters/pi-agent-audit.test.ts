import { describe, expect, test } from 'bun:test'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import {
  createPiRunAuditRecorder,
  type PiRunAuditTimingEvent,
} from '../audit/pi-run-audit.ts'
import { recordPiAgentAuditEvent } from './pi-agent-audit.ts'

function piEvent(event: object): AgentSessionEvent {
  return event as AgentSessionEvent
}

const assistantMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'safe visible content must not enter audit' }],
}

describe('Pi Agent timing adapter seam', () => {
  test('Given Pi AgentSessionEvent lifecycle When the adapter forwards it Then every timing phase is normalized without payloads', async () => {
    let now = 10_000
    const events: PiRunAuditTimingEvent[] = []
    const recorder = createPiRunAuditRecorder({
      sessionId: 'session-adapter',
      runStartedAt: now,
      now: () => now,
      onTimingEvent: (event) => { events.push(event) },
    })

    await recordPiAgentAuditEvent(recorder, piEvent({ type: 'turn_start' }))
    now = 10_005
    await recordPiAgentAuditEvent(recorder, piEvent({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'start' },
    }))
    now = 10_020
    await recordPiAgentAuditEvent(recorder, piEvent({
      type: 'message_update',
      message: assistantMessage,
      assistantMessageEvent: { type: 'text_delta', delta: 'secret output' },
    }))
    now = 10_050
    await recordPiAgentAuditEvent(recorder, piEvent({ type: 'message_end', message: assistantMessage }))
    now = 10_060
    await recordPiAgentAuditEvent(recorder, piEvent({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'Read',
      args: { path: 'C:\\private\\secret.txt' },
    }))
    now = 10_090
    await recordPiAgentAuditEvent(recorder, piEvent({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'Read',
      result: { stdout: 'secret result' },
      isError: false,
    }))
    now = 10_100
    await recordPiAgentAuditEvent(recorder, piEvent({
      type: 'auto_retry_start',
      attempt: 1,
      delayMs: 10,
      errorMessage: 'timeout at https://example.test/?key=secret',
    }))
    now = 10_110
    await recordPiAgentAuditEvent(recorder, piEvent({ type: 'auto_retry_attempt_start', attempt: 1 }))
    now = 10_140
    await recordPiAgentAuditEvent(recorder, piEvent({
      type: 'auto_retry_end',
      attempt: 1,
      success: true,
      outcome: 'succeeded',
    }))
    now = 10_160
    await recordPiAgentAuditEvent(recorder, piEvent({ type: 'agent_end', messages: [], willRetry: false }))

    expect(events.map((event) => event.phase)).toEqual([
      'first_token',
      'model_generation',
      'tool_execution',
      'retry',
      'retry',
      'total',
    ])
    expect(events).toMatchObject([
      { phase: 'first_token', durationMs: 20 },
      { phase: 'model_generation', durationMs: 50 },
      { phase: 'tool_execution', toolCorrelationId: expect.stringMatching(/^tool:[a-f0-9]{12}$/), outcome: 'success', durationMs: 30 },
      { phase: 'retry', stage: 'backoff', errorCategory: 'timeout', durationMs: 10 },
      { phase: 'retry', stage: 'attempt', outcome: 'succeeded', durationMs: 30 },
      { phase: 'total', durationMs: 160 },
    ])
    const persisted = JSON.stringify(events)
    for (const forbidden of ['safe visible content', 'secret output', 'private', 'secret result', 'example.test', 'call-1', 'toolCallId']) {
      expect(persisted).not.toContain(forbidden)
    }
  })
})

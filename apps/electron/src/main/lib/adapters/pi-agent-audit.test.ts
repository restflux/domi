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
      'total',
    ])
    expect(events).toMatchObject([
      { phase: 'first_token', durationMs: 20 },
      { phase: 'model_generation', durationMs: 50 },
      { phase: 'tool_execution', toolCorrelationId: expect.stringMatching(/^tool:[a-f0-9]{12}$/), outcome: 'success', durationMs: 30 },
      { phase: 'retry', stage: 'attempt', errorCategory: 'timeout', durationMs: 40, delayMs: 10 },
      { phase: 'total', durationMs: 160 },
    ])
    const persisted = JSON.stringify(events)
    for (const forbidden of ['safe visible content', 'secret output', 'private', 'secret result', 'example.test', 'call-1', 'toolCallId']) {
      expect(persisted).not.toContain(forbidden)
    }
  })

  test('Given 父子执行及独立授权 When timing序列持久化 Then 可脱敏关联父子而不保留原ID或内容', async () => {
    const events: PiRunAuditTimingEvent[] = []
    const recorder = createPiRunAuditRecorder({ sessionId: 'audit-test', runStartedAt: 0,
      onTimingEvent: event => { events.push(event) } })
    const parent = 'parent-sensitive-original-id'
    const child = 'child-sensitive-original-id'
    for (const [id, name, parentToolCallId] of [[parent, 'codemode', undefined], [child, 'Read', parent]] as const) {
      await recordPiAgentAuditEvent(recorder, piEvent({ type: 'tool_execution_start', toolCallId: id,
        toolName: name, parentToolCallId, args: { body: 'secret-payload' } }))
      await recorder.record({ type: 'authorization_start', toolCallId: id, toolName: name, parentToolCallId })
      await recorder.record({ type: 'authorization_end', toolCallId: id, toolName: name, parentToolCallId, outcome: 'allow' })
      await recordPiAgentAuditEvent(recorder, piEvent({ type: 'tool_execution_end', toolCallId: id,
        toolName: name, parentToolCallId, isError: false, result: { text: 'secret-result' } }))
    }
    const parentTiming = events.find(event => event.phase === 'tool_execution' && event.toolName === 'codemode')
    const childTiming = events.filter(event => (event.phase === 'tool_execution' || event.phase === 'tool_wait') && event.toolName === 'Read')
    expect(parentTiming?.phase).toBe('tool_execution')
    if (parentTiming?.phase !== 'tool_execution') throw new Error('父执行记录缺失')
    expect(childTiming).toHaveLength(2)
    expect(childTiming).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'tool_execution', parentToolCorrelationId: parentTiming.toolCorrelationId }),
      expect.objectContaining({ phase: 'tool_wait', parentToolCorrelationId: parentTiming.toolCorrelationId }),
    ]))
    const jsonl = events.map(event => JSON.stringify(event)).join('\n')
    for (const forbidden of [parent, child, 'secret-payload', 'secret-result', 'parentToolCallId', 'toolCallId']) {
      expect(jsonl).not.toContain(forbidden)
    }
  })
})

import { expect, test } from 'bun:test'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { readPiResponsesDiagnostics } from './pi-responses-diagnostics.ts'
import { createPiRunAuditRecorder, type PiRunAuditTimingEvent } from './pi-run-audit.ts'
import { recordPiAgentAuditEvent } from '../adapters/pi-agent-audit.ts'

const counters = { eventCount: 5, textDeltaChars: 0, itemDoneTextChars: 0, terminalTextChars: 2, recoveredTextBlocks: 1, parsedTextChars: 2 }

test('诊断只接受固定非负整数计数，不透传正文和凭据', async () => {
  const message = { role: 'assistant', content: [{ type: 'text', text: 'private-content' }], domiResponsesDiagnostics: { ...counters, secret: 'private-key' } }
  expect(readPiResponsesDiagnostics(message)).toEqual(counters)
  expect(readPiResponsesDiagnostics({ domiResponsesDiagnostics: { ...counters, eventCount: -1 } })).toBeUndefined()
  expect(readPiResponsesDiagnostics({ domiResponsesDiagnostics: { ...counters, parsedTextChars: 'secret' } })).toBeUndefined()
  const events: PiRunAuditTimingEvent[] = []
  const recorder = createPiRunAuditRecorder({ sessionId: 'fixture', runStartedAt: 100, now: () => 110, onTimingEvent: event => { events.push(event) } })
  await recorder.record({ type: 'turn_start' })
  await recordPiAgentAuditEvent(recorder, { type: 'message_end', message } as unknown as AgentSessionEvent)
  expect(events[0]).toMatchObject({ phase: 'model_generation', responses: counters })
  expect(JSON.stringify(events)).not.toContain('private-')
})

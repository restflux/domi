import { describe, expect, test } from 'bun:test'
import { buildAgentStreamCompletePayload } from './agent-completion-payload'

describe('Agent stream completion payload', () => {
  test('只发送终态元数据，不携带完整会话历史', () => {
    const payload = buildAgentStreamCompletePayload(
      { sessionId: 'session-1', triggeredBy: 'delegation' },
      {
        stoppedByUser: false,
        startedAt: 123,
        resultSubtype: 'success',
        resultErrors: [],
        backgroundTasksPending: false,
      },
    )

    expect(payload).toEqual({
      sessionId: 'session-1',
      triggeredBy: 'delegation',
      stoppedByUser: false,
      startedAt: 123,
      resultSubtype: 'success',
      resultErrors: [],
      backgroundTasksPending: false,
    })
    expect('messages' in payload).toBe(false)
  })
})

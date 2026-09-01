import { describe, expect, test } from 'bun:test'
import type { AgentContextBreakdown, AgentStreamPayload, SDKAssistantMessage } from '@domi/shared'
import { payloadToLegacyEvents } from './useGlobalAgentListeners.ts'

describe('payloadToLegacyEvents execution scope', () => {
  test('temporary execution events preserve the exact run token for generation-aware renderer cleanup', () => {
    const payload: AgentStreamPayload = {
      kind: 'domi_event',
      event: {
        type: 'temporary_execution_changed',
        sessionId: 'session-run',
        active: true,
        runToken: 17,
      },
    }

    expect(payloadToLegacyEvents(payload)).toEqual([{
      type: 'temporary_execution_changed',
      active: true,
      runToken: 17,
    }])
  })

  test('run-scoped plan completion omits workflow so renderer session persistence stays unchanged', () => {
    const payload: AgentStreamPayload = {
      kind: 'domi_event',
      event: {
        type: 'plan_mode_changed',
        sessionId: 'session-run',
        active: false,
        source: 'permission',
      },
    }

    expect(payloadToLegacyEvents(payload)).toEqual([{
      type: 'plan_mode_changed',
      active: false,
      source: 'permission',
    }])
  })

  test('explicit session-scoped switch carries Direct workflow for renderer persistence', () => {
    const payload: AgentStreamPayload = {
      kind: 'domi_event',
      event: {
        type: 'plan_mode_changed',
        sessionId: 'session-persistent',
        active: false,
        source: 'permission',
        workflow: 'direct',
      },
    }

    expect(payloadToLegacyEvents(payload)).toEqual([{
      type: 'plan_mode_changed',
      active: false,
      source: 'permission',
      workflow: 'direct',
    }])
  })
})

describe('payloadToLegacyEvents context breakdown', () => {
  test('将主进程实时构成事件转换为 usage_update', () => {
    const breakdown: AgentContextBreakdown = {
      capturedAt: 123,
      system: 10,
      skills: 20,
      mcp: 30,
      tools: 15,
      conversation: 25,
    }
    const payload: AgentStreamPayload = {
      kind: 'domi_event',
      event: { type: 'context_breakdown', breakdown },
    }

    expect(payloadToLegacyEvents(payload)).toEqual([{
      type: 'usage_update',
      usage: { contextBreakdown: breakdown },
    }])
  })

  test('eight sessions streaming twenty text frames create zero legacy正文 events', () => {
    let legacyBodyEvents = 0
    for (let session = 0; session < 8; session += 1) {
      for (let frame = 0; frame < 20; frame += 1) {
        const payload: AgentStreamPayload = {
          kind: 'sdk_delta',
          delta: {
            uuid: `assistant-${session}`,
            session_id: `session-${session}`,
            runStartedAt: session + 1,
            deltas: [{ type: 'text_delta', contentIndex: 0, delta: `frame-${frame}` }],
          },
        }
        legacyBodyEvents += payloadToLegacyEvents(payload).filter((event) => (
          event.type === 'text_complete' || event.type === 'text_delta'
        )).length
      }
    }

    expect(legacyBodyEvents).toBe(0)
  })

  test('authoritative assistant final does not copy正文 into legacy stream state', () => {
    const payload: AgentStreamPayload = {
      kind: 'sdk_message',
      message: {
        type: 'assistant',
        uuid: 'assistant-final',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '这是唯一的 SDKMessage 正文' }],
          model: 'test-model',
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          timestamp: 1,
        },
      } as SDKAssistantMessage,
    }

    const events = payloadToLegacyEvents(payload)

    expect(events.some((event) => event.type === 'text_complete' || event.type === 'text_delta')).toBe(false)
    expect(events.some((event) => event.type === 'usage_update')).toBe(true)
  })
})

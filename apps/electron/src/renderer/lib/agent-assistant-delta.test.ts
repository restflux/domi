import { describe, expect, test } from 'bun:test'
import type { AgentAssistantDeltaPayload, SDKAssistantMessage, SDKUserMessage } from '@domi/shared'
import {
  applyAssistantDeltasToPreview,
  createAssistantDeltaPreview,
  shouldApplyAgentAssistantDelta,
  upsertAgentSDKMessage,
} from './agent-assistant-delta'

function payload(overrides: Partial<AgentAssistantDeltaPayload> = {}): AgentAssistantDeltaPayload {
  return {
    uuid: 'assistant-1',
    session_id: 'session-1',
    runStartedAt: 100,
    deltas: [],
    ...overrides,
  }
}

describe('agent assistant delta preview', () => {
  test('assembles interleaved text, thinking and tool-call blocks by content index', () => {
    const preview = createAssistantDeltaPreview(payload(), {
      _channelModelId: 'deepseek-v4-pro',
      _channelProvider: 'deepseek',
    })

    const assembled = applyAssistantDeltasToPreview(preview, [
      { type: 'thinking_start', contentIndex: 0 },
      { type: 'text_start', contentIndex: 1 },
      { type: 'thinking_delta', contentIndex: 0, delta: '先分析' },
      { type: 'toolcall_start', contentIndex: 2, toolCall: { id: 'tool-1', name: 'Read', arguments: {} } },
      { type: 'text_delta', contentIndex: 1, delta: '结论' },
      { type: 'toolcall_end', contentIndex: 2, toolCall: { id: 'tool-1', name: 'Read', arguments: { path: 'a.ts' } } },
    ])

    expect(assembled.message.content).toEqual([
      { type: 'thinking', thinking: '先分析' },
      { type: 'text', text: '结论' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.ts' } },
    ])
    expect(assembled).toMatchObject({
      type: 'assistant',
      uuid: 'assistant-1',
      session_id: 'session-1',
      _partial: true,
      _createdAt: 100,
      _domiLiveRunStartedAt: 100,
      _channelModelId: 'deepseek-v4-pro',
      _channelProvider: 'deepseek',
    })
  })

  test('accepts only deltas belonging to the current run and rejects unscoped late events', () => {
    expect(shouldApplyAgentAssistantDelta(100, 100)).toBe(true)
    expect(shouldApplyAgentAssistantDelta(100, 99)).toBe(false)
    expect(shouldApplyAgentAssistantDelta(100, undefined)).toBe(false)
    expect(shouldApplyAgentAssistantDelta(undefined, 100)).toBe(false)
  })

  test('replaces the partial preview with the authoritative final message of the same uuid', () => {
    const preview = applyAssistantDeltasToPreview(createAssistantDeltaPreview(payload()), [
      { type: 'text_delta', contentIndex: 0, delta: 'partial' },
    ])
    const final: SDKAssistantMessage = {
      type: 'assistant',
      uuid: 'assistant-1',
      session_id: 'session-1',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'final' }] },
    }

    const next = upsertAgentSDKMessage([preview], final)
    expect(next).toHaveLength(1)
    expect(next[0]).toBe(final)
    expect((next[0] as SDKAssistantMessage).message.content).toEqual([{ type: 'text', text: 'final' }])
  })

  test('keeps one user bubble when duplicate SDK delivery events share a uuid', () => {
    const firstDelivery: SDKUserMessage = {
      type: 'user',
      uuid: 'steering-1',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '调整方向' }] },
    }
    const confirmed: SDKUserMessage = {
      type: 'user',
      uuid: 'steering-1',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: '调整方向' }] },
    }

    const next = upsertAgentSDKMessage([firstDelivery], confirmed)

    expect(next).toHaveLength(1)
    expect(next[0]).toBe(firstDelivery)
  })

  test('transfers nearly linear payload text instead of cumulative full snapshots', () => {
    const chunks = Array.from({ length: 200 }, (_, index) => `${index.toString().padStart(3, '0')}:` + 'x'.repeat(96))
    let cumulative = ''
    let cumulativeBytes = 0
    let deltaBytes = 0

    for (const chunk of chunks) {
      cumulative += chunk
      cumulativeBytes += JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: cumulative }] } }).length
      deltaBytes += JSON.stringify({ kind: 'sdk_delta', delta: { uuid: 'u', deltas: [{ type: 'text_delta', contentIndex: 0, delta: chunk }] } }).length
    }

    expect(cumulativeBytes).toBeGreaterThan(deltaBytes * 30)
    expect(deltaBytes).toBeLessThan(chunks.join('').length * 3)
  })
})

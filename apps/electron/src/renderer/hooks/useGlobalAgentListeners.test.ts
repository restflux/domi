import { describe, expect, test } from 'bun:test'
import type { AgentContextBreakdown, AgentStreamPayload, SDKAssistantMessage } from '@domi/shared'
import { createStore } from 'jotai'
import { agentSessionsAtom, agentSessionChannelMapAtom, agentSessionModelMapAtom, agentChannelIdAtom, agentModelIdAtom, agentStreamingStatesAtom } from '@/atoms/agent-atoms'
import { applyAgentModelSelection, payloadToLegacyEvents } from './useGlobalAgentListeners.ts'

describe('远端模型选择同步', () => {
  test('同步底部读取的会话元数据及缓存，不改变全局默认、其他会话或正在运行的模型', () => {
    const store = createStore()
    const otherSession = { id: 'other', title: '其他会话', createdAt: 1, updatedAt: 1, channelId: 'other-channel', modelId: 'other-model' }
    store.set(agentSessionsAtom, [
      { id: 'wechat', title: '微信会话', createdAt: 1, updatedAt: 1, channelId: 'old-channel', modelId: 'old-model' },
      otherSession,
    ])
    store.set(agentChannelIdAtom, 'default-channel')
    store.set(agentModelIdAtom, 'default-model')
    store.set(agentSessionChannelMapAtom, new Map([['wechat', 'old-channel'], ['other', 'other-channel']]))
    store.set(agentSessionModelMapAtom, new Map([['wechat', 'old-model'], ['other', 'other-model']]))
    const runningState = { running: true, toolActivities: [], model: 'running-model', startedAt: 1 }
    store.set(agentStreamingStatesAtom, new Map([['wechat', runningState]]))

    applyAgentModelSelection(store, 'wechat', {
      type: 'model_selection_changed', channelId: 'channel-5', modelId: 'model-9', updatedAt: 2,
    })

    expect(store.get(agentSessionsAtom)[0]).toMatchObject({ channelId: 'channel-5', modelId: 'model-9', updatedAt: 2 })
    expect(store.get(agentSessionsAtom)[1]).toBe(otherSession)
    expect(store.get(agentSessionChannelMapAtom)).toEqual(new Map([['wechat', 'channel-5'], ['other', 'other-channel']]))
    expect(store.get(agentSessionModelMapAtom)).toEqual(new Map([['wechat', 'model-9'], ['other', 'other-model']]))
    expect(store.get(agentChannelIdAtom)).toBe('default-channel')
    expect(store.get(agentModelIdAtom)).toBe('default-model')
    expect(store.get(agentStreamingStatesAtom).get('wechat')).toBe(runningState)
  })
})

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

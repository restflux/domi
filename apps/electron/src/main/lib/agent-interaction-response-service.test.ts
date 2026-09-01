import { describe, expect, test } from 'bun:test'
import type { AgentStreamPayload, ExitPlanModeResponse } from '@domi/shared'
import { AgentInteractionResponseService } from './agent-interaction-response-service'

describe('AgentInteractionResponseService', () => {
  test('Given AskUser 仍待处理 When IM 首次回答 Then 只提交一次并广播 resolved', () => {
    let pending = true
    const events: Array<{ sessionId: string; payload: AgentStreamPayload }> = []
    let changed = 0
    const service = new AgentInteractionResponseService({
      askUser: {
        respondToAskUser: () => {
          if (!pending) return null
          pending = false
          return 'session-1'
        },
      },
      exitPlan: { respondToExitPlanMode: () => null },
      eventBus: { emit: (sessionId, payload) => events.push({ sessionId, payload }) },
      onChanged: () => { changed += 1 },
    })

    expect(service.respondAskUser('ask-1', { 问题: '答案' })).toBe(true)
    expect(service.respondAskUser('ask-1', { 问题: '迟到答案' })).toBe(false)
    expect(changed).toBe(1)
    expect(events).toEqual([{
      sessionId: 'session-1',
      payload: { kind: 'domi_event', event: { type: 'ask_user_resolved', requestId: 'ask-1' } },
    }])
  })

  test('Given 计划仍待审批 When 桌面或 IM 首次选择 Then 广播相同 resolved 事件', () => {
    let pending = true
    const events: Array<{ sessionId: string; payload: AgentStreamPayload }> = []
    const service = new AgentInteractionResponseService({
      askUser: { respondToAskUser: () => null },
      exitPlan: {
        respondToExitPlanMode: (_response: ExitPlanModeResponse) => {
          if (!pending) return null
          pending = false
          return { sessionId: 'session-2', workflow: 'direct', executionScope: 'run' }
        },
      },
      eventBus: { emit: (sessionId, payload) => events.push({ sessionId, payload }) },
      onChanged: () => {},
    })

    expect(service.respondExitPlan({ requestId: 'plan-1', action: 'approve_current' })).toBe(true)
    expect(service.respondExitPlan({ requestId: 'plan-1', action: 'deny' })).toBe(false)
    expect(events).toEqual([{
      sessionId: 'session-2',
      payload: { kind: 'domi_event', event: { type: 'exit_plan_mode_resolved', requestId: 'plan-1' } },
    }])
  })
})

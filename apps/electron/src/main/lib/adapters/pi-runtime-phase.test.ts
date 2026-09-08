import { expect, test } from 'bun:test'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { AgentRuntimePhaseUpdate } from '@domi/shared'
import { createPiRuntimePhaseTracker } from './pi-runtime-phase.ts'

test('初始化后等待，空输出不结束等待，空回复续跑在有效输出后恢复', () => {
  const updates: AgentRuntimePhaseUpdate[] = []
  const tracker = createPiRuntimePhaseTracker(100, update => updates.push(update))
  const observe = (assistantMessageEvent: object) => tracker.observe({ type: 'message_update', assistantMessageEvent } as AgentSessionEvent)
  tracker.requestStarted()
  observe({ type: 'text_start' })
  observe({ type: 'text_end', content: '' })
  expect(updates).toEqual([{ phase: 'waiting', runStartedAt: 100 }])
  tracker.retryEmptyResponse()
  tracker.requestStarted()
  expect(updates.at(-1)?.phase).toBe('empty_retry')
  observe({ type: 'text_end', content: 'recovered' })
  observe({ type: 'text_delta', delta: 'more' })
  expect(updates.map(x => x.phase)).toEqual(['waiting', 'empty_retry', 'receiving'])
  tracker.requestStarted()
  expect(updates.at(-1)?.phase).toBe('waiting')
})

test('工具调用或可见思考也是有效输出', () => {
  for (const event of [{ type: 'toolcall_start' }, { type: 'thinking_delta', delta: 'thinking' }]) {
    const updates: AgentRuntimePhaseUpdate[] = []
    const tracker = createPiRuntimePhaseTracker(101, update => updates.push(update))
    tracker.requestStarted()
    tracker.observe({ type: 'message_update', assistantMessageEvent: event } as AgentSessionEvent)
    expect(updates.at(-1)).toEqual({ phase: 'receiving', runStartedAt: 101 })
  }
})

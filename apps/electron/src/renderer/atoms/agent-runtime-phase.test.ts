import { expect, test } from 'bun:test'
import { applyAgentEvent, type AgentStreamState } from './agent-atoms'
import { payloadToLegacyEvents } from '../hooks/useGlobalAgentListeners'
import { resolveAgentRuntimePhase } from '../components/agent/agent-runtime-telemetry'

test('请求阶段贯穿 payload 与 atoms，等待不能被上一个 turn 的正文覆盖', () => {
  const initial: AgentStreamState = { running: true, startedAt: 100, toolActivities: [] }
  const [event] = payloadToLegacyEvents({ kind: 'domi_event', event: { type: 'runtime_phase', phase: 'waiting', runStartedAt: 100 } })
  const state = applyAgentEvent(initial, event!)
  expect(resolveAgentRuntimePhase({ streamState: state, output: { latestBlockKind: 'text', estimatedTextTokens: 20, hasTextOutput: true } })).toEqual({ kind: 'waiting', label: 'Waiting for model' })
  const retry = applyAgentEvent(state, { type: 'runtime_phase', phase: 'empty_retry', runStartedAt: 100 })
  expect(resolveAgentRuntimePhase({ streamState: retry, output: { latestBlockKind: null, estimatedTextTokens: 0, hasTextOutput: false } }).kind).toBe('retrying')
  const receiving = applyAgentEvent(retry, { type: 'runtime_phase', phase: 'receiving', runStartedAt: 100 })
  expect(resolveAgentRuntimePhase({ streamState: receiving, output: { latestBlockKind: 'text', estimatedTextTokens: 2, hasTextOutput: true } }).kind).toBe('responding')
})

test('旧 run 或已结束会话的阶段事件不得污染新状态', () => {
  const state: AgentStreamState = { running: true, startedAt: 200, toolActivities: [] }
  expect(applyAgentEvent(state, { type: 'runtime_phase', phase: 'waiting', runStartedAt: 100 })).toBe(state)
  const finished = { ...state, running: false }
  expect(applyAgentEvent(finished, { type: 'runtime_phase', phase: 'waiting', runStartedAt: 200 })).toBe(finished)
})

import { describe, expect, test } from 'bun:test'
import { AgentRunExecutionLeaseRegistry } from './agent-run-execution-lease.ts'

describe('AgentRunExecutionLeaseRegistry', () => {
  test('creates strictly increasing run tokens even when runs start in the same clock tick', () => {
    const registry = new AgentRunExecutionLeaseRegistry()

    const first = registry.createRunToken()
    const second = registry.createRunToken()

    expect(second).toBe(first + 1)
  })

  test('a stale run cannot revoke or inherit the replacement run lease', () => {
    const registry = new AgentRunExecutionLeaseRegistry()
    const oldRun = registry.createRunToken()
    const newRun = registry.createRunToken()

    registry.grant('session-1', oldRun)
    registry.grant('session-1', newRun)

    expect(registry.revoke('session-1', oldRun)).toBe(false)
    expect(registry.owns('session-1', newRun)).toBe(true)
    expect(registry.revoke('session-1', newRun)).toBe(true)
    expect(registry.owns('session-1', newRun)).toBe(false)
  })

  test('clearing one session does not revoke another session lease', () => {
    const registry = new AgentRunExecutionLeaseRegistry()
    const first = registry.createRunToken()
    const second = registry.createRunToken()
    registry.grant('session-a', first)
    registry.grant('session-b', second)

    registry.clearSession('session-a')

    expect(registry.owns('session-a', first)).toBe(false)
    expect(registry.owns('session-b', second)).toBe(true)
  })
})

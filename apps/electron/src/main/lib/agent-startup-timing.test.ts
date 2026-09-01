import { describe, expect, test } from 'bun:test'
import {
  createAgentStartupTimingRecorder,
  type AgentStartupTimingEvent,
} from './agent-startup-timing.ts'

describe('Agent startup timing recorder', () => {
  test('Given startup phases When they are recorded Then only bounded stage metadata and durations are emitted', async () => {
    let now = 1_000
    const events: AgentStartupTimingEvent[] = []
    const recorder = createAgentStartupTimingRecorder({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      runStartedAt: now,
      now: () => now,
      onTimingEvent: (event) => { events.push(event) },
    })

    now = 1_025
    recorder.recordSessionTarget(1_005, {
      outcome: 'success',
      targetKind: 'isolated',
      ownership: 'owner',
    })
    now = 1_080
    recorder.recordDependencySnapshot({
      status: 'ready',
      durationMs: 60,
      overlapMs: 0,
      waitDurationMs: 60,
    })
    now = 1_095
    recorder.recordAgentInitialization(1_025)
    now = 1_100
    recorder.recordPiQuery({ resume: true })
    await recorder.flush()

    expect(events).toEqual([
      {
        phase: 'session_target',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        runStartedAt: 1_000,
        timestamp: new Date(1_025).toISOString(),
        durationMs: 20,
        outcome: 'success',
        targetKind: 'isolated',
        ownership: 'owner',
      },
      {
        phase: 'dependency_snapshot',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        runStartedAt: 1_000,
        timestamp: new Date(1_080).toISOString(),
        durationMs: 60,
        status: 'ready',
        overlapMs: 0,
        waitDurationMs: 60,
      },
      {
        phase: 'agent_initialization',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        runStartedAt: 1_000,
        timestamp: new Date(1_095).toISOString(),
        durationMs: 70,
      },
      {
        phase: 'pi_query',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        runStartedAt: 1_000,
        timestamp: new Date(1_100).toISOString(),
        durationMs: 100,
        resume: true,
      },
    ])
    expect(JSON.stringify(events)).not.toContain('C:\\')
    expect(JSON.stringify(events)).not.toContain('command')
    expect(JSON.stringify(events)).not.toContain('environment')
  })

  test('Given an audit sink failure When startup continues Then timing remains best effort', async () => {
    let emitted = 0
    const recorder = createAgentStartupTimingRecorder({
      sessionId: 'session-2',
      runStartedAt: 0,
      now: () => 10,
      onTimingEvent: () => {
        emitted += 1
        throw new Error('audit disk unavailable')
      },
    })

    recorder.recordPiQuery({ resume: false })
    recorder.recordAgentInitialization(5)
    await expect(recorder.flush()).resolves.toBeUndefined()
    expect(emitted).toBe(2)
  })
})

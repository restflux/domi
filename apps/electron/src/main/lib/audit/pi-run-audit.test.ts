import { describe, expect, test } from 'bun:test'
import {
  createPiRunAuditRecorder,
  type PiRunAuditTimingEvent,
} from './pi-run-audit.ts'
import { capturePiRequestEnvelope } from './pi-request-envelope.ts'

describe('PiRunAuditRecorder', () => {
  test('Given two model turns When assistant output streams Then first token, generation, and terminal total are timed per turn', async () => {
    let now = 1_000
    const events: PiRunAuditTimingEvent[] = []
    const recorder = createPiRunAuditRecorder({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      runStartedAt: now,
      now: () => now,
      onTimingEvent: (event) => { events.push(event) },
    })

    await recorder.record({ type: 'turn_start' })
    now = 1_030
    await recorder.record({ type: 'assistant_update' })
    now = 1_050
    await recorder.record({ type: 'assistant_update' })
    now = 1_080
    await recorder.record({ type: 'assistant_end' })
    now = 1_100
    await recorder.record({ type: 'turn_start' })
    now = 1_125
    await recorder.record({ type: 'assistant_update' })
    now = 1_160
    await recorder.record({ type: 'assistant_end' })
    now = 1_200
    await recorder.record({ type: 'agent_end', willRetry: false })

    expect(events.map(({ phase, durationMs }) => [phase, durationMs])).toEqual([
      ['first_token', 30],
      ['model_generation', 80],
      ['first_token', 25],
      ['model_generation', 60],
      ['total', 200],
    ])
    expect(events.map((event) => 'turn' in event ? event.turn : undefined)).toEqual([1, 1, 2, 2, undefined])
    expect(events.flatMap((event) => event.phase === 'first_token' ? [event.runDurationMs] : []))
      .toEqual([30, 125])
    expect(events.map((event) => event.timestamp)).toEqual([1_030, 1_080, 1_125, 1_160, 1_200]
      .map((timestamp) => new Date(timestamp).toISOString()))
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5])
    for (const event of events) {
      expect(event).toMatchObject({
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        runStartedAt: 1_000,
        runId: 'session-1:1000',
      })
    }
  })

  test('Given provider calls within turns When envelopes are recorded Then immutable run, turn and request identities are emitted in sequence', async () => {
    let now = 2_000
    const events: PiRunAuditTimingEvent[] = []
    const recorder = createPiRunAuditRecorder({
      sessionId: 'session-envelope',
      runStartedAt: now,
      now: () => now,
      onTimingEvent: (event) => { events.push(event) },
    })
    const envelope = capturePiRequestEnvelope({
      capturedAt: now,
      provider: 'openai-responses',
      modelId: 'gpt-5.6',
      reasoningLevel: 'xhigh',
      contextWindow: 272_000,
      systemPrompt: 'private prompt',
      messageCount: 3,
      tools: [{ name: 'Read', parameters: { type: 'object' } }],
      piActiveLeafId: 'leaf-1',
      runtimeContext: {
        executionPolicy: 'controlled',
        workflow: 'direct',
        sessionTarget: { kind: 'isolated', ownership: 'owner', revision: 4 },
      },
    })

    await recorder.record({ type: 'turn_start' })
    await recorder.record({ type: 'model_request', envelope })
    envelope.modelId = 'mutated-after-record'
    envelope.controls!.workflow = 'plan-first'
    now = 2_010
    await recorder.record({ type: 'model_request', envelope: { ...envelope, capturedAt: now } })
    now = 2_020
    await recorder.record({ type: 'turn_start' })
    await recorder.record({ type: 'model_request', envelope: { ...envelope, capturedAt: now } })

    expect(events).toHaveLength(3)
    expect(events.map((event) => event.phase)).toEqual(['request_envelope', 'request_envelope', 'request_envelope'])
    expect(events).toMatchObject([
      {
        runId: 'session-envelope:2000',
        turn: 1,
        turnId: 'session-envelope:2000:turn:1',
        requestOrdinal: 1,
        requestId: 'session-envelope:2000:turn:1:request:1',
        sequence: 1,
        envelope: { modelId: 'gpt-5.6', controls: { workflow: 'direct' } },
      },
      {
        turn: 1,
        requestOrdinal: 2,
        requestId: 'session-envelope:2000:turn:1:request:2',
        sequence: 2,
      },
      {
        turn: 2,
        turnId: 'session-envelope:2000:turn:2',
        requestOrdinal: 1,
        requestId: 'session-envelope:2000:turn:2:request:1',
        sequence: 3,
      },
    ])
    expect(JSON.stringify(events[0])).not.toContain('private prompt')
    expect(JSON.stringify(events[0])).not.toContain('mutated-after-record')
  })

  test('Given retry events contain secret error text When retry is timed Then only a stable category, attempt, delay, duration, and outcome are emitted', async () => {
    let now = 3_000
    const events: PiRunAuditTimingEvent[] = []
    const recorder = createPiRunAuditRecorder({
      sessionId: 'session-retry',
      runStartedAt: now,
      now: () => now,
      onTimingEvent: (event) => { events.push(event) },
    })
    const secret = 'provider-secret-value'

    await recorder.record({ type: 'turn_start' })
    await recorder.record({
      type: 'retry_scheduled',
      attempt: 2,
      delayMs: 40,
      errorMessage: `429 https://example.test/path?token=${secret}`,
    })
    now = 3_040
    await recorder.record({ type: 'retry_attempt_start', attempt: 2 })
    now = 3_050
    await recorder.record({ type: 'turn_start' })
    now = 3_100
    await recorder.record({
      type: 'retry_end',
      attempt: 2,
      outcome: 'exhausted',
      errorMessage: `Bearer ${secret}`,
    })

    expect(events).toMatchObject([
      { phase: 'retry', stage: 'backoff', turn: 2, attempt: 2, delayMs: 40, errorCategory: 'rate_limit', durationMs: 40 },
      { phase: 'retry', stage: 'attempt', turn: 2, attempt: 2, outcome: 'exhausted', errorCategory: 'rate_limit', durationMs: 60 },
    ])
    expect(JSON.stringify(events)).not.toContain(secret)
    expect(JSON.stringify(events)).not.toContain('example.test')
  })

  test('Given ContextCompactor reports provider-only enhancement When audited Then compaction evidence is recorded as its own phase', async () => {
    const events: PiRunAuditTimingEvent[] = []
    const recorder = createPiRunAuditRecorder({
      sessionId: 'session-compaction',
      workspaceId: 'workspace-1',
      runStartedAt: 3_500,
      now: () => 3_520,
      onTimingEvent: (event) => { events.push(event) },
    })

    await recorder.record({
      type: 'compaction',
      attemptId: 'compact-1',
      stage: 'provider_projection',
      strategy: 'pi-recent-user-pinned-v1',
      mode: 'enhance',
      outcome: 'fallback_validation',
      durationMs: 4,
      reason: 'threshold',
      willRetry: false,
      recentUserCount: 2,
      recentUserTokens: 180,
      pinnedFactCount: 3,
      pinnedFactTokens: 90,
      totalEnhancementTokens: 270,
      summaryInputTokens: 12_000,
      summaryOutputTokens: 900,
      compactionEntryId: 'entry-1',
      providerRequestId: 'summary-request-1',
      errorCode: 'evidence_validation_failed',
      factKey: 'delivery-review',
      ruleId: 'review_validation_inconsistent',
      failureCategory: 'host_state_inconsistent',
      stateFingerprint: 'a3d430506ebe1823',
      errorMessage: 'snapshot failed at C:\\Users\\private\\secret.json',
    })

    expect(events).toEqual([expect.objectContaining({
      phase: 'compaction',
      attemptId: 'compact-1',
      stage: 'provider_projection',
      strategy: 'pi-recent-user-pinned-v1',
      outcome: 'fallback_validation',
      durationMs: 4,
      factKey: 'delivery-review',
      ruleId: 'review_validation_inconsistent',
      failureCategory: 'host_state_inconsistent',
      stateFingerprint: 'a3d430506ebe1823',
      recentUserTokens: 180,
      pinnedFactTokens: 90,
      summaryInputTokens: 12_000,
      summaryOutputTokens: 900,
      providerRequestId: 'summary-request-1',
      runId: 'session-compaction:3500',
      sequence: 1,
    })])
    expect(JSON.stringify(events)).not.toContain('private')
    expect(JSON.stringify(events)).not.toContain('errorMessage')
  })

  test('Given the timing writer rejects When recording continues Then the run-facing recorder always resolves', async () => {
    let calls = 0
    const recorder = createPiRunAuditRecorder({
      sessionId: 'session-failing-writer',
      runStartedAt: 4_000,
      now: () => 4_010,
      onTimingEvent: async () => {
        calls += 1
        throw new Error('writer failed with a secret')
      },
    })

    await expect(recorder.record({ type: 'agent_end', willRetry: false })).resolves.toBeUndefined()
    await expect(recorder.record({ type: 'agent_end', willRetry: false })).resolves.toBeUndefined()
    expect(calls).toBe(2)
  })

  test('Given authorization identifies a validation call When Bash executes Then validation is marked without recording its command', async () => {
    let now = 6_000
    const events: PiRunAuditTimingEvent[] = []
    const recorder = createPiRunAuditRecorder({
      sessionId: 'session-validation',
      runStartedAt: now,
      now: () => now,
      onTimingEvent: (event) => { events.push(event) },
    })

    await recorder.record({ type: 'authorization_start', toolCallId: 'validation-1', toolName: 'Bash', validation: true })
    now = 6_010
    await recorder.record({ type: 'authorization_end', toolCallId: 'validation-1', toolName: 'Bash', outcome: 'allow', validation: true })
    now = 6_020
    await recorder.record({ type: 'tool_execution_start', toolCallId: 'validation-1', toolName: 'Bash' })
    now = 6_060
    await recorder.record({ type: 'tool_execution_end', toolCallId: 'validation-1', toolName: 'Bash', outcome: 'success' })

    expect(events).toMatchObject([
      { phase: 'tool_wait', validation: true, durationMs: 10 },
      { phase: 'tool_execution', validation: true, durationMs: 40 },
    ])
  })

  test('Given concurrent tools When they finish out of order Then each duration stays isolated and missing starts are not fabricated', async () => {
    let now = 2_000
    const events: PiRunAuditTimingEvent[] = []
    const recorder = createPiRunAuditRecorder({
      sessionId: 'session-tools',
      runStartedAt: now,
      now: () => now,
      onTimingEvent: (event) => { events.push(event) },
    })

    await recorder.record({ type: 'tool_execution_start', toolCallId: 'tool-a', toolName: 'Read' })
    now = 2_010
    await recorder.record({ type: 'tool_execution_start', toolCallId: 'tool-b', toolName: 'Bash' })
    now = 2_030
    await recorder.record({ type: 'tool_execution_end', toolCallId: 'tool-b', toolName: 'Bash', outcome: 'error' })
    now = 2_050
    await recorder.record({ type: 'tool_execution_end', toolCallId: 'tool-a', toolName: 'Read', outcome: 'success' })
    now = 2_060
    await recorder.record({ type: 'tool_execution_end', toolCallId: 'missing', toolName: 'Write', outcome: 'success' })

    expect(events).toMatchObject([
      { phase: 'tool_execution', toolCorrelationId: expect.stringMatching(/^tool:[a-f0-9]{12}$/), toolName: 'Bash', outcome: 'error', durationMs: 20 },
      { phase: 'tool_execution', toolCorrelationId: expect.stringMatching(/^tool:[a-f0-9]{12}$/), toolName: 'Read', outcome: 'success', durationMs: 50 },
    ])
    expect(events[0]?.phase === 'tool_execution' ? events[0].toolCorrelationId : null)
      .not.toBe(events[1]?.phase === 'tool_execution' ? events[1].toolCorrelationId : null)
    expect(JSON.stringify(events)).not.toContain('tool-a')
    expect(JSON.stringify(events)).not.toContain('tool-b')
    expect(JSON.stringify(events)).not.toContain('toolCallId')
  })
})

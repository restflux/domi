import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PiRunTimingQuery } from './pi-run-timing-query.ts'
import { AuditWriter } from './audit-writer.ts'
import { createPiRunAuditRecorder } from './pi-run-audit.ts'
import { capturePiRequestEnvelope } from './pi-request-envelope.ts'

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function auditFile(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'domi-pi-timing-'))
  tempDirs.push(dir)
  const path = join(dir, 'events.jsonl')
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
  return path
}

function record(data: Record<string, unknown>, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    timestamp: data.timestamp,
    category: 'pi_run_timing',
    action: data.phase,
    data,
    ...overrides,
  })
}

describe('PiRunTimingQuery', () => {
  test('builds a completed report with real overlapping offsets and safe summaries', async () => {
    const runStartedAt = 1_000
    const runId = 'session-1:1000'
    const requestId = `${runId}:turn:1:request:1`
    const path = await auditFile([
      record({ phase: 'tool_execution', sessionId: 'other', runStartedAt, timestamp: new Date(1_090).toISOString(), durationMs: 80, toolName: 'secret-other', outcome: 'success', input: 'must-not-leak' }),
      record({
        phase: 'request_envelope', sessionId: 'session-1', runStartedAt, runId, sequence: 1,
        timestamp: new Date(1_000).toISOString(), durationMs: 0, turn: 1,
        turnId: `${runId}:turn:1`, requestOrdinal: 1, requestId,
        envelope: {
          version: 1, capturedAt: 1_000, provider: 'openai-responses', modelId: 'gpt-5.6',
          reasoningLevel: 'xhigh', contextWindow: 272_000, messageCount: 4, toolCount: 2,
          systemPromptHash: `sha256:${'a'.repeat(64)}`, toolSchemaHash: `sha256:${'b'.repeat(64)}`,
          piActiveLeafId: 'leaf-1', controls: { executionPolicy: 'controlled', workflow: 'direct' },
          sessionTarget: { kind: 'isolated', ownership: 'owner', revision: 8 },
        },
      }),
      record({ phase: 'first_token', sessionId: 'session-1', runStartedAt, runId, sequence: 2, timestamp: new Date(1_030).toISOString(), durationMs: 30, runDurationMs: 30, turn: 1 }),
      record({ phase: 'tool_execution', sessionId: 'session-1', runStartedAt, runId, sequence: 5, timestamp: new Date(1_100).toISOString(), durationMs: 80, turn: 1, toolName: 'Read', toolCallId: 'private-id', outcome: 'success', result: 'must-not-leak' }),
      record({ phase: 'tool_execution', sessionId: 'session-1', runStartedAt, runId, sequence: 4, timestamp: new Date(1_080).toISOString(), durationMs: 40, turn: 1, toolName: 'Bash', toolCallId: 'bash-private-id', outcome: 'error', command: 'cat /secret' }),
      record({ phase: 'tool_wait', waitType: 'authorization', sessionId: 'session-1', runStartedAt, runId, sequence: 3, timestamp: new Date(1_060).toISOString(), durationMs: 20, turn: 1, toolName: 'Bash', toolCallId: 'bash-private-id', outcome: 'allow' }),
      record({ phase: 'model_generation', sessionId: 'session-1', runStartedAt, runId, sequence: 6, timestamp: new Date(1_120).toISOString(), durationMs: 120, turn: 1 }),
      record({
        phase: 'compaction', sessionId: 'session-1', runStartedAt, runId, sequence: 7,
        timestamp: new Date(1_145).toISOString(), durationMs: 15,
        attemptId: 'compact-1', stage: 'lifecycle', strategy: 'pi-recent-user-pinned-v1',
        mode: 'enhance', outcome: 'compacted', providerRequestId: 'summary-request-1',
        errorMessage: 'must-not-leak-compaction-error',
      }),
      record({ phase: 'retry', stage: 'backoff', sessionId: 'session-1', runStartedAt, runId, sequence: 8, timestamp: new Date(1_150).toISOString(), durationMs: 30, turn: 1, attempt: 1, delayMs: 30, errorCategory: 'rate_limit' }),
      record({ phase: 'retry', stage: 'attempt', sessionId: 'session-1', runStartedAt, runId, sequence: 9, timestamp: new Date(1_180).toISOString(), durationMs: 30, turn: 1, attempt: 1, outcome: 'succeeded', errorCategory: 'rate_limit' }),
      record({ phase: 'total', sessionId: 'session-1', runStartedAt, runId, sequence: 10, timestamp: new Date(1_200).toISOString(), durationMs: 200 }),
    ])

    const result = await new PiRunTimingQuery({ filePath: path }).query('session-1')

    expect(result).toMatchObject({ status: 'available', tailTruncated: false, corruptLines: 0 })
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0]).toMatchObject({
      runId,
      runStartedAt,
      completed: true,
      totalDurationMs: 200,
      firstTokenMs: 30,
      summary: {
        slowestTool: { toolName: 'Read', durationMs: 80 },
        toolDurationMs: 120,
        authorizationWaitMs: 20,
        retryDurationMs: 60,
        modelGenerationMs: 120,
        retryCount: 1,
      },
    })
    expect(result.runs[0]!.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'model', callId: requestId, turn: 1, sequence: 6, visibility: 'model-visible',
        envelope: expect.objectContaining({
          requestId, turnId: `${runId}:turn:1`, provider: 'openai-responses', modelId: 'gpt-5.6',
          systemPromptHash: `sha256:${'a'.repeat(64)}`, toolSchemaHash: `sha256:${'b'.repeat(64)}`,
          controls: { executionPolicy: 'controlled', workflow: 'direct' },
          sessionTarget: { kind: 'isolated', ownership: 'owner', revision: 8 },
        }),
      }),
      expect.objectContaining({ kind: 'tool', label: 'Read', turn: 1, visibility: 'model-visible', startOffsetMs: 20, endOffsetMs: 100, durationMs: 80, correlationId: expect.stringMatching(/^tool:[a-f0-9]{12}$/) }),
      expect.objectContaining({ kind: 'tool', label: 'Bash', turn: 1, visibility: 'model-visible', startOffsetMs: 40, endOffsetMs: 80, durationMs: 40, outcome: 'error' }),
      expect.objectContaining({ kind: 'authorization', turn: 1, visibility: 'log-only', startOffsetMs: 40, endOffsetMs: 60 }),
      expect.objectContaining({
        kind: 'compaction', label: '上下文压缩', visibility: 'product-state', outcome: 'compacted',
        callId: 'compaction:compact-1:lifecycle:7', startOffsetMs: 130, endOffsetMs: 145,
      }),
      expect.objectContaining({ kind: 'retry_backoff', turn: 1, visibility: 'log-only' }),
    ]))
    expect(result.runs[0]!.spans
      .filter((span) => span.startOffsetMs === 40)
      .map((span) => [span.kind, span.label]))
      .toEqual([['authorization', 'Bash 审批'], ['tool', 'Bash']])
    const retryKinds = result.runs[0]!.spans
      .filter((span) => span.kind === 'retry_backoff' || span.kind === 'retry_attempt')
      .map((span) => span.kind)
    expect(retryKinds).toEqual(['retry_backoff', 'retry_attempt'])
    const serialized = JSON.stringify(result)
    for (const forbidden of ['secret-other', 'must-not-leak', 'must-not-leak-compaction-error', 'private-id', 'bash-private-id', 'cat /secret', 'toolCallId', 'command', 'result']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  test('persists a captured envelope through the real audit writer without storing prompt or tool schema text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'domi-pi-trajectory-'))
    tempDirs.push(dir)
    const writer = new AuditWriter({ auditDir: dir })
    let now = 30_000
    const recorder = createPiRunAuditRecorder({
      sessionId: 'session-writer',
      runStartedAt: now,
      now: () => now,
      onTimingEvent: async (event) => {
        await writer.record({ category: 'pi_run_timing', action: event.phase, timestamp: event.timestamp, data: { ...event } })
      },
    })
    const envelope = capturePiRequestEnvelope({
      capturedAt: now,
      provider: 'deepseek',
      modelId: 'deepseek-chat',
      reasoningLevel: 'high',
      contextWindow: 131_072,
      systemPrompt: 'never persist this private system prompt',
      messageCount: 2,
      tools: [{ name: 'private-tool', description: 'never persist this tool schema', parameters: { type: 'object' } }],
      piActiveLeafId: null,
    })

    await recorder.record({ type: 'turn_start' })
    await recorder.record({ type: 'model_request', envelope })
    now = 30_050
    await recorder.record({ type: 'assistant_end' })
    now = 30_055
    await recorder.record({ type: 'tool_execution_start', toolCallId: 'raw-call-must-not-persist', toolName: 'Read' })
    now = 30_070
    await recorder.record({ type: 'tool_execution_end', toolCallId: 'raw-call-must-not-persist', toolName: 'Read', outcome: 'success' })
    await recorder.record({ type: 'agent_end', willRetry: false })

    const result = await new PiRunTimingQuery({ filePath: writer.filePath }).query('session-writer')
    const rawAudit = await readFile(writer.filePath, 'utf8')

    expect(result.runs[0]!.spans[0]).toMatchObject({
      kind: 'model',
      envelope: expect.objectContaining({ provider: 'deepseek', modelId: 'deepseek-chat' }),
    })
    expect(rawAudit).toContain(envelope.systemPromptHash)
    expect(rawAudit).toContain(envelope.toolSchemaHash)
    expect(rawAudit).not.toContain('never persist this private system prompt')
    expect(rawAudit).not.toContain('never persist this tool schema')
    expect(rawAudit).not.toContain('raw-call-must-not-persist')
    expect(rawAudit).not.toContain('toolCallId')
    expect(rawAudit).toContain('toolCorrelationId')
  })

  test('marks an incomplete, out-of-order and deduplicated run without fabricating completion', async () => {
    const runStartedAt = 5_000
    const tool = record({ phase: 'tool_execution', sessionId: 'session-2', runStartedAt, timestamp: new Date(5_090).toISOString(), durationMs: 40, toolName: 'Read\n../../secret', outcome: 'success' })
    const path = await auditFile([
      record({ phase: 'model_generation', sessionId: 'session-2', runStartedAt, timestamp: new Date(5_120).toISOString(), durationMs: 100, turn: 1 }),
      tool,
      tool,
      '{broken',
    ])

    const result = await new PiRunTimingQuery({ filePath: path }).query('session-2')

    expect(result).toMatchObject({ status: 'available', corruptLines: 1 })
    expect(result.runs[0]).toMatchObject({ completed: false, totalDurationMs: 120, evidenceIncomplete: true })
    expect(result.runs[0]!.spans.filter((span) => span.kind === 'tool')).toHaveLength(1)
    expect(result.runs[0]!.spans.find((span) => span.kind === 'tool')?.label).toBe('Read ../../secret')
  })

  test('reads only a bounded tail, caps events and isolates recent runs for the requested session', async () => {
    const lines = Array.from({ length: 200 }, (_, index) => record({
      phase: 'tool_execution',
      sessionId: index > 195 ? 'wanted' : 'noise',
      runStartedAt: 10_000 + index,
      timestamp: new Date(10_100 + index).toISOString(),
      durationMs: 10,
      toolName: `Tool-${index}`,
      outcome: 'success',
    }))
    const path = await auditFile(lines)
    const result = await new PiRunTimingQuery({ filePath: path, maxBytes: 2_000, maxEvents: 2, maxRuns: 1 }).query('wanted')

    expect(result.status).toBe('available')
    expect(result.tailTruncated).toBe(true)
    expect(result.eventLimitReached).toBe(true)
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0]!.evidenceIncomplete).toBe(true)
  })

  test('preserves every provider request when multiple envelopes share one turn and only the latest has generation timing', async () => {
    const runStartedAt = 40_000
    const runId = 'session-multi-request:40000'
    const envelope = (requestOrdinal: number, capturedAt: number) => record({
      phase: 'request_envelope', sessionId: 'session-multi-request', runStartedAt, runId, sequence: requestOrdinal,
      timestamp: new Date(capturedAt).toISOString(), durationMs: 0, turn: 1,
      turnId: `${runId}:turn:1`, requestOrdinal, requestId: `${runId}:turn:1:request:${requestOrdinal}`,
      envelope: {
        version: 1, capturedAt, provider: 'openai-responses', modelId: 'gpt-5.6', reasoningLevel: 'xhigh',
        contextWindow: 272_000, messageCount: requestOrdinal, toolCount: 1,
        systemPromptHash: `sha256:${'a'.repeat(64)}`, toolSchemaHash: `sha256:${'b'.repeat(64)}`, piActiveLeafId: null,
      },
    })
    const path = await auditFile([
      envelope(1, runStartedAt),
      envelope(2, runStartedAt + 5),
      record({ phase: 'model_generation', sessionId: 'session-multi-request', runStartedAt, runId, sequence: 3, timestamp: new Date(runStartedAt + 50).toISOString(), durationMs: 45, turn: 1 }),
      record({ phase: 'total', sessionId: 'session-multi-request', runStartedAt, runId, sequence: 4, timestamp: new Date(runStartedAt + 50).toISOString(), durationMs: 50 }),
    ])

    const result = await new PiRunTimingQuery({ filePath: path }).query('session-multi-request')
    const modelCalls = result.runs[0]!.spans.filter((span) => span.kind === 'model')

    expect(modelCalls).toHaveLength(2)
    expect(modelCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ callId: `${runId}:turn:1:request:1`, durationMs: 0, envelope: expect.objectContaining({ requestOrdinal: 1 }) }),
      expect.objectContaining({ callId: `${runId}:turn:1:request:2`, durationMs: 45, envelope: expect.objectContaining({ requestOrdinal: 2 }) }),
    ]))
  })

  test('ignores a malformed optional envelope while preserving safe legacy timing spans', async () => {
    const runStartedAt = 20_000
    const runId = 'session-malformed:20000'
    const path = await auditFile([
      record({
        phase: 'request_envelope', sessionId: 'session-malformed', runStartedAt, runId, sequence: 1,
        timestamp: new Date(runStartedAt).toISOString(), durationMs: 0, turn: 1,
        turnId: `${runId}:turn:1`, requestOrdinal: 1, requestId: `${runId}:turn:1:request:1`,
        envelope: { version: 1, capturedAt: runStartedAt, provider: 'openai', modelId: 'gpt', reasoningLevel: 'high', messageCount: 1, toolCount: 0, systemPromptHash: 'raw private prompt', toolSchemaHash: `sha256:${'b'.repeat(64)}`, piActiveLeafId: null },
      }),
      record({ phase: 'model_generation', sessionId: 'session-malformed', runStartedAt, runId, sequence: 2, timestamp: new Date(runStartedAt + 50).toISOString(), durationMs: 50, turn: 1 }),
      record({ phase: 'total', sessionId: 'session-malformed', runStartedAt, runId, sequence: 3, timestamp: new Date(runStartedAt + 50).toISOString(), durationMs: 50 }),
    ])

    const result = await new PiRunTimingQuery({ filePath: path }).query('session-malformed')

    expect(result.status).toBe('available')
    expect(result.runs[0]!.spans).toEqual([
      expect.objectContaining({ kind: 'model', turn: 1, visibility: 'model-visible' }),
    ])
    expect(result.runs[0]!.spans[0]).not.toHaveProperty('envelope')
    expect(JSON.stringify(result)).not.toContain('raw private prompt')
  })

  test('returns empty for no matching evidence and unavailable for read failures', async () => {
    const path = await auditFile([record({ phase: 'total', sessionId: 'other', runStartedAt: 1, timestamp: new Date(2).toISOString(), durationMs: 1 })])
    expect(await new PiRunTimingQuery({ filePath: path }).query('missing')).toMatchObject({ status: 'empty', runs: [] })
    expect(await new PiRunTimingQuery({ filePath: `${path}.missing` }).query('missing')).toEqual({
      status: 'empty', runs: [], tailTruncated: false, eventLimitReached: false, corruptLines: 0,
    })
    expect(await new PiRunTimingQuery({ filePath: tempDirs[0]! }).query('missing')).toMatchObject({ status: 'unavailable', runs: [] })
  })
})

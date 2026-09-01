import type {
  PiRequestEnvelopeView,
  PiRunTimingRunView,
  PiRunTimingSpanView,
} from '@domi/shared'

export interface SafePiTrajectoryEvent {
  phase: 'request_envelope' | 'first_token' | 'model_generation' | 'tool_wait' | 'tool_execution' | 'retry' | 'compaction' | 'total'
  sessionId: string
  runStartedAt: number
  runId?: string
  timestampMs: number
  durationMs: number
  sourceOrder: number
  sequence?: number
  turn?: number
  runDurationMs?: number
  correlationId?: string
  toolName?: string
  outcome?: PiRunTimingSpanView['outcome']
  validation?: true
  stage?: 'backoff' | 'attempt'
  attempt?: number
  compactionAttemptId?: string
  compactionStage?: 'preflight' | 'provider_projection' | 'lifecycle'
  envelope?: PiRequestEnvelopeView
}

function eventIdentity(event: SafePiTrajectoryEvent): string {
  const { sourceOrder: _sourceOrder, ...stable } = event
  return JSON.stringify(stable)
}

function effectiveSequence(event: SafePiTrajectoryEvent): number {
  return event.sequence ?? event.sourceOrder
}

function envelopeForModel(
  event: SafePiTrajectoryEvent,
  envelopesByTurn: Map<number, SafePiTrajectoryEvent[]>,
): PiRequestEnvelopeView | undefined {
  if (event.turn === undefined) return undefined
  const candidates = envelopesByTurn.get(event.turn) ?? []
  const sequence = effectiveSequence(event)
  return [...candidates]
    .filter((candidate) => effectiveSequence(candidate) <= sequence)
    .sort((left, right) => effectiveSequence(right) - effectiveSequence(left))[0]?.envelope
    ?? candidates[0]?.envelope
}

function spanFromEvent(
  event: SafePiTrajectoryEvent,
  envelopesByTurn: Map<number, SafePiTrajectoryEvent[]>,
): PiRunTimingSpanView | null {
  if (event.phase === 'request_envelope' || event.phase === 'first_token' || event.phase === 'total') return null
  const endOffsetMs = Math.max(0, event.timestampMs - event.runStartedAt)
  const startOffsetMs = Math.max(0, endOffsetMs - event.durationMs)
  const sequence = effectiveSequence(event)
  const turn = event.turn

  if (event.phase === 'model_generation') {
    const envelope = envelopeForModel(event, envelopesByTurn)
    return {
      kind: 'model',
      label: '模型生成',
      startOffsetMs,
      endOffsetMs,
      durationMs: event.durationMs,
      callId: envelope?.requestId ?? `model:${turn ?? 'unknown'}:${sequence}`,
      ...(turn !== undefined && { turn }),
      sequence,
      visibility: 'model-visible',
      ...(envelope && { envelope }),
    }
  }

  if (event.phase === 'tool_wait') {
    const correlationId = event.correlationId
    return {
      kind: 'authorization',
      label: `${event.toolName} 审批`,
      startOffsetMs,
      endOffsetMs,
      durationMs: event.durationMs,
      callId: `authorization:${correlationId ?? 'unknown'}:${sequence}`,
      ...(correlationId && { correlationId }),
      ...(turn !== undefined && { turn }),
      sequence,
      visibility: 'log-only',
      outcome: event.outcome,
      ...(event.validation && { validation: true }),
    }
  }

  if (event.phase === 'tool_execution') {
    const correlationId = event.correlationId
    return {
      kind: 'tool',
      label: event.toolName!,
      startOffsetMs,
      endOffsetMs,
      durationMs: event.durationMs,
      callId: `tool:${correlationId ?? 'unknown'}:${sequence}`,
      ...(correlationId && { correlationId }),
      ...(turn !== undefined && { turn }),
      sequence,
      visibility: 'model-visible',
      outcome: event.outcome,
      ...(event.validation && { validation: true }),
    }
  }

  if (event.phase === 'compaction') {
    const stage = event.compactionStage ?? 'lifecycle'
    return {
      kind: 'compaction',
      label: stage === 'preflight' ? '压缩预检' : stage === 'provider_projection' ? '压缩上下文投影' : '上下文压缩',
      startOffsetMs,
      endOffsetMs,
      durationMs: event.durationMs,
      callId: `compaction:${event.compactionAttemptId ?? 'unknown'}:${stage}:${sequence}`,
      ...(turn !== undefined && { turn }),
      sequence,
      visibility: 'product-state',
      ...(event.outcome && { outcome: event.outcome }),
    }
  }

  return {
    kind: event.stage === 'backoff' ? 'retry_backoff' : 'retry_attempt',
    label: event.stage === 'backoff' ? `重试等待 #${event.attempt}` : `重试尝试 #${event.attempt}`,
    startOffsetMs,
    endOffsetMs,
    durationMs: event.durationMs,
    callId: `retry:${event.stage}:${event.attempt}:${sequence}`,
    ...(turn !== undefined && { turn }),
    sequence,
    visibility: 'log-only',
    ...(event.outcome && { outcome: event.outcome }),
  }
}

/**
 * 从已经严格解析、去载荷的 main-owned 事件构建 Renderer 轨迹投影。
 * 输入在 query parser 中已把 legacy raw toolCallId 收敛为不可逆 correlation ID。
 */
export function projectAgentTrajectoryRun(
  events: SafePiTrajectoryEvent[],
  evidenceIncomplete: boolean,
): PiRunTimingRunView {
  const unique = [...new Map(events.map((event) => [eventIdentity(event), event])).values()]
  const total = unique
    .filter((event) => event.phase === 'total')
    .sort((left, right) => right.timestampMs - left.timestampMs)[0]
  const envelopesByTurn = new Map<number, SafePiTrajectoryEvent[]>()
  for (const event of unique) {
    if (event.phase !== 'request_envelope' || event.turn === undefined || !event.envelope) continue
    const group = envelopesByTurn.get(event.turn) ?? []
    group.push(event)
    envelopesByTurn.set(event.turn, group)
  }
  const projectedSpans = unique
    .map((event) => spanFromEvent(event, envelopesByTurn))
    .filter((span): span is PiRunTimingSpanView => span !== null)
  const matchedRequestIds = new Set(projectedSpans.flatMap((span) => span.envelope ? [span.envelope.requestId] : []))
  const unmatchedRequestSpans = unique.flatMap((event): PiRunTimingSpanView[] => {
    if (event.phase !== 'request_envelope' || !event.envelope || matchedRequestIds.has(event.envelope.requestId)) return []
    const offsetMs = Math.max(0, event.envelope.capturedAt - event.runStartedAt)
    return [{
      kind: 'model',
      label: '模型请求',
      startOffsetMs: offsetMs,
      endOffsetMs: offsetMs,
      durationMs: 0,
      callId: event.envelope.requestId,
      turn: event.envelope.turn,
      sequence: effectiveSequence(event),
      visibility: 'model-visible',
      envelope: event.envelope,
    }]
  })
  const spans = [...projectedSpans, ...unmatchedRequestSpans]
    .sort((left, right) => left.startOffsetMs - right.startOffsetMs
      || (left.sequence ?? 0) - (right.sequence ?? 0)
      || left.endOffsetMs - right.endOffsetMs
      || left.label.localeCompare(right.label))
  const observedDurationMs = Math.max(0, ...unique.map((event) => Math.max(event.timestampMs - event.runStartedAt, event.durationMs)))
  const firstTokens = unique.filter((event) => event.phase === 'first_token' && event.runDurationMs !== undefined)
  const tools = spans.filter((span) => span.kind === 'tool')
  const slowestTool = [...tools].sort((left, right) => right.durationMs - left.durationMs || left.label.localeCompare(right.label))[0]
  const retryAttempts = new Set(unique.filter((event) => event.phase === 'retry').map((event) => event.attempt))
  const first = unique[0]!

  return {
    runId: unique.find((event) => event.runId)?.runId ?? `${first.sessionId}:${first.runStartedAt}`,
    runStartedAt: first.runStartedAt,
    completed: Boolean(total),
    evidenceIncomplete: evidenceIncomplete || !total,
    totalDurationMs: total?.durationMs ?? observedDurationMs,
    firstTokenMs: firstTokens.length > 0 ? Math.min(...firstTokens.map((event) => event.runDurationMs!)) : null,
    spans,
    summary: {
      slowestTool: slowestTool ? { toolName: slowestTool.label, durationMs: slowestTool.durationMs } : null,
      toolDurationMs: tools.reduce((sum, span) => sum + span.durationMs, 0),
      authorizationWaitMs: spans.filter((span) => span.kind === 'authorization').reduce((sum, span) => sum + span.durationMs, 0),
      retryDurationMs: spans.filter((span) => span.kind === 'retry_backoff' || span.kind === 'retry_attempt').reduce((sum, span) => sum + span.durationMs, 0),
      modelGenerationMs: spans.filter((span) => span.kind === 'model').reduce((sum, span) => sum + span.durationMs, 0),
      retryCount: retryAttempts.size,
    },
  }
}

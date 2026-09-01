import { createHash } from 'node:crypto'
import type { PiRequestEnvelopeSnapshot } from './pi-request-envelope.ts'

export interface PiRunAuditTimingContext {
  sessionId: string
  workspaceId?: string
  runStartedAt: number
}

export type PiRetryErrorCategory =
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'authentication'
  | 'context_length'
  | 'server'
  | 'unknown'

interface PiRunAuditTimingBase extends PiRunAuditTimingContext {
  phase: 'request_envelope' | 'first_token' | 'model_generation' | 'tool_wait' | 'tool_execution' | 'retry' | 'compaction' | 'total'
  timestamp: string
  durationMs: number
  runId: string
  sequence: number
}

export interface PiRunRequestEnvelopeTimingEvent extends PiRunAuditTimingBase {
  phase: 'request_envelope'
  turn: number
  turnId: string
  requestOrdinal: number
  requestId: string
  envelope: PiRequestEnvelopeSnapshot
}

export interface PiRunTurnTimingEvent extends PiRunAuditTimingBase {
  phase: 'first_token' | 'model_generation'
  turn: number
  /** 仅 first_token：从宿主收到本轮请求到首 token 的端到端耗时。 */
  runDurationMs?: number
}

export interface PiRunToolWaitTimingEvent extends PiRunAuditTimingBase {
  phase: 'tool_wait'
  waitType: 'authorization'
  toolCorrelationId: string
  toolName: string
  outcome: 'allow' | 'deny' | 'error'
  turn?: number
  validation?: true
}

export interface PiRunToolExecutionTimingEvent extends PiRunAuditTimingBase {
  phase: 'tool_execution'
  toolCorrelationId: string
  toolName: string
  outcome: 'success' | 'error'
  turn?: number
  validation?: true
}

export interface PiRunRetryTimingEvent extends PiRunAuditTimingBase {
  phase: 'retry'
  stage: 'backoff' | 'attempt'
  attempt: number
  errorCategory: PiRetryErrorCategory
  turn?: number
  delayMs?: number
  outcome?: 'succeeded' | 'exhausted' | 'cancelled'
}

export interface PiRunCompactionTimingEvent extends PiRunAuditTimingBase {
  phase: 'compaction'
  attemptId: string
  stage: 'preflight' | 'provider_projection' | 'lifecycle'
  strategy: string
  mode: 'observe' | 'enhance'
  outcome: 'enhanced' | 'observed' | 'not_applicable' | 'fallback' | 'fallback_validation' | 'cancelled' | 'failed' | 'compacted' | 'aborted'
  reason?: 'manual' | 'threshold' | 'overflow'
  willRetry?: boolean
  inline?: boolean
  splitTurn?: boolean
  errorCode?: string
  factKey?: string
  ruleId?: string
  failureCategory?: string
  stateFingerprint?: string
  recentUserCount?: number
  recentUserTokens?: number
  pinnedFactCount?: number
  pinnedFactTokens?: number
  totalEnhancementTokens?: number
  summaryInputTokens?: number
  summaryOutputTokens?: number
  compactionEntryId?: string
  providerRequestId?: string
}

export interface PiRunTotalTimingEvent extends PiRunAuditTimingBase {
  phase: 'total'
}

export type PiRunAuditTimingEvent =
  | PiRunRequestEnvelopeTimingEvent
  | PiRunTurnTimingEvent
  | PiRunToolWaitTimingEvent
  | PiRunToolExecutionTimingEvent
  | PiRunRetryTimingEvent
  | PiRunCompactionTimingEvent
  | PiRunTotalTimingEvent

export type PiRunAuditSourceEvent =
  | { type: 'turn_start' }
  | { type: 'model_request'; envelope: PiRequestEnvelopeSnapshot }
  | { type: 'assistant_update' }
  | { type: 'assistant_end' }
  | { type: 'authorization_start'; toolCallId: string; toolName: string; validation?: true }
  | { type: 'authorization_end'; toolCallId: string; toolName: string; outcome: 'allow' | 'deny' | 'error'; validation?: true }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; outcome: 'success' | 'error' }
  | { type: 'retry_scheduled'; attempt: number; delayMs: number; errorMessage?: string }
  | { type: 'retry_attempt_start'; attempt: number }
  | { type: 'retry_end'; attempt: number; outcome: 'succeeded' | 'exhausted' | 'cancelled'; errorMessage?: string }
  | {
      type: 'compaction'
      attemptId: string
      stage: PiRunCompactionTimingEvent['stage']
      strategy: string
      mode: PiRunCompactionTimingEvent['mode']
      outcome: PiRunCompactionTimingEvent['outcome']
      durationMs: number
      reason?: PiRunCompactionTimingEvent['reason']
      willRetry?: boolean
      inline?: boolean
      splitTurn?: boolean
      errorCode?: string
      errorMessage?: string
      factKey?: string
      ruleId?: string
      failureCategory?: string
      stateFingerprint?: string
      recentUserCount?: number
      recentUserTokens?: number
      pinnedFactCount?: number
      pinnedFactTokens?: number
      totalEnhancementTokens?: number
      summaryInputTokens?: number
      summaryOutputTokens?: number
      compactionEntryId?: string
      providerRequestId?: string
    }
  | { type: 'agent_end'; willRetry: boolean }

export type PiRunAuditTimingCallback = (
  event: PiRunAuditTimingEvent,
) => void | Promise<void>

export interface PiRunAuditRecorder {
  record(event: PiRunAuditSourceEvent): Promise<void>
}

export interface PiRunAuditRecorderOptions extends PiRunAuditTimingContext {
  onTimingEvent?: PiRunAuditTimingCallback
  now?: () => number
}

function toolCorrelationId(toolCallId: string): string {
  return `tool:${createHash('sha256').update(toolCallId, 'utf8').digest('hex').slice(0, 12)}`
}

export function classifyPiRetryError(message: string | undefined): PiRetryErrorCategory {
  if (!message) return 'unknown'
  if (/\b(?:429|rate.?limit|too many requests)\b/i.test(message)) return 'rate_limit'
  if (/\b(?:timeout|timed out|etimedout)\b/i.test(message)) return 'timeout'
  if (/\b(?:401|403|unauthorized|forbidden|authentication)\b/i.test(message)) return 'authentication'
  if (/\b(?:context length|context window|prompt too long)\b/i.test(message)) return 'context_length'
  if (/\b(?:5\d\d|server error|overloaded)\b/i.test(message)) return 'server'
  if (/\b(?:network|econnreset|econnrefused|enotfound|fetch failed)\b/i.test(message)) return 'network'
  return 'unknown'
}

/**
 * 汇总一次 Pi run 的逐轮耗时。写入 callback 始终 best-effort，失败不会反向改变 Agent run。
 */
export function createPiRunAuditRecorder(options: PiRunAuditRecorderOptions): PiRunAuditRecorder {
  const now = options.now ?? Date.now
  const runId = `${options.sessionId}:${options.runStartedAt}`
  let sequence = 0
  let turn = 0
  let requestOrdinal = 0
  let turnStartedAt: number | undefined
  let firstTokenRecorded = false
  const authorizationStarts = new Map<string, number>()
  const validationCalls = new Set<string>()
  const toolStarts = new Map<string, number>()
  const retrySchedules = new Map<number, { startedAt: number; delayMs: number; errorCategory: PiRetryErrorCategory; targetTurn: number }>()
  const retryAttempts = new Map<number, { startedAt: number; errorCategory: PiRetryErrorCategory; targetTurn: number }>()
  let writeQueue = Promise.resolve()

  type EventWithoutRunIdentity<T> = T extends PiRunAuditTimingEvent ? Omit<T, 'runId' | 'sequence'> : never
  const emit = (event: EventWithoutRunIdentity<PiRunAuditTimingEvent>): Promise<void> => {
    if (!options.onTimingEvent) return Promise.resolve()
    const enriched = { ...event, runId, sequence: ++sequence } as PiRunAuditTimingEvent
    writeQueue = writeQueue
      .then(() => options.onTimingEvent?.(enriched))
      .then(() => undefined)
      .catch(() => undefined)
    return writeQueue
  }

  return {
    record(event) {
      const timestamp = now()
      if (event.type === 'turn_start') {
        turn += 1
        requestOrdinal = 0
        turnStartedAt = timestamp
        firstTokenRecorded = false
        return Promise.resolve()
      }
      if (event.type === 'model_request') {
        if (turn === 0) {
          turn = 1
          turnStartedAt = event.envelope.capturedAt
          firstTokenRecorded = false
        }
        requestOrdinal += 1
        const turnId = `${runId}:turn:${turn}`
        const envelope: PiRequestEnvelopeSnapshot = {
          ...event.envelope,
          ...(event.envelope.controls && { controls: { ...event.envelope.controls } }),
          ...(event.envelope.sessionTarget && { sessionTarget: { ...event.envelope.sessionTarget } }),
        }
        return emit({
          phase: 'request_envelope',
          sessionId: options.sessionId,
          ...(options.workspaceId && { workspaceId: options.workspaceId }),
          runStartedAt: options.runStartedAt,
          timestamp: new Date(envelope.capturedAt).toISOString(),
          durationMs: 0,
          turn,
          turnId,
          requestOrdinal,
          requestId: `${turnId}:request:${requestOrdinal}`,
          envelope,
        })
      }
      if (event.type === 'compaction') {
        return emit({
          phase: 'compaction',
          sessionId: options.sessionId,
          ...(options.workspaceId && { workspaceId: options.workspaceId }),
          runStartedAt: options.runStartedAt,
          timestamp: new Date(timestamp).toISOString(),
          durationMs: Math.max(0, event.durationMs),
          attemptId: event.attemptId,
          stage: event.stage,
          strategy: event.strategy,
          mode: event.mode,
          outcome: event.outcome,
          ...(event.reason && { reason: event.reason }),
          ...(event.willRetry !== undefined && { willRetry: event.willRetry }),
          ...(event.inline !== undefined && { inline: event.inline }),
          ...(event.splitTurn !== undefined && { splitTurn: event.splitTurn }),
          ...(event.errorCode && { errorCode: event.errorCode }),
          ...(event.factKey && { factKey: event.factKey }),
          ...(event.ruleId && { ruleId: event.ruleId }),
          ...(event.failureCategory && { failureCategory: event.failureCategory }),
          ...(event.stateFingerprint && { stateFingerprint: event.stateFingerprint }),
          // Raw exception text can contain paths, provider payload fragments, or host-state details.
          // Compaction audit persists only the stable errorCode, matching retry telemetry hygiene.
          ...(event.recentUserCount !== undefined && { recentUserCount: event.recentUserCount }),
          ...(event.recentUserTokens !== undefined && { recentUserTokens: event.recentUserTokens }),
          ...(event.pinnedFactCount !== undefined && { pinnedFactCount: event.pinnedFactCount }),
          ...(event.pinnedFactTokens !== undefined && { pinnedFactTokens: event.pinnedFactTokens }),
          ...(event.totalEnhancementTokens !== undefined && { totalEnhancementTokens: event.totalEnhancementTokens }),
          ...(event.summaryInputTokens !== undefined && { summaryInputTokens: event.summaryInputTokens }),
          ...(event.summaryOutputTokens !== undefined && { summaryOutputTokens: event.summaryOutputTokens }),
          ...(event.compactionEntryId && { compactionEntryId: event.compactionEntryId }),
          ...(event.providerRequestId && { providerRequestId: event.providerRequestId }),
        })
      }
      if (event.type === 'assistant_update') {
        if (turnStartedAt === undefined || firstTokenRecorded) return Promise.resolve()
        firstTokenRecorded = true
        return emit({
          phase: 'first_token',
          sessionId: options.sessionId,
          ...(options.workspaceId && { workspaceId: options.workspaceId }),
          runStartedAt: options.runStartedAt,
          timestamp: new Date(timestamp).toISOString(),
          durationMs: Math.max(0, timestamp - turnStartedAt),
          runDurationMs: Math.max(0, timestamp - options.runStartedAt),
          turn,
        })
      }
      if (event.type === 'assistant_end') {
        if (turnStartedAt === undefined) return Promise.resolve()
        const startedAt = turnStartedAt
        turnStartedAt = undefined
        return emit({
          phase: 'model_generation',
          sessionId: options.sessionId,
          ...(options.workspaceId && { workspaceId: options.workspaceId }),
          runStartedAt: options.runStartedAt,
          timestamp: new Date(timestamp).toISOString(),
          durationMs: Math.max(0, timestamp - startedAt),
          turn,
        })
      }
      if (event.type === 'authorization_start') {
        authorizationStarts.set(event.toolCallId, timestamp)
        if (event.validation) validationCalls.add(event.toolCallId)
        return Promise.resolve()
      }
      if (event.type === 'authorization_end') {
        const startedAt = authorizationStarts.get(event.toolCallId)
        authorizationStarts.delete(event.toolCallId)
        const validation = event.validation || validationCalls.has(event.toolCallId)
        if (event.outcome !== 'allow') validationCalls.delete(event.toolCallId)
        if (startedAt === undefined) return Promise.resolve()
        return emit({
          phase: 'tool_wait',
          waitType: 'authorization',
          sessionId: options.sessionId,
          ...(options.workspaceId && { workspaceId: options.workspaceId }),
          runStartedAt: options.runStartedAt,
          timestamp: new Date(timestamp).toISOString(),
          durationMs: Math.max(0, timestamp - startedAt),
          toolCorrelationId: toolCorrelationId(event.toolCallId),
          toolName: event.toolName,
          outcome: event.outcome,
          ...(turn > 0 && { turn }),
          ...(validation && { validation: true }),
        })
      }
      if (event.type === 'tool_execution_start') {
        toolStarts.set(event.toolCallId, timestamp)
        return Promise.resolve()
      }
      if (event.type === 'tool_execution_end') {
        const startedAt = toolStarts.get(event.toolCallId)
        toolStarts.delete(event.toolCallId)
        const validation = validationCalls.delete(event.toolCallId)
        if (startedAt === undefined) return Promise.resolve()
        return emit({
          phase: 'tool_execution',
          sessionId: options.sessionId,
          ...(options.workspaceId && { workspaceId: options.workspaceId }),
          runStartedAt: options.runStartedAt,
          timestamp: new Date(timestamp).toISOString(),
          durationMs: Math.max(0, timestamp - startedAt),
          toolCorrelationId: toolCorrelationId(event.toolCallId),
          toolName: event.toolName,
          outcome: event.outcome,
          ...(turn > 0 && { turn }),
          ...(validation && { validation: true }),
        })
      }
      if (event.type === 'retry_scheduled') {
        retrySchedules.set(event.attempt, {
          startedAt: timestamp,
          delayMs: Math.max(0, event.delayMs),
          errorCategory: classifyPiRetryError(event.errorMessage),
          targetTurn: Math.max(1, turn + 1),
        })
        return Promise.resolve()
      }
      if (event.type === 'retry_attempt_start') {
        const scheduled = retrySchedules.get(event.attempt)
        retrySchedules.delete(event.attempt)
        if (!scheduled) return Promise.resolve()
        const targetTurn = Math.max(scheduled.targetTurn, turn)
        retryAttempts.set(event.attempt, { startedAt: timestamp, errorCategory: scheduled.errorCategory, targetTurn })
        return emit({
          phase: 'retry',
          stage: 'backoff',
          sessionId: options.sessionId,
          ...(options.workspaceId && { workspaceId: options.workspaceId }),
          runStartedAt: options.runStartedAt,
          timestamp: new Date(timestamp).toISOString(),
          durationMs: Math.max(0, timestamp - scheduled.startedAt),
          attempt: event.attempt,
          turn: targetTurn,
          delayMs: scheduled.delayMs,
          errorCategory: scheduled.errorCategory,
        })
      }
      if (event.type === 'retry_end') {
        const attempt = retryAttempts.get(event.attempt)
        retryAttempts.delete(event.attempt)
        if (!attempt) return Promise.resolve()
        return emit({
          phase: 'retry',
          stage: 'attempt',
          sessionId: options.sessionId,
          ...(options.workspaceId && { workspaceId: options.workspaceId }),
          runStartedAt: options.runStartedAt,
          timestamp: new Date(timestamp).toISOString(),
          durationMs: Math.max(0, timestamp - attempt.startedAt),
          attempt: event.attempt,
          turn: attempt.targetTurn,
          errorCategory: attempt.errorCategory === 'unknown'
            ? classifyPiRetryError(event.errorMessage)
            : attempt.errorCategory,
          outcome: event.outcome,
        })
      }
      if (event.willRetry) return Promise.resolve()
      return emit({
        phase: 'total',
        sessionId: options.sessionId,
        ...(options.workspaceId && { workspaceId: options.workspaceId }),
        runStartedAt: options.runStartedAt,
        timestamp: new Date(timestamp).toISOString(),
        durationMs: Math.max(0, timestamp - options.runStartedAt),
      })
    },
  }
}

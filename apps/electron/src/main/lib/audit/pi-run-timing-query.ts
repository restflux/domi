import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type {
  AgentWorkflow,
  ExecutionPolicyMode,
  PiRequestEnvelopeView,
  PiRunTimingReportView,
} from '@domi/shared'
import {
  projectAgentTrajectoryRun,
  type SafePiTrajectoryEvent,
} from './agent-trajectory-projection.ts'

const DEFAULT_MAX_BYTES = 512 * 1024
const DEFAULT_MAX_EVENTS = 2_000
const DEFAULT_MAX_RUNS = 3
const MAX_TOOL_NAME_CHARS = 120
const MAX_ID_CHARS = 512
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/
const TOOL_CORRELATION_PATTERN = /^tool:[a-f0-9]{12}$/

interface QueryOptions {
  filePath: string
  maxBytes?: number
  maxEvents?: number
  maxRuns?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum
}

function safeLabel(value: unknown, maxChars = MAX_TOOL_NAME_CHARS): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return normalized.slice(0, maxChars)
}

function safeOpaqueId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS ? value : undefined
}

function safeHash(value: unknown): string | undefined {
  return typeof value === 'string' && SHA256_PATTERN.test(value) ? value : undefined
}

function parseToolCorrelation(data: Record<string, unknown>): string | undefined {
  if (typeof data.toolCorrelationId === 'string' && TOOL_CORRELATION_PATTERN.test(data.toolCorrelationId)) {
    return data.toolCorrelationId
  }
  const legacyToolCallId = safeOpaqueId(data.toolCallId)
  return legacyToolCallId
    ? `tool:${createHash('sha256').update(legacyToolCallId, 'utf8').digest('hex').slice(0, 12)}`
    : undefined
}

function parseControls(value: unknown): PiRequestEnvelopeView['controls'] | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  const executionPolicy = value.executionPolicy
  const workflow = value.workflow
  if (!['controlled', 'autonomous', 'full-access'].includes(String(executionPolicy))) return null
  if (!['direct', 'read-only', 'plan-first'].includes(String(workflow))) return null
  return {
    executionPolicy: executionPolicy as ExecutionPolicyMode,
    workflow: workflow as AgentWorkflow,
  }
}

function parseSessionTarget(value: unknown): PiRequestEnvelopeView['sessionTarget'] | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value)) return null
  if (value.kind !== 'local' && value.kind !== 'isolated') return null
  if (value.ownership !== 'owner' && value.ownership !== 'inherited') return null
  if (value.revision !== undefined && !safeInteger(value.revision)) return null
  return {
    kind: value.kind,
    ownership: value.ownership,
    ...(value.revision !== undefined && { revision: value.revision as number }),
  }
}

function parseEnvelope(
  value: unknown,
  identity: { requestId: string; runId: string; turnId: string; turn: number; requestOrdinal: number },
): PiRequestEnvelopeView | null {
  if (!isRecord(value) || value.version !== 1) return null
  const provider = safeLabel(value.provider, 200)
  const modelId = safeLabel(value.modelId, 200)
  const reasoningLevel = safeLabel(value.reasoningLevel, 80)
  const systemPromptHash = safeHash(value.systemPromptHash)
  const toolSchemaHash = safeHash(value.toolSchemaHash)
  if (
    !safeInteger(value.capturedAt)
    || !provider
    || !modelId
    || !reasoningLevel
    || !safeInteger(value.messageCount)
    || !safeInteger(value.toolCount)
    || !systemPromptHash
    || !toolSchemaHash
  ) return null
  if (value.contextWindow !== undefined && !safeInteger(value.contextWindow, 1)) return null
  if (value.piActiveLeafId !== null && value.piActiveLeafId !== undefined && !safeOpaqueId(value.piActiveLeafId)) return null
  const controls = parseControls(value.controls)
  const sessionTarget = parseSessionTarget(value.sessionTarget)
  if (controls === null || sessionTarget === null) return null

  return {
    version: 1,
    ...identity,
    capturedAt: value.capturedAt as number,
    provider,
    modelId,
    reasoningLevel,
    ...(value.contextWindow !== undefined && { contextWindow: value.contextWindow as number }),
    messageCount: value.messageCount as number,
    toolCount: value.toolCount as number,
    systemPromptHash,
    toolSchemaHash,
    piActiveLeafId: typeof value.piActiveLeafId === 'string' ? value.piActiveLeafId : null,
    ...(controls && { controls }),
    ...(sessionTarget && { sessionTarget }),
  }
}

function parseEvent(value: unknown): SafePiTrajectoryEvent | null {
  if (!isRecord(value) || value.version !== 1 || value.category !== 'pi_run_timing' || !isRecord(value.data)) return null
  const data = value.data
  if (
    typeof data.sessionId !== 'string'
    || !data.sessionId.trim()
    || !safeInteger(data.runStartedAt)
    || typeof data.timestamp !== 'string'
    || !finiteNonNegative(data.durationMs)
  ) return null
  const timestampMs = Date.parse(data.timestamp)
  if (!Number.isFinite(timestampMs)) return null
  const runId = safeOpaqueId(data.runId)
  const sequence = data.sequence === undefined ? undefined : safeInteger(data.sequence, 1) ? data.sequence as number : null
  const turn = data.turn === undefined ? undefined : safeInteger(data.turn, 1) ? data.turn as number : null
  if (sequence === null || turn === null) return null
  const base = {
    sessionId: data.sessionId,
    runStartedAt: data.runStartedAt as number,
    ...(runId && { runId }),
    timestampMs,
    durationMs: data.durationMs,
    sourceOrder: 0,
    ...(sequence !== undefined && { sequence }),
    ...(turn !== undefined && { turn }),
  }

  if (data.phase === 'request_envelope') {
    const requestId = safeOpaqueId(data.requestId)
    const turnId = safeOpaqueId(data.turnId)
    if (!runId || sequence === undefined || turn === undefined || !requestId || !turnId || !safeInteger(data.requestOrdinal, 1)) return null
    const envelope = parseEnvelope(data.envelope, {
      requestId,
      runId,
      turnId,
      turn,
      requestOrdinal: data.requestOrdinal as number,
    })
    return envelope ? { ...base, phase: 'request_envelope', envelope } : null
  }
  if (data.phase === 'first_token') {
    if (!finiteNonNegative(data.runDurationMs)) return null
    return { ...base, phase: 'first_token', runDurationMs: data.runDurationMs }
  }
  if (data.phase === 'model_generation') return { ...base, phase: 'model_generation' }
  if (data.phase === 'total') return { ...base, phase: 'total' }
  if (data.phase === 'tool_wait') {
    const toolName = safeLabel(data.toolName)
    const correlationId = parseToolCorrelation(data)
    if (!toolName || data.waitType !== 'authorization' || !['allow', 'deny', 'error'].includes(String(data.outcome))) return null
    return {
      ...base,
      phase: 'tool_wait',
      toolName,
      ...(correlationId && { correlationId }),
      outcome: data.outcome as 'allow' | 'deny' | 'error',
      ...(data.validation === true && { validation: true as const }),
    }
  }
  if (data.phase === 'tool_execution') {
    const toolName = safeLabel(data.toolName)
    const correlationId = parseToolCorrelation(data)
    if (!toolName || !['success', 'error'].includes(String(data.outcome))) return null
    return {
      ...base,
      phase: 'tool_execution',
      toolName,
      ...(correlationId && { correlationId }),
      outcome: data.outcome as 'success' | 'error',
      ...(data.validation === true && { validation: true as const }),
    }
  }
  if (data.phase === 'retry') {
    if ((data.stage !== 'backoff' && data.stage !== 'attempt') || !safeInteger(data.attempt, 1)) return null
    const outcome = data.outcome === undefined
      ? undefined
      : ['succeeded', 'exhausted', 'cancelled'].includes(String(data.outcome))
        ? data.outcome as 'succeeded' | 'exhausted' | 'cancelled'
        : null
    if (outcome === null) return null
    return { ...base, phase: 'retry', stage: data.stage, attempt: data.attempt as number, ...(outcome && { outcome }) }
  }
  if (data.phase === 'compaction') {
    const attemptId = safeOpaqueId(data.attemptId)
    const stage = data.stage === 'preflight' || data.stage === 'provider_projection' || data.stage === 'lifecycle'
      ? data.stage
      : undefined
    const outcome = ['enhanced', 'observed', 'not_applicable', 'fallback', 'fallback_validation', 'cancelled', 'failed', 'compacted', 'aborted'].includes(String(data.outcome))
      ? data.outcome as 'enhanced' | 'observed' | 'not_applicable' | 'fallback' | 'fallback_validation' | 'cancelled' | 'failed' | 'compacted' | 'aborted'
      : undefined
    if (!attemptId || !stage || !outcome) return null
    return {
      ...base,
      phase: 'compaction',
      compactionAttemptId: attemptId,
      compactionStage: stage,
      outcome,
    }
  }
  return null
}

async function readBoundedTail(filePath: string, maxBytes: number): Promise<{ text: string; truncated: boolean } | null> {
  let file
  try {
    file = await open(filePath, 'r')
    const stat = await file.stat()
    const length = Math.min(stat.size, maxBytes)
    const offset = Math.max(0, stat.size - length)
    const buffer = Buffer.alloc(length)
    await file.read(buffer, 0, length, offset)
    let text = buffer.toString('utf8')
    const truncated = offset > 0
    if (truncated) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
    }
    return { text, truncated }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  } finally {
    await file?.close()
  }
}

export class PiRunTimingQuery {
  private readonly maxBytes: number
  private readonly maxEvents: number
  private readonly maxRuns: number

  constructor(private readonly options: QueryOptions) {
    this.maxBytes = Math.max(1_024, options.maxBytes ?? DEFAULT_MAX_BYTES)
    this.maxEvents = Math.max(1, options.maxEvents ?? DEFAULT_MAX_EVENTS)
    this.maxRuns = Math.max(1, options.maxRuns ?? DEFAULT_MAX_RUNS)
  }

  async query(sessionId: string): Promise<PiRunTimingReportView> {
    let tail: { text: string; truncated: boolean } | null
    try {
      tail = await readBoundedTail(this.options.filePath, this.maxBytes)
    } catch {
      return { status: 'unavailable', runs: [], tailTruncated: false, eventLimitReached: false, corruptLines: 0 }
    }
    if (!tail) return { status: 'empty', runs: [], tailTruncated: false, eventLimitReached: false, corruptLines: 0 }

    let corruptLines = 0
    let eventLimitReached = false
    const newestFirst: SafePiTrajectoryEvent[] = []
    for (const line of tail.text.split(/\r?\n/).reverse()) {
      if (!line.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        corruptLines += 1
        continue
      }
      const event = parseEvent(parsed)
      if (!event || event.sessionId !== sessionId) continue
      if (newestFirst.length >= this.maxEvents) {
        eventLimitReached = true
        break
      }
      newestFirst.push(event)
    }
    if (newestFirst.length === 0) {
      return { status: 'empty', runs: [], tailTruncated: tail.truncated, eventLimitReached, corruptLines }
    }

    const matching = newestFirst.reverse().map((event, index) => ({ ...event, sourceOrder: index + 1 }))
    const grouped = new Map<number, SafePiTrajectoryEvent[]>()
    for (const event of matching) {
      const group = grouped.get(event.runStartedAt) ?? []
      group.push(event)
      grouped.set(event.runStartedAt, group)
    }
    const selected = [...grouped.entries()].sort(([left], [right]) => right - left).slice(0, this.maxRuns)
    const incomplete = tail.truncated || eventLimitReached || corruptLines > 0 || grouped.size > this.maxRuns
    return {
      status: 'available',
      runs: selected.map(([, events]) => projectAgentTrajectoryRun(events, incomplete)),
      tailTruncated: tail.truncated,
      eventLimitReached,
      corruptLines,
    }
  }
}

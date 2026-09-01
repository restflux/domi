import { createHash } from 'node:crypto'
import type { AgentWorkflow, ExecutionPolicyMode } from '@domi/shared'

const HASH_PREFIX = 'sha256:'
const MAX_CANONICAL_DEPTH = 16
const MAX_ARRAY_ITEMS = 512
const MAX_OBJECT_KEYS = 512
const MAX_LABEL_CHARS = 200

export interface PiRequestEnvelopeRuntimeContext {
  executionPolicy: ExecutionPolicyMode
  workflow: AgentWorkflow
  sessionTarget?: {
    kind: 'local' | 'isolated'
    ownership: 'owner' | 'inherited'
    revision?: number
  }
}

export interface CapturePiRequestEnvelopeInput {
  capturedAt: number
  provider: string
  modelId: string
  reasoningLevel: string
  contextWindow?: number
  systemPrompt: string
  messageCount: number
  tools: readonly unknown[]
  piActiveLeafId?: string | null
  runtimeContext?: PiRequestEnvelopeRuntimeContext
}

export interface PiRequestEnvelopeSnapshot {
  version: 1
  capturedAt: number
  provider: string
  modelId: string
  reasoningLevel: string
  contextWindow?: number
  messageCount: number
  toolCount: number
  systemPromptHash: string
  toolSchemaHash: string
  piActiveLeafId: string | null
  controls?: {
    executionPolicy: ExecutionPolicyMode
    workflow: AgentWorkflow
  }
  sessionTarget?: {
    kind: 'local' | 'isolated'
    ownership: 'owner' | 'inherited'
    revision?: number
  }
}

function safeLabel(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_CHARS)
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function normalizeForHash(value: unknown, seen: WeakSet<object>, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : `[${String(value)}]`
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return `[${typeof value}]`
  if (depth >= MAX_CANONICAL_DEPTH) return '[TRUNCATED]'
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.slice(0, MAX_ARRAY_ITEMS).map((item) => normalizeForHash(item, seen, depth + 1))
    }

    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, MAX_OBJECT_KEYS)
        .map(([key, child]) => [key, normalizeForHash(child, seen, depth + 1)]),
    )
  } finally {
    seen.delete(value)
  }
}

function sha256(value: string): string {
  return `${HASH_PREFIX}${createHash('sha256').update(value, 'utf8').digest('hex')}`
}

function hashToolSchemas(tools: readonly unknown[]): string {
  return sha256(JSON.stringify(normalizeForHash(tools, new WeakSet())))
}

/**
 * 捕获一次真实 provider request 的不可变安全清单。
 * 只保留可观测元数据和不可逆 fingerprint，不保存 prompt、message 或 tool schema 正文。
 */
export function capturePiRequestEnvelope(input: CapturePiRequestEnvelopeInput): PiRequestEnvelopeSnapshot {
  const contextWindow = Number.isSafeInteger(input.contextWindow) && (input.contextWindow ?? 0) > 0
    ? input.contextWindow
    : undefined
  const revision = Number.isSafeInteger(input.runtimeContext?.sessionTarget?.revision)
    && (input.runtimeContext?.sessionTarget?.revision ?? -1) >= 0
    ? input.runtimeContext?.sessionTarget?.revision
    : undefined

  return {
    version: 1,
    capturedAt: Number.isSafeInteger(input.capturedAt) && input.capturedAt >= 0 ? input.capturedAt : Date.now(),
    provider: safeLabel(input.provider),
    modelId: safeLabel(input.modelId),
    reasoningLevel: safeLabel(input.reasoningLevel),
    ...(contextWindow !== undefined && { contextWindow }),
    messageCount: safeCount(input.messageCount),
    toolCount: safeCount(input.tools.length),
    systemPromptHash: sha256(input.systemPrompt),
    toolSchemaHash: hashToolSchemas(input.tools),
    piActiveLeafId: typeof input.piActiveLeafId === 'string'
      ? safeLabel(input.piActiveLeafId)
      : null,
    ...(input.runtimeContext && {
      controls: {
        executionPolicy: input.runtimeContext.executionPolicy,
        workflow: input.runtimeContext.workflow,
      },
    }),
    ...(input.runtimeContext?.sessionTarget && {
      sessionTarget: {
        kind: input.runtimeContext.sessionTarget.kind,
        ownership: input.runtimeContext.sessionTarget.ownership,
        ...(revision !== undefined && { revision }),
      },
    }),
  }
}

import type { AgentWorkflow, ExecutionPolicyMode } from './execution-policy.ts'

/** Renderer 可见的轨迹事件是否进入模型 transcript；product-state 为宿主状态投影预留。 */
export type AgentTrajectoryVisibility = 'model-visible' | 'log-only' | 'product-state'

/** 每次真实 provider model call 的安全清单；只包含 hash、计数和受限运行元数据。 */
export interface PiRequestEnvelopeView {
  version: 1
  requestId: string
  runId: string
  turnId: string
  turn: number
  requestOrdinal: number
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

/** Renderer 可见的 Pi run 耗时阶段；不包含原始 audit record 或工具载荷。 */
export type PiRunTimingSpanKind =
  | 'model'
  | 'authorization'
  | 'tool'
  | 'retry_backoff'
  | 'retry_attempt'
  | 'compaction'

export interface PiRunTimingSpanView {
  kind: PiRunTimingSpanKind
  label: string
  startOffsetMs: number
  endOffsetMs: number
  durationMs: number
  /** 对应一次 model/tool/retry call 的稳定投影 ID；旧 audit 记录可缺失。 */
  callId?: string
  /** 原始 toolCallId 的不可逆短指纹；Renderer 不接收 raw ID。 */
  correlationId?: string
  turn?: number
  sequence?: number
  visibility?: AgentTrajectoryVisibility
  envelope?: PiRequestEnvelopeView
  outcome?: 'allow' | 'deny' | 'success' | 'error' | 'succeeded' | 'exhausted' | 'cancelled'
    | 'enhanced' | 'observed' | 'not_applicable' | 'fallback' | 'fallback_validation' | 'failed' | 'compacted' | 'aborted'
  validation?: true
}

export interface PiRunTimingSummaryView {
  slowestTool: { toolName: string; durationMs: number } | null
  toolDurationMs: number
  authorizationWaitMs: number
  retryDurationMs: number
  modelGenerationMs: number
  retryCount: number
}

export interface PiRunTimingRunView {
  /** 新轨迹记录提供稳定 runId；旧 audit 记录可只依赖 runStartedAt。 */
  runId?: string
  runStartedAt: number
  completed: boolean
  evidenceIncomplete: boolean
  totalDurationMs: number
  firstTokenMs: number | null
  spans: PiRunTimingSpanView[]
  summary: PiRunTimingSummaryView
}

export interface PiRunTimingReportView {
  status: 'available' | 'empty' | 'unavailable'
  runs: PiRunTimingRunView[]
  tailTruncated: boolean
  eventLimitReached: boolean
  corruptLines: number
}

export interface QueryPiRunTimingInput {
  sessionId: string
}

export interface PiRunTimingRendererApi {
  query(input: QueryPiRunTimingInput): Promise<PiRunTimingReportView>
}

/**
 * Pi Agent SDK 适配器
 *
 * Domi 内部继续使用 SDKMessage 兼容协议，避免渲染层、Jotai 状态、
 * JSONL 持久化和历史会话展示在 SDK 迁移时一起改名。
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { Dispatcher } from 'undici'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type {
  AgentAssistantDelta,
  AgentThinkingLevel,
  AgentWorkflow,
  AgentNextTurnAside,
  AgentProviderAdapter,
  AgentQueueMessageKind,
  CodexOAuthCredentials,
  ContextWindowSource,
  AgentContextBreakdown,
  AgentQueryInput,
  ErrorCode,
  FinishReasonMode,
  JsonSchemaOutputFormat,
  ModelPresentationPreset,
  DomiPermissionMode,
  ProviderType,
  RecoveryAction,
  SendQueuedMessageOptions,
  SessionTreeNavigationAdapterInput,
  SessionTreeNavigationAdapterResult,
  SDKMessage,
  SDKUserMessage,
  SDKUserMessageInput,
  SkillTriggerEvent,
  TypedError,
} from '@domi/shared'
import {
  calculatePiAutoCompactionReserveTokens,
  inferReasoningTransport,
  isCodexFastModeSupportedModel,
  resolveReasoningProfile,
} from '@domi/shared'
import {
  THINKING_SIGNATURE_ERROR_MESSAGE,
  THINKING_SIGNATURE_ERROR_TITLE,
  isThinkingSignatureError as matchesThinkingSignatureError,
} from '@domi/shared'
import type { CanUseToolOptions, PermissionResult } from '../agent-permission-service'
import type { SkillTriggerRecorder } from '../skill-trigger-recorder'
import { TRANSIENT_NETWORK_PATTERN, isMalformedResponseError } from '../error-patterns'
import { readPiSessionEntries, resolveNavigationTarget } from '../session-tree-service'
import {
  claimPendingNativeQueueDelivery,
  createNativeQueueDeliverySuppressionState,
  findAddedNativeQueueContent,
  processOrDeferNativeQueueSnapshot,
  selectItemsPresentInNativeQueue,
  withNativeQueueDeliverySuppressed,
  type NativeQueueDeliverySuppressionState,
} from '../agent-message-queue-replay'

import type {
  AgentSession,
  AgentSessionEvent,
  ResourceLoader,
  SettingsManager,
  Skill,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import type { Transport as PiAgentTransport } from '@earendil-works/pi-ai'
import type { AgentMessage, AgentToolResult } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai/compat'
import { Type } from 'typebox'
import { filterToolsForModelPresentation } from '../model-presentation'
import {
  appendOutputFormatInstruction,
  createAgentRuntimeGuard,
  type AgentRuntimeGuard,
} from '../agent-runtime-guards'
import { createDomiAgentsFilesOverride } from './pi-resource-loader-overrides'
import { createCodexFastModeExtension, withCodexFastModeServiceTier } from './pi-codex-request-settings'
import { createDeepSeekReasoningRequestExtension } from './pi-deepseek-reasoning-request-settings'
import { createOpenAIReasoningRequestExtension } from './pi-openai-reasoning-request-settings'
import { mergeRuntimeEnv, type AgentRuntimeEnv } from '../agent-runtime-env'
import {
  hardenReadOnlyBashCommand,
  hasGitBashCmdNullDeviceRedirection,
} from '../execution-policy/shell-command-classifier'
import { isExactFrozenBunInstallCommand } from '../worktree-dependency-snapshot.ts'
import {
  convertPiMessage,
  convertResultMessage,
  createPiCompactionBoundaryMessage,
  displayToolName,
  dropTrailingAbortedAssistant,
  hasToolResult,
  isAbortedAssistantMessage,
  isAssistantPiMessage,
} from './pi-message-adapter'
import { DEFAULT_CONTEXT_WINDOW, buildModel } from './pi-model-registry'
import { createDeltaBatchCoalescer, type DeltaBatchCoalescer } from './pi-streaming-control'
import { serializePiAssistantDelta } from './pi-assistant-delta'
import { createPiRetryTerminalGate, mapPiNativeRetryEvent } from './pi-retry-control'
import { friendlyPiErrorMessage } from './pi-friendly-error'
import {
  resolvePiContextCompactorSettings,
  type PiContextCompactorHostSnapshot,
  type PiContextCompactorSettings,
} from './pi-context-compactor'
import {
  createPiContextCompactorExtension,
  wrapPiContextCompactorTransform,
  type PiContextCompactorMode,
  type PiContextCompactorTelemetryEvent,
} from './pi-context-compactor-extension'
import {
  createPiPromptOutputEvidence,
  planPiIncompleteTurnContinuation,
  recordPiPromptAssistantOutput,
  type PiPromptOutputEvidence,
} from './pi-incomplete-turn-continuation'
import {
  createPiOverflowRecoveryState,
  isPiPromptTooLongError,
  shouldDeferPiOverflowTerminalError,
  shouldDeferPiOverflowTerminalMessage,
} from './pi-overflow-recovery'
import {
  closePiRequestProxyDispatcher,
  createPiRequestProxyDispatcher,
  installPiRequestProxyFetch,
  runWithPiRequestProxy,
} from './pi-request-proxy'
import { getExtensionTrustPath } from '../config-paths.ts'
import { createTrustedPiResourceLoader } from './pi-extension-resource-loader.ts'
import { buildPiContextBreakdown } from './pi-context-breakdown.ts'
import {
  FileExtensionTrustStore,
  type ExtensionTrustStore,
} from './pi-extension-trust.ts'
import { installPiFinalToolGuard } from './pi-final-tool-guard.ts'
import {
  createPiRunAuditRecorder,
  type PiRunAuditTimingCallback,
} from '../audit/pi-run-audit.ts'
import {
  capturePiRequestEnvelope,
  type PiRequestEnvelopeRuntimeContext,
} from '../audit/pi-request-envelope.ts'
import { recordPiAgentAuditEvent } from './pi-agent-audit.ts'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
type BashOperations = import('@earendil-works/pi-coding-agent').BashOperations
type BashToolOptions = import('@earendil-works/pi-coding-agent').BashToolOptions
type SkillLoadResult = ReturnType<ResourceLoader['getSkills']>

const PI_NATIVE_MAX_RETRIES = 8
const PI_NATIVE_MAX_TOTAL_RETRIES = 8
const PI_NATIVE_RETRY_BASE_DELAY_MS = 1_000
const PI_NATIVE_MAX_TOTAL_DELAY_MS = 5 * 60_000
const PI_NATIVE_RETRY_JITTER_RATIO = 0.2
const MAX_AUTOMATIC_COMPACTION_CONTINUATIONS = 20
const PI_PARALLEL_READ_ONLY_TOOL_NAMES = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'TaskGet',
  'TaskList',
  'TodoRead',
])

export interface PiToolCallDescriptor {
  id: string
  name: string
}

export interface PiToolExecutionGroup<TToolCall extends PiToolCallDescriptor = PiToolCallDescriptor> {
  mode: 'parallel' | 'sequential'
  toolCalls: TToolCall[]
}

function isParallelReadOnlyPiToolName(toolName: string): boolean {
  return PI_PARALLEL_READ_ONLY_TOOL_NAMES.has(toolName)
}

/**
 * Pi 仅提供整批 parallel / sequential 两档。这里按 assistant 原始顺序分段：
 * 连续白名单只读调用组成并行组，副作用调用各自保持原位串行。
 */
export function partitionToolCalls<TToolCall extends PiToolCallDescriptor>(
  toolCalls: readonly TToolCall[],
  isReadOnlyTool: (toolName: string) => boolean = isParallelReadOnlyPiToolName,
): PiToolExecutionGroup<TToolCall>[] {
  const groups: PiToolExecutionGroup<TToolCall>[] = []
  let readOnlyGroup: TToolCall[] = []

  const flushReadOnlyGroup = (): void => {
    if (readOnlyGroup.length === 0) return
    groups.push({ mode: 'parallel', toolCalls: readOnlyGroup })
    readOnlyGroup = []
  }

  for (const toolCall of toolCalls) {
    if (isReadOnlyTool(toolCall.name)) {
      readOnlyGroup.push(toolCall)
      continue
    }
    flushReadOnlyGroup()
    groups.push({ mode: 'sequential', toolCalls: [toolCall] })
  }
  flushReadOnlyGroup()
  return groups
}

export interface WorktreeHandoffRequest {
  task: string
}

export interface ValidatedWorktreeHandoff {
  targetRevision: number
  targetCurrentOid: string
  dirtyConfirmed: boolean
}

interface ScheduledWorktreeHandoff extends WorktreeHandoffRequest, ValidatedWorktreeHandoff {
  toolCallId: string
}

export interface ReadyWorktreeHandoffRequest extends WorktreeHandoffRequest, ValidatedWorktreeHandoff {
  assistantMessageUuid: string
  toolResultMessageUuid: string
  piToolResultEntryId: string
}

export interface PiWorktreeHandoffControl {
  /** 工具执行阶段由宿主校验目标；dirty 时必须在此完成真实用户确认。 */
  validate: (request: WorktreeHandoffRequest, signal?: AbortSignal) => Promise<ValidatedWorktreeHandoff>
  /** 当前 turn、tool result 与 Pi entry 均落盘后通知 orchestrator 执行原子 handoff。 */
  ready: (request: ReadyWorktreeHandoffRequest) => void
}

/** Pi SDK 查询选项（扩展通用 AgentQueryInput） */
export interface PiFileCheckpointCallbacks {
  beforeMutation: (filePath: string) => Promise<boolean | void> | boolean | void
  afterMutation: (filePath: string) => Promise<void> | void
  onError?: (phase: 'before' | 'after', filePath: string, error: unknown) => void
}

export interface PiAgentContextCompactorOptions {
  mode: PiContextCompactorMode
  settings?: Partial<PiContextCompactorSettings>
  getHostSnapshot?: (signal: AbortSignal) => PiContextCompactorHostSnapshot | Promise<PiContextCompactorHostSnapshot>
}

export interface PiAgentQueryOptions extends AgentQueryInput {
  apiKey: string
  baseUrl?: string
  provider: ProviderType
  channelName?: string
  /** 当前渠道中选中的模型配置，携带供应商元数据与临时适配。 */
  channelModel?: import('@domi/shared').ChannelModel
  finishReasonMode?: FinishReasonMode
  maxTurns?: number
  permissionMode: DomiPermissionMode
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ) => Promise<PermissionResult>
  /** Pi session 级最终门禁，覆盖 builtin、产品、MCP 与 Trusted Extension 工具。 */
  authorizeToolCall: (
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
  ) => Promise<PermissionResult>
  /** 供 Bash spawn hook 读取热切换后的 Workflow，仅在受限 Workflow 下加固只读命令。 */
  getWorkflow?: () => AgentWorkflow
  handleAskUserQuestion?: (
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<PermissionResult>
  handleRequestDirectWorkflow?: (
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<PermissionResult>
  handleExitPlanMode?: (
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<PermissionResult>
  systemPrompt: string
  resumeSessionId?: string
  piAgentDir: string
  piSessionDir: string
  customTools?: ToolDefinition[]
  customToolSources?: Record<string, NonNullable<CanUseToolOptions['toolSource']>>
  customToolAnnotations?: Record<string, NonNullable<CanUseToolOptions['toolAnnotations']>>
  onSessionId?: (sdkSessionId: string, sessionFile?: string) => void
  /** Pi final assistant UI UUID → 持久树状 session entry ID。 */
  onPiEntryBindings?: (bindings: Record<string, string>) => void
  /** 仅 Local Pi 会话注入；允许 Agent 请求 Domi 托管 Worktree 交接。 */
  worktreeHandoff?: PiWorktreeHandoffControl
  /** Session Tree 导航后，下一轮创建 SessionManager 时恢复的临时叶节点。 */
  resumeTreeLeafId?: string | null
  /** 临时叶节点已应用，可从宿主 meta 清除。 */
  onTreeNavigationApplied?: () => void
  onModelResolved?: (model: string) => void
  /** Pi 的窗口来自构建后的静态 model catalog，仍可能与第三方路由实际限制不同。 */
  onContextWindow?: (contextWindow: number, source?: ContextWindowSource) => void
  /** 每次真实 provider request 的上下文构成估算。 */
  onContextBreakdown?: (breakdown: AgentContextBreakdown) => void
  onRetry?: (update: import('./pi-retry-control').PiRetryUpdate) => void
  /** 渲染进程创建的本轮流式开始时间，用于隔离迟到的 native retry 事件和 audit。 */
  retryRunStartedAt?: number
  /** 仅供宿主 run audit wiring 使用，不依赖具体 writer。 */
  auditWorkspaceId?: string
  onAuditTimingEvent?: PiRunAuditTimingCallback
  /** 每次真实 provider request 读取热切换后的控制状态与固定 Session Target 快照。 */
  getRequestEnvelopeContext?: () => PiRequestEnvelopeRuntimeContext
  /** Skill 触发观测记录器；由编排层按会话创建，检测 Read 命中技能根目录。 */
  skillTriggerRecorder?: SkillTriggerRecorder
  /** Skill 触发时上浮给编排层（用于 domi_event 转发）。 */
  onSkillTrigger?: (trigger: SkillTriggerEvent) => void
  /** 可见进度任务变化快照；Work Activity 仅把它作为阶段证据。 */
  onTasksChanged?: (tasks: DomiTaskItem[]) => void
  thinkingLevel?: AgentThinkingLevel
  maxBudgetUsd?: number
  outputFormat?: JsonSchemaOutputFormat
  /** Domi 聚合的附加目录；Pi 内置工具 factory 不接收多 root 参数，编排层会把它们注入 systemPrompt。 */
  additionalDirectories?: string[]
  additionalSkillPaths?: string[]
  /** 当前用户输入显式引用的 Skill name（兼容历史 slug 已在编排层归一化） */
  skillMentions?: string[]
  /** 模型可见面呈现预设；minimal 只收窄提示词与工具面，宿主 guard/权限不受影响。 */
  modelPresentationPreset?: ModelPresentationPreset
  proxyUrl?: string
  /** Pi 模型请求传输策略：auto / sse / websocket / websocket-cached */
  transport?: PiAgentTransport
  /** HTTP 头/响应体空闲超时，单位毫秒；0 表示交给 Pi SDK 禁用超时 */
  httpIdleTimeoutMs?: number
  /** WebSocket 建连超时，单位毫秒；0 表示交给 Pi SDK 禁用超时 */
  websocketConnectTimeoutMs?: number
  runtimeEnv?: AgentRuntimeEnv
  /** Domi 宿主文件检查点；只包装 Pi 内置 write/edit，不覆盖 Bash、MCP 或 Extension 的任意文件副作用。 */
  fileCheckpoint?: PiFileCheckpointCallbacks
  /** 已通过 final guard / Execution Policy 且成功完成的精确 frozen Bun install，可用于 best-effort 发布私有 Worktree 依赖快照。 */
  onSuccessfulFrozenBunInstall?: (input: {
    cwd: string
    command: string
    signal?: AbortSignal
  }) => Promise<void>
  /** 手动压缩请求：走 pi 原生 session.compact()，而非把 /compact 当普通 prompt 发给模型 */
  compactRequest?: boolean
  /** 手动压缩时交给 Pi summarizer 的用户自定义指令。 */
  compactInstructions?: string
  /** ChatGPT Codex Fast Mode；仅 openai-codex 的受支持模型实际注入 priority service tier。 */
  codexFastMode?: boolean
  /** steering 队列每次 turn 的消费方式。 */
  steeringMode?: 'all' | 'one-at-a-time'
  /** follow-up 队列每次 turn 的消费方式。 */
  followUpMode?: 'all' | 'one-at-a-time'
  /** 在首次 prompt 前通过 SDK nextTurn 注入的附言。 */
  nextTurnAsides?: AgentNextTurnAside[]
  /** 默认关闭的 Domi-owned ContextCompactor 灰度配置。 */
  contextCompactor?: PiAgentContextCompactorOptions
  /** Pi 的 OAuth credential store 使用真实 expires 和 refresh，不读取 ~/.pi。 */
  codexOAuthCredentials?: CodexOAuthCredentials
  /** Pi 运行中刷新 OAuth 后，将新凭据回写到 Domi 渠道存储。 */
  onCodexOAuthCredentialsRefreshed?: (credentials: CodexOAuthCredentials) => void | Promise<void>
  /** 会话级 OpenAI（Codex OAuth / Responses API）思考深度。 */
  openAIThinkingLevel?: AgentThinkingLevel
}

/** tool_execution_start 事件中与 Skill 触发检测相关的窄形状。 */
export interface SkillTriggerToolStartEvent {
  toolName: string
  toolCallId: string
  args?: { path?: unknown }
}

/**
 * 处理 tool_execution_start：仅 read 且路径命中技能根目录时记录并上浮。
 * Pi 原生工具名为小写，兼容旧事件或展示层可能传入的大小写形式。
 * 任何异常都静默，不影响 Agent 主循环。
 */
export function recordSkillTriggerFromToolStart(
  input: {
    skillTriggerRecorder?: SkillTriggerRecorder
    onSkillTrigger?: (trigger: SkillTriggerEvent) => void
  },
  event: SkillTriggerToolStartEvent,
): SkillTriggerEvent | null {
  try {
    if (!input.skillTriggerRecorder || event.toolName.toLowerCase() !== 'read') return null
    if (typeof event.args?.path !== 'string') return null
    const trigger = input.skillTriggerRecorder.record(event.args.path, event.toolCallId)
    if (trigger) input.onSkillTrigger?.(trigger)
    return trigger
  } catch {
    return null
  }
}

interface ActivePiSession {
  session?: AgentSession
  resourceLoader?: ResourceLoader
  ready: Promise<AgentSession>
  resolveReady: (session: AgentSession) => void
  rejectReady: (error: unknown) => void
  abortRequested: boolean
  interrupting: boolean
  pendingInterruptPrompts: PendingInterruptPrompt[]
  pendingNativeQueueDeliveries: Record<AgentQueueMessageKind, PendingNativeQueueDelivery[]>
  nativeQueueDeliverySuppression: NativeQueueDeliverySuppressionState<NativeQueueSnapshot>
  processNativeQueueSnapshot?: (snapshot: NativeQueueSnapshot) => void
  interruptAbortPromise?: Promise<void>
  readySettled: boolean
  disposed: boolean
  runtimeGuard?: AgentRuntimeGuard
  /** ForkToWorktree 通过宿主校验后立即锁存，父 Local 会话不再接受后续消息。 */
  worktreeHandoffTerminating: boolean
}

interface PendingInterruptPrompt {
  content: string
  resolveAccepted: () => void
  rejectAccepted: (error: unknown) => void
}

interface PendingNativeQueueDelivery {
  content: string
  messageId?: string
  onDelivered?: () => SDKMessage | void
}

interface NativeQueueSnapshot {
  steering: string[]
  followUp: string[]
}

export interface DomiTaskItem {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled' | 'error' | 'deleted'
  description?: string
  activeForm?: string
  blocks?: string[]
}

interface DomiProductToolRuntimeState {
  tasks: Map<string, DomiTaskItem>
  nextTaskId: number
}

interface AssistantMessageState {
  uuid?: string
}

/**
 * 同一 assistant 流在 Pi native retry 前后必须复用 UUID：renderer 才能用恢复后的
 * partial/final frame 原地替换断流前的 partial，而不是把两段回答并排追加。
 */
export function createPiAssistantUuidTracker(createUuid: () => string = randomUUID): {
  get: () => string
  reset: () => void
} {
  let state: AssistantMessageState = {}

  return {
    get: () => {
      if (!state.uuid) state = { uuid: createUuid() }
      if (!state.uuid) throw new Error('Pi assistant message uuid 初始化失败')
      return state.uuid
    },
    reset: () => { state = {} },
  }
}

export interface PiRemoteConnectionSettings {
  httpProxy?: string
  transport?: PiAgentTransport
  httpIdleTimeoutMs?: number
  websocketConnectTimeoutMs?: number
}

interface AsyncQueue<T> {
  push: (value: T) => void
  fail: (error: unknown) => void
  close: () => void
  next: () => Promise<IteratorResult<T>>
}

/** Pi 小粒度 delta 按约 20fps 成批转发，避免每 token 一个 IPC 事件。 */
const PI_DELTA_BATCH_INTERVAL_MS = 50

function getCaseInsensitiveRuntimeEnvValue(env: Record<string, string> | undefined, key: string): string | undefined {
  if (!env) return undefined
  const exact = env[key]
  if (exact) return exact
  const foundKey = Object.keys(env).find((name) => name.toLowerCase() === key.toLowerCase())
  const value = foundKey ? env[foundKey] : undefined
  return value || undefined
}

function normalizeProxyUrl(proxyUrl: string | undefined): string | undefined {
  const trimmed = proxyUrl?.trim()
  return trimmed ? trimmed : undefined
}

function resolvePiHttpProxy(input: Pick<PiAgentQueryOptions, 'proxyUrl' | 'runtimeEnv'>): string | undefined {
  return normalizeProxyUrl(input.proxyUrl)
    ?? normalizeProxyUrl(getCaseInsensitiveRuntimeEnvValue(input.runtimeEnv?.env, 'HTTPS_PROXY'))
    ?? normalizeProxyUrl(getCaseInsensitiveRuntimeEnvValue(input.runtimeEnv?.env, 'HTTP_PROXY'))
    ?? normalizeProxyUrl(getCaseInsensitiveRuntimeEnvValue(input.runtimeEnv?.env, 'ALL_PROXY'))
}

function isNonNegativeFiniteNumber(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0
}

export function buildPiRemoteConnectionSettings(
  input: Pick<
    PiAgentQueryOptions,
    'provider' | 'proxyUrl' | 'runtimeEnv' | 'transport' | 'httpIdleTimeoutMs' | 'websocketConnectTimeoutMs'
  >,
): PiRemoteConnectionSettings {
  const httpProxy = resolvePiHttpProxy(input)
  // Node/Electron 的 WebSocket 不支持请求级 HTTP 代理注入；有代理的 Codex
  // 默认改走可由 undici dispatcher 承载的 SSE。用户显式选择 transport 时保留其意图。
  const transport = input.transport ?? (httpProxy && input.provider === 'openai-codex' ? 'sse' : undefined)
  return {
    ...(httpProxy ? { httpProxy } : {}),
    ...(transport ? { transport } : {}),
    ...(isNonNegativeFiniteNumber(input.httpIdleTimeoutMs) ? { httpIdleTimeoutMs: input.httpIdleTimeoutMs } : {}),
    ...(isNonNegativeFiniteNumber(input.websocketConnectTimeoutMs)
      ? { websocketConnectTimeoutMs: input.websocketConnectTimeoutMs }
      : {}),
  }
}

function createAsyncQueue<T>(): AsyncQueue<T> {
  const values: T[] = []
  const waiters: Array<(result: IteratorResult<T>) => void> = []
  let closed = false
  let failure: unknown

  const flush = (): void => {
    while (waiters.length > 0 && (values.length > 0 || closed || failure)) {
      const waiter = waiters.shift()!
      if (values.length > 0) {
        waiter({ value: values.shift()!, done: false })
      } else if (failure) {
        const err = failure
        failure = undefined
        Promise.resolve().then(() => { throw err }).catch(() => {})
        waiter(Promise.reject(err) as unknown as IteratorResult<T>)
      } else {
        waiter({ value: undefined, done: true })
      }
    }
  }

  return {
    push(value) {
      if (closed) return
      values.push(value)
      flush()
    },
    fail(error) {
      if (closed) return
      failure = error
      closed = true
      flush()
    },
    close() {
      closed = true
      flush()
    },
    next() {
      if (values.length > 0) {
        return Promise.resolve({ value: values.shift()!, done: false })
      }
      if (failure) {
        const err = failure
        failure = undefined
        return Promise.reject(err)
      }
      if (closed) {
        return Promise.resolve({ value: undefined, done: true })
      }
      return new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve))
    },
  }
}

const SESSION_READY_TIMEOUT_MS = 60_000
const SKILL_COMMAND_PATTERN = /\/skill:([A-Za-z0-9][A-Za-z0-9._-]*)/g

function createActivePiSession(): ActivePiSession {
  let resolveReady!: (session: AgentSession) => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<AgentSession>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  ready.catch(() => {})
  return {
    ready,
    resolveReady,
    rejectReady,
    abortRequested: false,
    interrupting: false,
    pendingInterruptPrompts: [],
    pendingNativeQueueDeliveries: { steering: [], followUp: [] },
    nativeQueueDeliverySuppression: createNativeQueueDeliverySuppressionState(),
    readySettled: false,
    disposed: false,
    worktreeHandoffTerminating: false,
  }
}

function resolveActiveReady(active: ActivePiSession, session: AgentSession): void {
  if (active.readySettled) return
  active.readySettled = true
  active.resolveReady(session)
}

function rejectActiveReady(active: ActivePiSession, error: unknown): void {
  if (active.readySettled) return
  active.readySettled = true
  active.rejectReady(error)
}

function createAbortError(): Error {
  const error = new Error('Agent 执行已停止')
  error.name = 'AbortError'
  return error
}

function rejectPendingInterruptPrompts(active: ActivePiSession, error: unknown): void {
  const pending = active.pendingInterruptPrompts.splice(0)
  for (const prompt of pending) {
    prompt.rejectAccepted(error)
  }
}

async function waitForActiveSession(active: ActivePiSession): Promise<AgentSession> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      active.ready,
      new Promise<AgentSession>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Agent 会话初始化超时，请稍后重试')), SESSION_READY_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function getNativeQueueSnapshot(session: AgentSession): NativeQueueSnapshot {
  return {
    steering: [...session.getSteeringMessages()],
    followUp: [...session.getFollowUpMessages()],
  }
}

export const friendlyErrorMessage = friendlyPiErrorMessage

export function isPromptTooLongError(...messages: Array<string | undefined>): boolean {
  return isPiPromptTooLongError(...messages)
}

export function isThinkingSignatureError(...messages: Array<string | undefined>): boolean {
  return matchesThinkingSignatureError(...messages)
}

function stringifyErrorContent(content: unknown): string | undefined {
  if (typeof content === 'string' && content.trim()) return content
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        if (!block || typeof block !== 'object') return ''
        const record = block as Record<string, unknown>
        if (typeof record.text === 'string') return record.text
        if (typeof record.message === 'string') return record.message
        return ''
      })
      .filter(Boolean)
      .join('\n')
      .trim()
    return text || undefined
  }
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>
    if (typeof record.message === 'string') return record.message
    if (typeof record.error === 'string') return record.error
    return JSON.stringify(record)
  }
  return undefined
}

export function extractErrorDetails(error: {
  error?: { message?: string; errorType?: string }
  errorMessage?: string
  errors?: unknown[]
  message?: { content?: unknown }
  content?: unknown
}): {
  detailedMessage: string
  originalError?: string
} {
  const direct = error.error?.message ?? error.errorMessage
  if (direct) return { detailedMessage: direct, originalError: direct }
  const fromMessage = stringifyErrorContent(error.message?.content ?? error.content)
  if (fromMessage) return { detailedMessage: fromMessage, originalError: fromMessage }
  const fromErrors = Array.isArray(error.errors)
    ? error.errors.map((item) => stringifyErrorContent(item)).filter(Boolean).join('\n')
    : undefined
  if (fromErrors) return { detailedMessage: fromErrors, originalError: fromErrors }
  return { detailedMessage: 'Agent 执行失败', originalError: undefined }
}

/** 各错误码对应的标题与是否可重试（用于构建差异化 TypedError） */
const ERROR_CODE_META: Partial<Record<ErrorCode, { title: string; canRetry: boolean }>> = {
  invalid_api_key: { title: '认证失败', canRetry: true },
  billing_error: { title: '账单错误', canRetry: false },
  rate_limited: { title: '请求频率限制', canRetry: true },
  prompt_too_long: { title: '上下文过长', canRetry: false },
  invalid_request: { title: '请求无效', canRetry: false },
  service_unavailable: { title: '服务暂时不可用', canRetry: true },
  service_error: { title: '服务错误', canRetry: true },
  provider_error: { title: '服务繁忙', canRetry: true },
  network_error: { title: '网络异常', canRetry: true },
  invalid_model: { title: '模型不可用', canRetry: false },
  agent_runtime_not_found: { title: 'Agent 核心未就绪', canRetry: false },
}

/**
 * 判断错误文本是否为 pi runtime 模块加载失败（打包遗漏依赖 / 安装损坏）。
 *
 * 只匹配明确的 Node 模块解析失败措辞，且要求同时提及 pi 运行时包名，
 * 避免上游错误正文里偶然出现包名字符串就被误判为「核心未就绪」（那会错误地丢失可重试性）。
 */
export function isRuntimeNotFoundError(text: string): boolean {
  const isModuleResolutionFailure = /cannot find module|module not found|err_module_not_found|failed to (?:load|resolve)/i.test(text)
  if (!isModuleResolutionFailure) return false
  return /pi-coding-agent|pi-agent-core|@earendil-works/i.test(text)
}

/** 从错误文本中兜底提取 HTTP 状态码（锚定在明确的状态码上下文，避免误匹配正文数字） */
function extractHttpStatusFromErrorText(...messages: Array<string | undefined>): number | null {
  const combined = messages.filter(Boolean).join('\n')
  const patterns = [
    /API Error:\s*(\d{3})/i,
    /API error[^:]*:\s+(\d{3})/i,
    /\b(?:HTTP|status|statusCode)\s*[:=]?\s*(\d{3})\b/i,
    /\b(\d{3})\s+\{[^}]*"error"/is,
  ]
  for (const pattern of patterns) {
    const match = combined.match(pattern)
    const statusCode = match?.[1] ? parseInt(match[1], 10) : NaN
    if (statusCode >= 400 && statusCode < 600) return statusCode
  }
  return null
}

export function mapSDKErrorToTypedError(errorCode: string, message: string, originalError?: string): TypedError {
  const diagnosticText = `${errorCode}\n${message}\n${originalError ?? ''}`

  // thinking-signature：中途切换模型导致思考标签不互认，需保留专属文案与「在新对话继续」动作
  if (isThinkingSignatureError(message, originalError)) {
    return {
      code: 'thinking_signature_invalid',
      title: THINKING_SIGNATURE_ERROR_TITLE,
      message: THINKING_SIGNATURE_ERROR_MESSAGE,
      actions: [
        { key: 'n', label: '在新对话继续', action: 'retry_in_new_session' },
        { key: 'r', label: '重试', action: 'retry' },
      ],
      canRetry: true,
      retryDelayMs: 1000,
      originalError,
    }
  }

  let code: ErrorCode = 'unknown_error'
  const httpStatus = extractHttpStatusFromErrorText(message, originalError, errorCode)
  if (isRuntimeNotFoundError(diagnosticText)) {
    // pi runtime 动态 import 失败（打包遗漏依赖 / 安装损坏），产出定向的「核心未就绪」错误码，
    // 让 UI 给出「请重新安装」引导，而非泛化的 unknown_error
    code = 'agent_runtime_not_found'
  } else if (/api.*key|unauthorized|authentication|invalid.*credential/i.test(diagnosticText)) {
    code = 'invalid_api_key'
  } else if (/billing|quota|insufficient_quota|credit|balance|payment|subscription/i.test(diagnosticText)) {
    code = 'billing_error'
  } else if (/rate.?limit/i.test(diagnosticText) || httpStatus === 429) {
    code = 'rate_limited'
  } else if (isPromptTooLongError(message, originalError, errorCode)) {
    code = 'prompt_too_long'
  } else if (isMalformedResponseError(message, originalError)) {
    // 上游返回无法解析的响应体（网关 HTML 错误页 / SSE 截断 / 脏数据），瞬时异常，可重试
    code = 'service_error'
  } else if (TRANSIENT_NETWORK_PATTERN.test(message) || TRANSIENT_NETWORK_PATTERN.test(originalError ?? '')) {
    code = 'network_error'
  } else if (/overloaded/i.test(diagnosticText) || httpStatus === 529) {
    code = 'provider_error'
  } else if (/service unavailable/i.test(diagnosticText) || httpStatus === 503) {
    code = 'service_unavailable'
  } else if (httpStatus === 500 || httpStatus === 502 || (httpStatus != null && httpStatus >= 500)) {
    // HTTP 5xx（含 500 内部错误 / 502 网关异常）通常为上游瞬时故障，可重试
    code = 'service_error'
  } else if (/invalid request|bad request|400|schema|validation/i.test(diagnosticText)) {
    code = 'invalid_request'
  } else if (/network|fetch|socket|terminated|ECONNRESET/i.test(diagnosticText)) {
    code = 'network_error'
  } else if (/model/i.test(diagnosticText)) {
    code = 'invalid_model'
  }

  const meta = ERROR_CODE_META[code] ?? { title: 'Agent 执行失败', canRetry: false }
  // 认证/渠道配置类错误友好化后文案固定，引导用户直接重新选择模型，而非跳转设置
  const isInvalidChannelOrModel = /请检查是否选择了正确的 Domi 供应渠道和模型/.test(message)

  const actions: RecoveryAction[] = [
    isInvalidChannelOrModel
      ? { key: 'm', label: '重新选择模型', action: 'select_model' }
      : { key: 's', label: '设置', action: 'settings' },
    ...(meta.canRetry ? [{ key: 'r', label: '重试', action: 'retry' }] : []),
    ...(code === 'prompt_too_long' ? [{ key: 'c', label: '压缩上下文', action: 'compact' }] : []),
  ]

  return {
    code,
    title: meta.title,
    message,
    actions,
    canRetry: meta.canRetry,
    retryDelayMs: meta.canRetry ? 1000 : undefined,
    originalError,
  }
}

function findSessionFile(sessionDir: string, sdkSessionId: string): string | undefined {
  if (!existsSync(sessionDir)) return undefined
  for (const entry of readdirSync(sessionDir)) {
    if (entry.endsWith('.jsonl') && entry.includes(sdkSessionId)) {
      return join(sessionDir, entry)
    }
  }
  return undefined
}

function isPathWithinRoot(path: string, root: string): boolean {
  if (path === root) return true
  const rel = relative(root, path)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

function buildAllowedSkillRoots(additionalSkillPaths: string[] | undefined): string[] {
  return (additionalSkillPaths ?? [])
    .map((path) => resolveGuardedRealPath(path))
    .filter((path, index, arr) => arr.indexOf(path) === index)
}

function isDomiSkillPath(path: string | undefined, allowedRoots: string[]): boolean {
  if (!path || allowedRoots.length === 0) return false
  const guardedPath = resolveGuardedRealPath(path)
  return allowedRoots.some((root) => isPathWithinRoot(guardedPath, root))
}

function createDomiSkillsOverride(additionalSkillPaths: string[] | undefined): (base: SkillLoadResult) => SkillLoadResult {
  const allowedRoots = buildAllowedSkillRoots(additionalSkillPaths)
  return (base) => ({
    skills: base.skills.filter((skill) =>
      isDomiSkillPath(skill.filePath, allowedRoots) || isDomiSkillPath(skill.baseDir, allowedRoots)),
    diagnostics: base.diagnostics.filter((diagnostic) => isDomiSkillPath(diagnostic.path, allowedRoots)),
  })
}

function stripSkillFrontmatter(content: string): string {
  const normalized = content.replace(/^\uFEFF/, '')
  const frontmatter = normalized.match(/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/)
  return frontmatter ? normalized.slice(frontmatter[0].length) : content
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function skillCommandAliases(skill: Skill): string[] {
  const aliases = [skill.name, basename(skill.baseDir), basename(dirname(skill.filePath))]
  return aliases.filter((alias, index, arr) => Boolean(alias) && arr.indexOf(alias) === index)
}

function extractSkillCommandNames(prompt: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const match of prompt.matchAll(SKILL_COMMAND_PATTERN)) {
    const name = match[1]?.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }
  return names
}

function buildSkillLookup(skills: Skill[]): Map<string, Skill> {
  const lookup = new Map<string, Skill>()
  for (const skill of skills) {
    for (const alias of skillCommandAliases(skill)) {
      if (!lookup.has(alias)) lookup.set(alias, skill)
    }
  }
  return lookup
}

function formatSkillForPrompt(skill: Skill): string | undefined {
  try {
    const body = stripSkillFrontmatter(readFileSync(skill.filePath, 'utf-8')).trim()
    return `<skill name="${escapeXmlAttribute(skill.name)}" location="${escapeXmlAttribute(skill.filePath)}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`
  } catch (error) {
    console.warn(`[Pi SDK] Skill 展开失败: ${skill.filePath}`, error)
    return undefined
  }
}

async function preparePromptWithDomiSkills(
  resourceLoader: ResourceLoader,
  prompt: string,
  explicitSkillNames?: string[],
): Promise<string> {
  const requestedNames = explicitSkillNames?.length ? explicitSkillNames : extractSkillCommandNames(prompt)
  if (requestedNames.length === 0) return prompt

  // ResourceLoader 在 query 初始化时已完成一次 reload。仅当本条消息实际展开 Skill 时
  // 再按需刷新，兼顾运行中 Skill 更新与普通 coding prompt 的启动性能。
  await resourceLoader.reload()
  const skillLookup = buildSkillLookup(resourceLoader.getSkills().skills)
  const blocks: string[] = []
  const injectedSkillNames = new Set<string>()

  for (const requestedName of requestedNames) {
    const skill = skillLookup.get(requestedName)
    if (!skill || injectedSkillNames.has(skill.name)) continue
    const block = formatSkillForPrompt(skill)
    if (!block) continue
    injectedSkillNames.add(skill.name)
    blocks.push(block)
  }

  if (blocks.length === 0) return prompt
  return `${blocks.join('\n\n')}\n\n${prompt}`
}

function realpathIfExists(path: string): string | undefined {
  try {
    return realpathSync.native(path)
  } catch {
    return undefined
  }
}

function findNearestExistingPath(path: string): string | undefined {
  let current = path
  while (true) {
    try {
      lstatSync(current)
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return undefined
      current = parent
    }
  }
}

function resolveGuardedRealPath(path: string): string {
  const resolved = resolve(path)
  const exact = realpathIfExists(resolved)
  if (exact) return exact

  const nearestExisting = findNearestExistingPath(resolved)
  if (!nearestExisting) return resolved

  const nearestReal = realpathIfExists(nearestExisting)
  if (!nearestReal) return resolved

  const tail = relative(nearestExisting, resolved)
  return tail ? resolve(nearestReal, tail) : nearestReal
}

function createJsonToolResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    details: payload,
  } as AgentToolResult<unknown>
}

function createTextToolResult(text: string, details?: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text }],
    details,
  } as AgentToolResult<unknown>
}

function createTerminatingJsonToolResult(payload: unknown): AgentToolResult<unknown> {
  return {
    ...createJsonToolResult(payload),
    // Compaction must run only after the active Pi agent loop has settled. Continuing
    // this turn would otherwise race with session.compact(), which aborts that loop.
    terminate: true,
  } as AgentToolResult<unknown>
}

export const PI_COMPACTION_CONTINUATION_PROMPT = `<domi_compaction_continuation>
当前会话上下文已经安全压缩。请依据压缩摘要、保留的最近上下文和已持久化的交接状态，继续完成原始用户任务。

- 不要重复已经完成或已提交的操作；先核验当前状态。
- 若仍有工作，立即执行下一项具体行动。
- 只有原始需求全部完成时才给出最终答复；若确实受阻，明确说明阻塞原因。
</domi_compaction_continuation>`

export const PI_COMPACTION_CONTINUATION_CUSTOM_TYPE = 'domi_auto_compaction_continuation'
export const PI_INCOMPLETE_TURN_CONTINUATION_CUSTOM_TYPE = 'domi_incomplete_turn_continuation'
export const PI_COMPACTION_ANCHOR_CUSTOM_TYPE = 'domi_auto_compaction_anchor'

export interface PiAutoCompactionTurnStopControl {
  needsCompaction: () => boolean
  takeCompacted: () => boolean
  takeFailure: () => 'failed' | 'aborted' | undefined
  settle: (outcome: 'success' | 'failed' | 'aborted') => void
}

export async function continuePiAfterCompaction(
  session: Pick<AgentSession, 'sendCustomMessage'>,
  prompt: string,
): Promise<void> {
  await session.sendCustomMessage({
    customType: PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
    content: [{ type: 'text', text: prompt }],
    display: false,
    details: { internal: true, reason: 'auto_compaction_continuation' },
  }, { triggerTurn: true })
}

export async function continuePiAfterIncompleteTurn(
  session: Pick<AgentSession, 'sendCustomMessage'>,
  prompt: string,
): Promise<void> {
  await session.sendCustomMessage({
    customType: PI_INCOMPLETE_TURN_CONTINUATION_CUSTOM_TYPE,
    content: [{ type: 'text', text: prompt }],
    display: false,
    details: { internal: true, reason: 'incomplete_turn_continuation' },
  }, { triggerTurn: true })
}

/** 使用最近一次真实 provider usage，加上其后的工具结果估算下一次请求上下文。 */
export function estimatePiTurnContextTokens(
  messages: AgentMessage[],
  calculateContextTokens: (usage: NonNullable<AssistantMessage['usage']>) => number,
  estimateTokens: (message: AgentMessage) => number,
): number | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.role !== 'assistant') continue
    if (message.stopReason === 'aborted' || message.stopReason === 'error' || !message.usage) continue

    const usageTokens = calculateContextTokens(message.usage)
    if (!Number.isFinite(usageTokens) || usageTokens <= 0) continue
    let trailingTokens = 0
    for (let trailingIndex = index + 1; trailingIndex < messages.length; trailingIndex++) {
      const trailing = messages[trailingIndex]
      if (trailing) trailingTokens += Math.max(0, estimateTokens(trailing))
    }
    return usageTokens + trailingTokens
  }
  return undefined
}

/**
 * Pi 原生阈值压缩只在整个 agent loop 的 agent_end 后检查。长工具任务会在同一个
 * loop 内连续发起 provider request，因此需要在安全 turn 边界提前结束 loop。这里只
 * 标记强制压缩，不能预排 user/steering 消息：最近 provider usage 可能仍低于原生阈值，
 * 那样 Pi 会跳过压缩并直接消费续跑消息。Adapter 必须在 loop 落稳后强制 compact，且
 * 只在确认 compaction_end 成功后用不可见 custom message 恢复原任务。
 */
export function installPiAutoCompactionTurnStop(
  session: AgentSession,
  options: {
    compactThresholdTokens: number
    calculateContextTokens: (usage: NonNullable<AssistantMessage['usage']>) => number
    estimateTokens: (message: AgentMessage) => number
    enabled?: boolean
  },
): PiAutoCompactionTurnStopControl {
  const previousShouldStop = session.agent.shouldStopAfterTurn
  let pending = false
  let compacted = false
  let failure: 'failed' | 'aborted' | undefined
  let disabledAfterFailure = false

  session.agent.shouldStopAfterTurn = async (context, signal) => {
    if (await previousShouldStop?.(context, signal)) return true
    if (options.enabled === false || pending || disabledAfterFailure || context.toolResults.length === 0) return false
    if (context.message.content.some((block) => (
      block.type === 'toolCall' && SESSION_TERMINATING_TOOL_NAMES.has(block.name)
    ))) return false

    let contextTokens: number
    try {
      // turn context 已包含本轮 assistant 与刚完成的 tool results。使用 Pi 自己的估算器，
      // 才能在大段读取/命令输出把下一次请求直接推过窗口前及时停止。
      contextTokens = estimatePiTurnContextTokens(
        context.context.messages,
        options.calculateContextTokens,
        options.estimateTokens,
      ) ?? 0
    } catch {
      return false
    }
    if (!Number.isFinite(contextTokens) || contextTokens <= options.compactThresholdTokens) return false

    pending = true
    return true
  }

  return {
    needsCompaction: () => pending,
    takeCompacted() {
      const result = compacted
      compacted = false
      return result
    },
    takeFailure() {
      const result = failure
      failure = undefined
      return result
    },
    settle(outcome) {
      const wasPending = pending
      if (!wasPending) return
      pending = false
      if (outcome === 'success') {
        failure = undefined
        disabledAfterFailure = false
        compacted = true
        return
      }
      compacted = false
      failure = outcome
      disabledAfterFailure = true
    },
  }
}

export function planPiCompactionContinuation(options: {
  continuationCount: number
  abortRequested: boolean
  runtimeLimitReached: boolean
}):
  | { shouldContinue: true; prompt: string }
  | { shouldContinue: false; reason: 'aborted' | 'runtime_limit' | 'continuation_limit' } {
  if (options.abortRequested) return { shouldContinue: false, reason: 'aborted' }
  if (options.runtimeLimitReached) return { shouldContinue: false, reason: 'runtime_limit' }
  if (options.continuationCount >= MAX_AUTOMATIC_COMPACTION_CONTINUATIONS) {
    return { shouldContinue: false, reason: 'continuation_limit' }
  }
  return { shouldContinue: true, prompt: PI_COMPACTION_CONTINUATION_PROMPT }
}

const SESSION_TERMINATING_TOOL_NAMES = new Set(['CompactContext', 'ForkToWorktree', 'ReadyForReview', 'RequestNextWorktreeIteration', 'RequestWorktreePreviewRevision'])

export function canRunSessionTerminatingTool(toolName: string, toolNames: string[]): boolean {
  return SESSION_TERMINATING_TOOL_NAMES.has(toolName)
    && toolNames.length === 1
    && toolNames[0] === toolName
}

export function canRunCurrentSessionCompaction(toolNames: string[]): boolean {
  return canRunSessionTerminatingTool('CompactContext', toolNames)
}

function installSessionTerminatingToolHooks(session: AgentSession): void {
  const previousBeforeToolCall = session.agent.beforeToolCall
  session.agent.beforeToolCall = async (context, signal) => {
    const previousResult = await previousBeforeToolCall?.(context, signal)
    const toolName = context.toolCall.name
    if (previousResult?.block || !SESSION_TERMINATING_TOOL_NAMES.has(toolName)) return previousResult

    const toolNames = context.assistantMessage.content
      .filter((block) => block.type === 'toolCall')
      .map((block) => block.name)
    if (canRunSessionTerminatingTool(toolName, toolNames)) return previousResult

    // Pi only honors terminate when every tool in a batch is terminating. Rejecting
    // a mixed batch prevents more tool work or another model turn before the host transition.
    return {
      block: true,
      reason: `${toolName} 必须单独调用。请先完成当前工具批次，在下一回合仅调用 ${toolName}。`,
    }
  }
}

/**
 * Pi core 在 prepareNextTurn（含 Extension hooks）之后、读取 steering/follow-up 之前
 * 调用公开的 shouldStopAfterTurn hook。组合已有 hook，确保 Extension 无法在
 * terminating tool 后把父 Local 重新入队。
 */
export function installWorktreeHandoffLoopStop(
  session: AgentSession,
  shouldStop: () => boolean,
): void {
  const previousShouldStop = session.agent.shouldStopAfterTurn
  let queueCleared = false
  session.agent.shouldStopAfterTurn = async (context, signal) => {
    if (await previousShouldStop?.(context, signal)) return true
    if (!shouldStop()) return false
    if (!queueCleared) {
      session.clearQueue()
      queueCleared = true
    }
    return true
  }
}

/**
 * Creates a session-scoped compaction control. The callback is closed over by one
 * query invocation, so a model cannot select or compact any other user session.
 */
export function buildCurrentSessionCompactionTool(
  sdk: PiSdk,
  requestCompaction: () => void,
): ToolDefinition {
  const definition = sdk.defineTool({
    name: 'CompactContext',
    label: '压缩当前会话上下文',
    description: 'Compact only the current Pi Agent session after this turn finishes. Before calling, persist a durable handoff or checkpoint to the session workbench or project files as appropriate. Domi will compact the current session, then automatically continue the original task from the compacted context.',
    promptSnippet: 'CompactContext: after persisting a durable handoff/checkpoint, compact the current session context. Domi will automatically continue the original task after compaction.',
    parameters: Type.Object({}),
    async execute() {
      requestCompaction()
      return createTerminatingJsonToolResult({
        status: 'scheduled',
        message: '将在当前 Agent 回合安全结束后压缩当前会话上下文，并自动从已持久化的交接状态继续原始任务。',
      })
    },
  })

  return definition as unknown as ToolDefinition
}

export function finalizeWorktreeHandoffRequest(
  request: ScheduledWorktreeHandoff,
  point: {
    assistantMessageUuid?: string
    toolResultMessageUuid?: string
    piToolResultEntryId?: string
  },
  control: PiWorktreeHandoffControl,
): void {
  if (!point.assistantMessageUuid || !point.toolResultMessageUuid || !point.piToolResultEntryId) {
    throw new Error('ForkToWorktree 未找到完整的 assistant/tool result 持久化位置，无法安全分叉')
  }
  control.ready({
    task: request.task,
    targetRevision: request.targetRevision,
    targetCurrentOid: request.targetCurrentOid,
    dirtyConfirmed: request.dirtyConfirmed,
    assistantMessageUuid: point.assistantMessageUuid,
    toolResultMessageUuid: point.toolResultMessageUuid,
    piToolResultEntryId: point.piToolResultEntryId,
  })
}

export function buildWorktreeHandoffTool(
  sdk: PiSdk,
  control: PiWorktreeHandoffControl,
  schedule: (request: ScheduledWorktreeHandoff) => void,
): ToolDefinition {
  const definition = sdk.defineTool({
    name: 'ForkToWorktree',
    label: '在 managed Worktree 子会话中继续',
    description: 'End the current interactive Local Pi turn and ask Domi to fork this conversation into a new managed Worktree session, then automatically continue there. Call this tool by itself and provide a self-contained continuation task. Domi performs any required dirty-worktree confirmation; never claim confirmation through tool arguments and never run git worktree add.',
    promptSnippet: 'ForkToWorktree: when this interactive Local Session Target genuinely needs isolation, call this tool by itself with a self-contained continuation task. Domi will confirm dirty Local state when needed, create and open a managed Worktree child, and continue automatically. Uncommitted Local changes are never copied.',
    parameters: Type.Object({
      task: Type.String({ minLength: 1, description: '给新 Worktree 子会话的完整继续执行指令，必须可独立理解。' }),
    }),
    async execute(toolCallId: string, params: unknown, signal?: AbortSignal) {
      const raw = params as { task?: unknown }
      const task = typeof raw.task === 'string' ? raw.task.trim() : ''
      if (!task) throw new Error('ForkToWorktree.task 不能为空')
      const request: WorktreeHandoffRequest = { task }
      const validated = await control.validate(request, signal)
      schedule({ ...request, ...validated, toolCallId })
      return createTerminatingJsonToolResult({
        status: 'scheduled',
        message: '当前 turn 完成后，Domi 将创建 managed Worktree 子会话、自动打开并继续执行。',
      })
    },
  })

  return definition as unknown as ToolDefinition
}

type PiCompactionNoopKind = 'already_compacted' | 'nothing_to_compact'

export type PiCompactionAfterTurnResult =
  | 'compacted'
  | 'already_compacted'
  | 'already_compacted_without_fresh_boundary'
  | 'nothing_to_compact'

function classifyCompactionNoopError(error: unknown): PiCompactionNoopKind | undefined {
  const message = error instanceof Error ? error.message : String(error)
  if (/already compacted/i.test(message)) return 'already_compacted'
  if (/nothing to compact/i.test(message)) return 'nothing_to_compact'
  return undefined
}

function isCompactionNoopError(error: unknown): boolean {
  return classifyCompactionNoopError(error) !== undefined
}

function createCompactionNoopMessage(sessionId: string, kind: PiCompactionNoopKind): SDKMessage {
  return {
    type: 'system',
    subtype: 'status',
    session_id: sessionId,
    compact_result: 'noop',
    message: kind === 'already_compacted'
      ? '当前上下文已经压缩过，无需重复压缩。'
      : '当前 turn 没有可直接丢弃的旧边界，无法继续自动压缩。',
  } as unknown as SDKMessage
}

async function appendPiCompactionAnchor(
  session: Pick<AgentSession, 'sendCustomMessage'>,
): Promise<void> {
  // Pi 的 cut point 不能落在 tool result 上。若一个大型并行工具批次本身把下一请求
  // 推过阈值，prepareCompaction() 会误判 Nothing to compact。追加一个不触发 turn 的
  // 隐藏 custom entry，给 Pi 一个安全的末尾 cut point，再由 Pi 原生摘要整个已完成 turn。
  await session.sendCustomMessage({
    customType: PI_COMPACTION_ANCHOR_CUSTOM_TYPE,
    content: [{ type: 'text', text: 'Domi internal compaction boundary. No user action is requested.' }],
    display: false,
    details: { internal: true, reason: 'auto_compaction_anchor' },
  })
}

// Pi 默认保留最近 20k tokens；若最新的单个工具 turn 本身超过该值，隐藏 anchor
// 仍会被 findCutPoint 跳过。仅在该 noop 后的单次重试里临时降为 0，使 cut point
// 可以落在 anchor 上；finally 恢复实例方法，不修改用户设置或后续压缩策略。
export async function withPiCompactionKeepRecentTokens<T>(
  settingsManager: Pick<SettingsManager, 'getCompactionSettings'>,
  keepRecentTokens: number,
  run: () => Promise<T>,
): Promise<T> {
  const mutable = settingsManager as {
    getCompactionSettings: () => ReturnType<SettingsManager['getCompactionSettings']>
  }
  const original = mutable.getCompactionSettings
  const ownDescriptor = Object.getOwnPropertyDescriptor(settingsManager, 'getCompactionSettings')
  mutable.getCompactionSettings = () => ({
    ...original.call(settingsManager),
    keepRecentTokens,
  })
  try {
    return await run()
  } finally {
    if (ownDescriptor) {
      Object.defineProperty(settingsManager, 'getCompactionSettings', ownDescriptor)
    } else {
      delete (settingsManager as { getCompactionSettings?: SettingsManager['getCompactionSettings'] }).getCompactionSettings
    }
  }
}

export async function compactCurrentSessionAfterTurn(
  session: Pick<AgentSession, 'compact' | 'sendCustomMessage' | 'sessionId'>,
  options: {
    onNoop: (message: SDKMessage) => void
    hasFreshSuccessfulBoundary: () => boolean
    retryAfterAnchor?: () => Promise<unknown>
  },
): Promise<PiCompactionAfterTurnResult> {
  const classifyAlreadyCompacted = (): PiCompactionAfterTurnResult => {
    options.onNoop(createCompactionNoopMessage(session.sessionId, 'already_compacted'))
    return options.hasFreshSuccessfulBoundary()
      ? 'already_compacted'
      : 'already_compacted_without_fresh_boundary'
  }

  try {
    await session.compact()
    return 'compacted'
  } catch (error) {
    const kind = classifyCompactionNoopError(error)
    if (!kind) throw error
    if (kind === 'already_compacted') return classifyAlreadyCompacted()
  }

  // A just-completed tool turn can be too large while still having no Pi cut point after
  // its tool results. The anchor is persisted without triggerTurn, so no provider request or
  // user-like continuation can consume it before compaction succeeds.
  await appendPiCompactionAnchor(session)
  try {
    await (options.retryAfterAnchor?.() ?? session.compact())
    return 'compacted'
  } catch (error) {
    const kind = classifyCompactionNoopError(error)
    if (!kind) throw error
    if (kind === 'already_compacted') return classifyAlreadyCompacted()
    options.onNoop(createCompactionNoopMessage(session.sessionId, kind))
    return 'nothing_to_compact'
  }
}

function createCompactionContinuationLimitResult(sessionId: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    terminal_reason: 'compaction_continuation_limit',
    errors: [`自动压缩续跑已达上限（${MAX_AUTOMATIC_COMPACTION_CONTINUATIONS} 次），任务未确认完成。请检查当前状态后继续。`],
    session_id: sessionId,
  } as unknown as SDKMessage
}

function stringFromInput(input: Record<string, unknown>, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return fallback
}

function normalizeTaskStatus(value: unknown, fallback: DomiTaskItem['status']): DomiTaskItem['status'] {
  if (
    value === 'pending' ||
    value === 'in_progress' ||
    value === 'completed' ||
    value === 'blocked' ||
    value === 'cancelled' ||
    value === 'error' ||
    value === 'deleted'
  ) {
    return value
  }
  return fallback
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.map((item) => String(item).trim()).filter(Boolean)
  return items.length > 0 ? items : undefined
}

function buildDomiProductToolDefinitions(
  sdk: PiSdk,
  input: PiAgentQueryOptions,
  runtimeState: DomiProductToolRuntimeState = { tasks: new Map(), nextTaskId: 1 },
): ToolDefinition[] {
  const { tasks } = runtimeState
  const emitTasksChanged = (): void => {
    input.onTasksChanged?.([...tasks.values()].map((task) => ({
      ...task,
      ...(task.blocks ? { blocks: [...task.blocks] } : {}),
    })))
  }

  const definitions = [
    sdk.defineTool({
      name: 'EnterPlanMode',
      label: '进入计划模式',
      description: '进入 Domi 计划模式。进入后只能调研、整理计划，并等待用户批准后再执行写操作。',
      promptSnippet: '进入计划模式，先调研并整理完整计划；提交审批时宿主会把计划保存到当前会话的 .context/plan/current-plan.md。',
      parameters: Type.Object({
        reason: Type.Optional(Type.String({ description: '进入计划模式的原因。' })),
      }),
      async execute(_toolCallId, params) {
        return createTextToolResult('已进入计划模式。', { active: true, input: params })
      },
    }),
    sdk.defineTool({
      name: 'RequestDirectWorkflow',
      label: '请求切换为 Direct',
      description: '当前处于 Read Only 且完成必要探索后，明确需要写入文件或执行命令时调用。小调整不必生成完整 Plan，但必须提供一段与任务规模匹配的 Markdown 反馈，让用户看懂调研后的继续方向，以及批准后会立即实施什么；不强制固定标题、字段或表达顺序。宿主会像 Plan 一样把正文展示在主会话区，底部只保留批准操作。复杂或高风险任务先用 EnterPlanMode。Execution Policy 保持不变。',
      promptSnippet: '提交自然组织的 Markdown 实施反馈到主会话区；用户批准后切换 Direct 并立即实施。',
      parameters: Type.Object({
        details: Type.String({ minLength: 1, maxLength: 12_000, description: '调研后的实施反馈正文。支持 Markdown；可用一句话、列表或小标题自然组织，不要求固定模板。必须说明准备如何继续，以及批准后会实施什么。' }),
        summary: Type.Optional(Type.String({ maxLength: 240, description: '可选的简短主题，用于主会话反馈块标题；不要重复 details。' })),
      }),
      async execute(_toolCallId, params, signal) {
        if (!input.handleRequestDirectWorkflow) throw new Error('RequestDirectWorkflow 宿主处理器不可用')
        const result = await input.handleRequestDirectWorkflow(
          params as Record<string, unknown>,
          signal ?? new AbortController().signal,
        )
        if (result.behavior === 'deny') throw new Error(result.message)
        return createTextToolResult('当前会话已切换为 Direct，可以按原目标继续执行。', {
          workflow: 'direct',
          executionPolicyChanged: false,
        })
      },
    }),
    sdk.defineTool({
      name: 'ExitPlanMode',
      label: '提交计划审批',
      description: '向用户提交完整计划并请求批准。宿主会先将计划保存到当前会话的 .context/plan/current-plan.md；用户批准后才能退出计划模式并继续执行。',
      promptSnippet: '提交完整计划正文供审批；宿主会创建固定计划文件入口，等待用户批准后继续执行。',
      parameters: Type.Object({
        plan: Type.String({ minLength: 1, description: '完整计划正文。宿主会将其保存为当前会话的 .context/plan/current-plan.md。' }),
        allowedPrompts: Type.Optional(Type.Array(Type.Object({
          tool: Type.String({ description: '批准后可执行的工具，通常为 Bash。' }),
          prompt: Type.String({ description: '批准后可执行的命令或操作描述。' }),
        }))),
      }),
      async execute(_toolCallId, params, signal) {
        if (!input.handleExitPlanMode) throw new Error('ExitPlanMode 宿主处理器不可用')
        const result = await input.handleExitPlanMode(
          params as Record<string, unknown>,
          signal ?? new AbortController().signal,
        )
        if (result.behavior === 'deny') {
          if (result.stop) {
            return createTerminatingJsonToolResult({ approved: false, stopped: true, message: result.message })
          }
          throw new Error(result.message)
        }
        return createTextToolResult('计划已获批准，可以按当前 Execution Policy 继续执行。', { approved: true })
      },
    }),
    sdk.defineTool({
      name: 'AskUserQuestion',
      label: '询问用户',
      description: '当需要用户选择、补充信息或确认偏好时调用，Domi 会展示可交互问答横幅。',
      promptSnippet: '向用户提出结构化问题并等待回答。',
      parameters: Type.Object({
        questions: Type.Array(Type.Object({
          question: Type.String({ description: '要询问用户的问题。' }),
          header: Type.Optional(Type.String({ description: '简短标题。' })),
          multiSelect: Type.Optional(Type.Boolean({ description: '是否允许多选。' })),
          options: Type.Optional(Type.Array(Type.Object({
            label: Type.String({ description: '选项标签。' }),
            description: Type.Optional(Type.String({ description: '选项说明。' })),
            preview: Type.Optional(Type.String({ description: '可选预览内容。' })),
          }))),
        })),
        answers: Type.Optional(Type.Record(Type.String(), Type.String())),
      }),
      async execute(_toolCallId, params, signal) {
        if (!input.handleAskUserQuestion) throw new Error('AskUserQuestion 宿主处理器不可用')
        const result = await input.handleAskUserQuestion(
          params as Record<string, unknown>,
          signal ?? new AbortController().signal,
        )
        if (result.behavior === 'deny') throw new Error(result.message)
        return createJsonToolResult({ answers: result.updatedInput?.answers ?? {} })
      },
    }),
    sdk.defineTool({
      name: 'TaskCreate',
      label: '创建任务',
      description: '创建一个可见进度任务，用于多步骤或长耗时工作。',
      promptSnippet: '创建一个可见进度任务。',
      parameters: Type.Object({
        subject: Type.String({ description: '任务标题。' }),
        description: Type.Optional(Type.String({ description: '任务说明。' })),
        activeForm: Type.Optional(Type.String({ description: '当前活动形态或阶段。' })),
        blocks: Type.Optional(Type.Array(Type.String({ description: '关联区块 ID。' }))),
      }),
      async execute(_toolCallId, params) {
        const input = params as Record<string, unknown>
        const id = stringFromInput(input, ['id', 'taskId', 'task_id'], String(runtimeState.nextTaskId++))
        const task: DomiTaskItem = {
          id,
          subject: stringFromInput(input, ['subject', 'title', 'name'], `任务 #${id}`),
          status: 'pending',
          description: typeof input.description === 'string' ? input.description : undefined,
          activeForm: typeof input.activeForm === 'string' ? input.activeForm : undefined,
          blocks: normalizeStringArray(input.blocks),
        }
        tasks.set(id, task)
        emitTasksChanged()
        return createJsonToolResult({ task })
      },
    }),
    sdk.defineTool({
      name: 'TaskUpdate',
      label: '更新任务',
      description: '更新已有可见进度任务的状态、标题或说明。',
      promptSnippet: '更新可见进度任务。',
      parameters: Type.Object({
        taskId: Type.String({ description: '任务 ID。' }),
        status: Type.Optional(Type.Union([
          Type.Literal('pending'),
          Type.Literal('in_progress'),
          Type.Literal('completed'),
          Type.Literal('blocked'),
          Type.Literal('cancelled'),
          Type.Literal('error'),
          Type.Literal('deleted'),
        ])),
        subject: Type.Optional(Type.String({ description: '新的任务标题。' })),
        description: Type.Optional(Type.String({ description: '新的任务说明。' })),
        activeForm: Type.Optional(Type.String({ description: '当前活动形态或阶段。' })),
        blocks: Type.Optional(Type.Array(Type.String({ description: '关联区块 ID。' }))),
      }),
      async execute(_toolCallId, params) {
        const input = params as Record<string, unknown>
        const id = stringFromInput(input, ['taskId', 'task_id', 'id'])
        if (!id) throw new Error('taskId 必填')
        const existing = tasks.get(id)
        const task: DomiTaskItem = {
          id,
          subject: stringFromInput(input, ['subject', 'title', 'name'], existing?.subject ?? `任务 #${id}`),
          status: normalizeTaskStatus(input.status, existing?.status ?? 'pending'),
          description: typeof input.description === 'string' ? input.description : existing?.description,
          activeForm: typeof input.activeForm === 'string' ? input.activeForm : existing?.activeForm,
          blocks: normalizeStringArray(input.blocks) ?? existing?.blocks,
        }
        tasks.set(id, task)
        emitTasksChanged()
        return createJsonToolResult({ task })
      },
    }),
    sdk.defineTool({
      name: 'TaskGet',
      label: '查看任务',
      description: '读取某个可见进度任务的当前状态。',
      promptSnippet: '查看可见进度任务。',
      parameters: Type.Object({
        taskId: Type.String({ description: '任务 ID。' }),
      }),
      async execute(_toolCallId, params) {
        const input = params as Record<string, unknown>
        const id = stringFromInput(input, ['taskId', 'task_id', 'id'])
        if (!id) throw new Error('taskId 必填')
        const task = tasks.get(id)
        if (!task) throw new Error(`任务不存在: ${id}`)
        return createJsonToolResult({ task })
      },
    }),
    sdk.defineTool({
      name: 'TaskList',
      label: '任务列表',
      description: '列出当前 turn 中已创建的可见进度任务。',
      promptSnippet: '列出可见进度任务。',
      parameters: Type.Object({
        reason: Type.Optional(Type.String({ description: '读取任务列表的原因。' })),
      }),
      async execute() {
        return createJsonToolResult({ tasks: [...tasks.values()].filter((task) => task.status !== 'deleted') })
      },
    }),
    sdk.defineTool({
      name: 'TodoRead',
      label: '读取待办',
      description: '读取当前 turn 的任务列表。兼容 Claude SDK 的 TodoRead。',
      promptSnippet: '读取当前待办列表。',
      parameters: Type.Object({}),
      async execute() {
        return createJsonToolResult({ todos: [...tasks.values()].filter((task) => task.status !== 'deleted') })
      },
    }),

  ] as unknown as ToolDefinition[]

  return definitions
}

const WSL_EXPORT_ENV_KEYS = [
  'DOMI_CLI',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'DOMI_WINDOWS_SHELL',
  'DOMI_WSL_DISTRO',
] as const

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, String.raw`'\''`)}'`
}

export function windowsPathToWslPath(value: string): string {
  const driveMatch = value.match(/^([A-Za-z]):[\\/](.*)$/)
  if (!driveMatch) return value
  const drive = driveMatch[1]!.toLowerCase()
  const rest = driveMatch[2]!.replace(/\\/g, '/')
  return `/mnt/${drive}/${rest}`
}

function buildWslCommand(command: string, env: NodeJS.ProcessEnv | undefined): string {
  const exportLines: string[] = []
  for (const key of WSL_EXPORT_ENV_KEYS) {
    const rawValue = env?.[key]
    if (!rawValue) continue
    const value = key === 'DOMI_CLI' ? windowsPathToWslPath(rawValue) : rawValue
    exportLines.push(`export ${key}=${shellQuote(value)}`)
  }

  return exportLines.length > 0
    ? `${exportLines.join('\n')}\n${command}`
    : command
}

export function buildWslBashArgs(
  runtimeEnv: Pick<AgentRuntimeEnv, 'wslDistro'>,
  cwd: string,
  command: string,
  env: NodeJS.ProcessEnv | undefined,
): string[] {
  return [
    ...(runtimeEnv.wslDistro ? ['--distribution', runtimeEnv.wslDistro] : []),
    '--cd',
    windowsPathToWslPath(cwd),
    '--exec',
    'bash',
    '-lc',
    buildWslCommand(command, env),
  ]
}

function createWslBashOperations(runtimeEnv: AgentRuntimeEnv): BashOperations {
  return {
    exec(command, cwd, options) {
      return new Promise((resolve, reject) => {
        const mergedEnv = mergeRuntimeEnv(process.env, options.env)
        const args = buildWslBashArgs(runtimeEnv, cwd, command, mergedEnv)
        const child = spawn(runtimeEnv.wslCommand ?? 'wsl.exe', args, {
          env: mergedEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        let settled = false
        let timedOut = false
        let timeoutHandle: NodeJS.Timeout | undefined

        const cleanup = (): void => {
          if (timeoutHandle) clearTimeout(timeoutHandle)
          options.signal?.removeEventListener('abort', onAbort)
        }
        const settle = (fn: () => void): void => {
          if (settled) return
          settled = true
          cleanup()
          fn()
        }
        const killChild = (): void => {
          if (!child.killed) child.kill('SIGTERM')
        }
        const onAbort = (): void => {
          killChild()
        }

        if (options.signal?.aborted) {
          killChild()
          settle(() => reject(new Error('aborted')))
          return
        }

        child.stdout?.on('data', options.onData)
        child.stderr?.on('data', options.onData)
        child.on('error', (error) => {
          settle(() => reject(error))
        })
        child.on('close', (code) => {
          if (options.signal?.aborted) {
            settle(() => reject(new Error('aborted')))
          } else if (timedOut) {
            settle(() => reject(new Error(`timeout:${options.timeout}`)))
          } else {
            settle(() => resolve({ exitCode: code }))
          }
        })

        if (options.timeout !== undefined && options.timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true
            killChild()
          }, options.timeout * 1000)
        }
        options.signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
  }
}

type CreateLocalBashOperations = (options?: { shellPath?: string }) => BashOperations

type SuccessfulFrozenBunInstallCallback = NonNullable<PiAgentQueryOptions['onSuccessfulFrozenBunInstall']>

function wrapBashOperationsForDependencySnapshot(
  operations: BashOperations,
  onSuccessfulFrozenBunInstall: SuccessfulFrozenBunInstallCallback,
): BashOperations {
  return {
    async exec(command, cwd, options) {
      const result = await operations.exec(command, cwd, options)
      if (result.exitCode === 0 && isExactFrozenBunInstallCommand(command)) {
        try {
          await onSuccessfulFrozenBunInstall({ cwd, command, signal: options.signal })
        } catch (error) {
          console.warn('[dependency-snapshot] successful install capture callback failed:', error)
        }
      }
      return result
    },
  }
}

export function createDomiBashToolOptions(
  runtimeEnv: AgentRuntimeEnv | undefined,
  getWorkflow?: () => AgentWorkflow,
  onSuccessfulFrozenBunInstall?: SuccessfulFrozenBunInstallCallback,
  createLocalOperations?: CreateLocalBashOperations,
): BashToolOptions {
  const spawnHook: NonNullable<BashToolOptions['spawnHook']> = ({ command, cwd, env }) => {
    if (runtimeEnv?.shellKind === 'git-bash' && hasGitBashCmdNullDeviceRedirection(command)) {
      throw new Error(
        '检测到 Git Bash 命令使用 CMD 空设备重定向 `>nul` / `2>nul`；这会在当前目录创建实体 `nul` 文件。'
        + '请将 Bash 重定向改为 `/dev/null`。若必须使用 `cmd.exe /c`，请把包含 `>nul` 的 CMD 子命令作为引号内参数传入。',
      )
    }

    const workflow = getWorkflow?.()
    const hardenedCommand = workflow && workflow !== 'direct'
      ? hardenReadOnlyBashCommand(command)
      : command
    const mergedEnv = mergeRuntimeEnv(env, runtimeEnv?.env)
    if (workflow && workflow !== 'direct') {
      // 受限 workflow 的只读 CLI 不应因 pager、credential prompt 或 update notifier
      // 产生交互/隐式状态变化；命令分类器仍负责证明具体调用只读。
      mergedEnv.GIT_OPTIONAL_LOCKS = '0'
      mergedEnv.GIT_CONFIG_COUNT = '0'
      mergedEnv.GIT_TERMINAL_PROMPT = '0'
      mergedEnv.GIT_PAGER = 'cat'
      mergedEnv.GH_PROMPT_DISABLED = '1'
      mergedEnv.GH_NO_UPDATE_NOTIFIER = '1'
      mergedEnv.GH_PAGER = 'cat'
      mergedEnv.PAGER = 'cat'
      mergedEnv.TAR_OPTIONS = ''
      mergedEnv.UNZIP = ''
      mergedEnv.UNZIPOPT = ''
      mergedEnv.ZIPINFO = ''
      mergedEnv.ZIPINFOOPT = ''
    }
    return {
      command: hardenedCommand,
      cwd,
      env: mergedEnv,
    }
  }

  if (runtimeEnv?.shellKind === 'wsl') {
    const operations = createWslBashOperations(runtimeEnv)
    return {
      operations: onSuccessfulFrozenBunInstall
        ? wrapBashOperationsForDependencySnapshot(operations, onSuccessfulFrozenBunInstall)
        : operations,
      spawnHook,
    }
  }

  const localOperations = onSuccessfulFrozenBunInstall
    ? createLocalOperations?.({ ...(runtimeEnv?.shellPath && { shellPath: runtimeEnv.shellPath }) })
    : undefined
  return {
    ...(localOperations
      ? { operations: wrapBashOperationsForDependencySnapshot(localOperations, onSuccessfulFrozenBunInstall!) }
      : runtimeEnv?.shellPath
        ? { shellPath: runtimeEnv.shellPath }
        : {}),
    spawnHook,
  }
}

export function wrapPiFileMutationToolDefinitions(
  definitions: readonly ToolDefinition[],
  callbacks: PiFileCheckpointCallbacks | undefined,
): ToolDefinition[] {
  if (!callbacks) return [...definitions]
  return definitions.map((definition) => {
    if (definition.name !== 'write' && definition.name !== 'edit') return definition
    const execute = definition.execute.bind(definition)
    return {
      ...definition,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const filePath = typeof (params as { path?: unknown }).path === 'string'
          ? (params as { path: string }).path
          : undefined
        let tracked = false
        if (filePath) {
          try {
            tracked = (await callbacks.beforeMutation(filePath)) !== false
          } catch (error) {
            callbacks.onError?.('before', filePath, error)
          }
        }
        try {
          const result = await execute(toolCallId, params, signal, onUpdate, ctx)
          if (filePath && tracked) {
            try {
              await callbacks.afterMutation(filePath)
            } catch (error) {
              callbacks.onError?.('after', filePath, error)
            }
          }
          return result
        } catch (toolError) {
          // Pi Write/Edit 可能在落盘后的 abort 检查中抛错；重新捕获实际磁盘状态，
          // 既不吞原工具错误，也不把受控写入误判成人工冲突。
          if (filePath && tracked) {
            try {
              await callbacks.afterMutation(filePath)
            } catch (error) {
              callbacks.onError?.('after', filePath, error)
            }
          }
          throw toolError
        }
      },
    } as ToolDefinition
  })
}

function buildBuiltinToolDefinitions(
  sdk: PiSdk,
  cwd: string,
  runtimeEnv: AgentRuntimeEnv | undefined,
  getWorkflow?: () => AgentWorkflow,
  onSuccessfulFrozenBunInstall?: SuccessfulFrozenBunInstallCallback,
  fileCheckpoint?: PiFileCheckpointCallbacks,
): ToolDefinition[] {
  const definitions = [
    sdk.createReadToolDefinition(cwd),
    sdk.createBashToolDefinition(cwd, createDomiBashToolOptions(
      runtimeEnv,
      getWorkflow,
      onSuccessfulFrozenBunInstall,
      sdk.createLocalBashOperations,
    )),
    sdk.createEditToolDefinition(cwd),
    sdk.createWriteToolDefinition(cwd),
    sdk.createGrepToolDefinition(cwd),
    sdk.createFindToolDefinition(cwd),
    sdk.createLsToolDefinition(cwd),
  ] as unknown as ToolDefinition[]

  return wrapPiFileMutationToolDefinitions(definitions, fileCheckpoint)
}

interface PiToolGate {
  promise: Promise<void>
  resolve: () => void
}

interface PiScheduledToolCall extends PiToolCallDescriptor {
  batch: PiToolBatch
  schedule?: PiToolCallSchedule
}

interface PiToolBatch {
  toolCalls: PiScheduledToolCall[]
  planned: boolean
}

interface PiToolCallSchedule {
  startAfter: Promise<void>
  finalized: PiToolGate
}

interface PiToolExecutionCoordinator {
  register: (assistantMessage: object, toolCall: PiToolCallDescriptor) => void
  execute: <TResult>(
    toolCallId: string,
    toolName: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<TResult>,
  ) => Promise<TResult>
  finalize: <TResult>(
    toolCallId: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<TResult>,
  ) => Promise<TResult>
}

const RESOLVED_PI_TOOL_GATE = Promise.resolve()

function createPiToolGate(): PiToolGate {
  let resolveGate = (): void => {}
  const promise = new Promise<void>((resolve) => { resolveGate = resolve })
  return { promise, resolve: resolveGate }
}

async function waitForPiToolGate(gate: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    await gate
    return
  }
  if (signal.aborted) throw createAbortError()

  let onAbort = (): void => {}
  const abortPromise = new Promise<void>((_resolve, reject) => {
    onAbort = () => { reject(createAbortError()) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([gate, abortPromise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function createPiToolExecutionCoordinator(
  isReadOnlyTool: (toolName: string) => boolean,
): PiToolExecutionCoordinator {
  const batches = new WeakMap<object, PiToolBatch>()
  const toolCalls = new Map<string, PiScheduledToolCall>()

  const ensureSchedule = (toolCall: PiScheduledToolCall): PiToolCallSchedule => {
    const batch = toolCall.batch
    if (!batch.planned) {
      let previousGroupFinalized = RESOLVED_PI_TOOL_GATE

      for (const group of partitionToolCalls(batch.toolCalls, isReadOnlyTool)) {
        const groupSchedules = group.toolCalls.map((pendingToolCall) => {
          const finalized = createPiToolGate()
          pendingToolCall.schedule = {
            startAfter: previousGroupFinalized,
            finalized,
          }
          return pendingToolCall.schedule
        })
        previousGroupFinalized = Promise.all(
          groupSchedules.map((schedule) => schedule.finalized.promise),
        ).then(() => undefined)
      }
      batch.planned = true
    }

    if (!toolCall.schedule) throw new Error(`Pi 工具调用未进入执行计划: ${toolCall.name}`)
    return toolCall.schedule
  }

  return {
    register(assistantMessage, toolCall) {
      let batch = batches.get(assistantMessage)
      if (!batch) {
        batch = { toolCalls: [], planned: false }
        batches.set(assistantMessage, batch)
      }
      if (batch.planned) throw new Error('Pi 工具批次已开始执行，拒绝迟到的工具调用')
      if (toolCalls.has(toolCall.id)) throw new Error(`Pi 工具调用 ID 重复: ${toolCall.id}`)

      const scheduledToolCall: PiScheduledToolCall = { ...toolCall, batch }
      batch.toolCalls.push(scheduledToolCall)
      toolCalls.set(toolCall.id, scheduledToolCall)
    },

    async execute<TResult>(
      toolCallId: string,
      toolName: string,
      signal: AbortSignal | undefined,
      operation: () => Promise<TResult>,
    ): Promise<TResult> {
      const toolCall = toolCalls.get(toolCallId)
      if (!toolCall) {
        throw new Error(`Pi 工具调用未通过批次预检，已保守拒绝执行: ${toolName}`)
      }
      const schedule = ensureSchedule(toolCall)

      await waitForPiToolGate(schedule.startAfter, signal)
      return operation()
    },

    async finalize<TResult>(
      toolCallId: string,
      signal: AbortSignal | undefined,
      operation: () => Promise<TResult>,
    ): Promise<TResult> {
      const toolCall = toolCalls.get(toolCallId)
      if (!toolCall) return operation()
      const schedule = ensureSchedule(toolCall)
      try {
        return await operation()
      } finally {
        schedule.finalized.resolve()
        toolCalls.delete(toolCallId)
      }
    },
  }
}

/**
 * Pi SDK 0.82.1 只有整批 parallel / sequential；parallel 会先串行执行全部 beforeToolCall，
 * 再并发调用 execute。利用这个稳定前置阶段登记批次，并在 execute / afterToolCall 外围加门闩：
 * 只读工具实际并行，副作用工具等待全部只读完成后再逐个执行。
 */
export function installPiToolExecutionScheduler(
  session: AgentSession,
  isReadOnlyTool: (toolName: string) => boolean = isParallelReadOnlyPiToolName,
): void {
  const coordinator = createPiToolExecutionCoordinator(isReadOnlyTool)
  const wrappedTools = new WeakSet<object>()

  const wrapActiveTools = (): void => {
    let changed = false
    const nextTools = session.agent.state.tools.map((tool) => {
      if (wrappedTools.has(tool)) return tool
      changed = true
      const wrappedTool = {
        ...tool,
        executionMode: 'parallel' as const,
        execute: (...args: Parameters<typeof tool.execute>) => coordinator.execute(
          args[0],
          tool.name,
          args[2],
          () => tool.execute(...args),
        ),
      }
      wrappedTools.add(wrappedTool)
      return wrappedTool
    })
    if (changed) session.agent.state.tools = nextTools
  }

  session.agent.toolExecution = 'parallel'
  wrapActiveTools()

  const previousBeforeToolCall = session.agent.beforeToolCall
  session.agent.beforeToolCall = async (context, signal) => {
    const previousResult = await previousBeforeToolCall?.(context, signal)
    if (!previousResult?.block && !signal?.aborted) {
      coordinator.register(context.assistantMessage, context.toolCall)
    }
    return previousResult
  }

  const previousAfterToolCall = session.agent.afterToolCall
  session.agent.afterToolCall = (context, signal) => coordinator.finalize(
    context.toolCall.id,
    signal,
    async () => previousAfterToolCall?.(context, signal),
  )

  const previousPrepareNextTurnWithContext = session.agent.prepareNextTurnWithContext
  if (previousPrepareNextTurnWithContext) {
    session.agent.prepareNextTurnWithContext = async (context, signal) => {
      wrapActiveTools()
      const snapshot = await previousPrepareNextTurnWithContext(context, signal)
      wrapActiveTools()
      if (!snapshot?.context) return snapshot
      return {
        ...snapshot,
        context: {
          ...snapshot.context,
          tools: session.agent.state.tools.slice(),
        },
      }
    }
  }
}

export function installRuntimeGuardHooks(session: AgentSession, guard: AgentRuntimeGuard): void {
  const previousAfterToolCall = session.agent.afterToolCall
  session.agent.afterToolCall = async (context, signal) => {
    const previousResult = await previousAfterToolCall?.(context, signal)
    const resultAfterPreviousHooks = {
      content: previousResult?.content ?? context.result.content,
      details: previousResult?.details ?? context.result.details,
      terminate: previousResult?.terminate ?? context.result.terminate,
    }
    const guardedResult = guard.applyToolResult(resultAfterPreviousHooks)

    if (!previousResult && guardedResult.terminate === context.result.terminate) {
      return undefined
    }

    return {
      ...previousResult,
      terminate: guardedResult.terminate,
    }
  }

  const previousPrepareNextTurnWithContext = session.agent.prepareNextTurnWithContext
  session.agent.prepareNextTurnWithContext = async (context, signal) => {
    const previousSnapshot = await previousPrepareNextTurnWithContext?.(context, signal)
    if (guard.shouldStopBeforeNextTurn()) {
      // Pi 的 steer/follow-up 队列在 turn 完成后才 drain；达到 Domi 上限时必须在这里清空，
      // 否则纯文本 turn 之后追加的队列消息会绕过 afterToolCall 继续进入下一轮。
      session.agent.clearAllQueues()
    }
    return previousSnapshot
  }
}

export class PiAgentAdapter implements AgentProviderAdapter {
  private activeSessions = new Map<string, ActivePiSession>()

  constructor(
    private readonly extensionTrustStore: ExtensionTrustStore = new FileExtensionTrustStore(getExtensionTrustPath()),
  ) {}

  async *query(input: PiAgentQueryOptions): AsyncIterable<SDKMessage> {
    const active = createActivePiSession()
    this.activeSessions.set(input.sessionId, active)
    const queue = createAsyncQueue<SDKMessage>()
    const runtimeGuard = createAgentRuntimeGuard(input)
    // 同一 session 的新请求可能在旧 IPC 事件之后开始；所有 retry 生命周期均携带这一轮标识。
    const retryRunStartedAt = input.retryRunStartedAt ?? Date.now()
    const auditRecorder = createPiRunAuditRecorder({
      sessionId: input.sessionId,
      ...(input.auditWorkspaceId && { workspaceId: input.auditWorkspaceId }),
      runStartedAt: retryRunStartedAt,
      onTimingEvent: input.onAuditTimingEvent,
    })
    active.runtimeGuard = runtimeGuard
    let unsubscribe: (() => void) | undefined
    let requestProxyDispatcher: Dispatcher | undefined
    let assistantDeltaCoalescer: DeltaBatchCoalescer<AgentAssistantDelta> | undefined

    const cleanupActiveSession = (): void => {
      try {
        unsubscribe?.()
        unsubscribe = undefined
        active.processNativeQueueSnapshot = undefined
        active.nativeQueueDeliverySuppression.deferredSnapshot = undefined
        assistantDeltaCoalescer?.dispose()
        assistantDeltaCoalescer = undefined
        if (!active.disposed) {
          active.disposed = true
          rejectPendingInterruptPrompts(active, createAbortError())
          active.session?.dispose()
        }
        if (this.activeSessions.get(input.sessionId) === active) {
          this.activeSessions.delete(input.sessionId)
        }
      } finally {
        void closePiRequestProxyDispatcher(requestProxyDispatcher)
        requestProxyDispatcher = undefined
      }
    }

    try {
      installPiRequestProxyFetch()
      requestProxyDispatcher = createPiRequestProxyDispatcher({
        proxyUrl: resolvePiHttpProxy(input),
        noProxy: getCaseInsensitiveRuntimeEnvValue(input.runtimeEnv?.env, 'NO_PROXY'),
        httpIdleTimeoutMs: input.httpIdleTimeoutMs,
      })
      const sdk = await import('@earendil-works/pi-coding-agent')
      const piAi = input.codexFastMode && input.provider === 'openai-codex'
        ? await import('@earendil-works/pi-ai/compat')
        : undefined
      if (active.abortRequested) throw createAbortError()

      if (!existsSync(input.piSessionDir)) mkdirSync(input.piSessionDir, { recursive: true })
      const cwd = input.cwd ?? process.cwd()
      const sessionFile = input.resumeSessionId ? findSessionFile(input.piSessionDir, input.resumeSessionId) : undefined
      if (input.resumeSessionId && !sessionFile) {
        throw new Error(`No conversation found with session ID ${input.resumeSessionId}`)
      }
      const sessionManager = sessionFile
        ? sdk.SessionManager.open(sessionFile, input.piSessionDir, cwd)
        : sdk.SessionManager.create(cwd, input.piSessionDir)
      if (Object.prototype.hasOwnProperty.call(input, 'resumeTreeLeafId')) {
        if (input.resumeTreeLeafId === null) sessionManager.resetLeaf()
        else if (input.resumeTreeLeafId) sessionManager.branch(input.resumeTreeLeafId)
        input.onTreeNavigationApplied?.()
      }
      const { modelRuntime, model, contextWindowSource } = await buildModel(sdk, input)
      const autoCompactionReserveTokens = calculatePiAutoCompactionReserveTokens(
        model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      )
      const autoCompactionThresholdTokens = (model.contextWindow ?? DEFAULT_CONTEXT_WINDOW)
        - autoCompactionReserveTokens
      let compactContextRequested = false
      let pendingWorktreeHandoff: ScheduledWorktreeHandoff | undefined
      let worktreeHandoffFinalized = false
      let pendingCompactionContinuation: string | undefined
      let automaticCompactionContinuations = 0
      let pendingIncompleteTurnContinuation: string | undefined
      let automaticIncompleteTurnContinuations = 0
      let activePromptOutputEvidence: PiPromptOutputEvidence | undefined
      let pendingTerminalResult: SDKMessage | undefined
      let pendingInlineCompactionFailure: string | undefined
      let successfulCompactionBoundaryVersion = 0
      let activeCompactionLifecycle: {
        attemptId: string
        startedAt: number
        reason: 'manual' | 'threshold' | 'overflow'
        inline?: boolean
        providerRequestOrdinal: number
        lastProviderRequestId?: string
      } | undefined
      const contextCompactorMode = input.contextCompactor?.mode
      let contextCompactorLifecycleActive = true
      const contextCompactorSettings = resolvePiContextCompactorSettings({
        ...input.contextCompactor?.settings,
        enabled: contextCompactorMode === 'observe' || contextCompactorMode === 'enhance',
      })
      const productToolRuntimeState: DomiProductToolRuntimeState = { tasks: new Map(), nextTaskId: 1 }
      const getContextCompactorHostSnapshot = async (signal: AbortSignal): Promise<PiContextCompactorHostSnapshot> => {
        const host = await input.contextCompactor?.getHostSnapshot?.(signal) ?? {}
        const tasks = [...productToolRuntimeState.tasks.values()].map(task => ({
          ...task,
          ...(task.blocks ? { blocks: [...task.blocks] } : {}),
        }))
        return {
          ...host,
          ...(tasks.length > 0 ? { tasks } : {}),
          ...(active.worktreeHandoffTerminating ? { terminatingToolName: 'ForkToWorktree' } : {}),
        }
      }
      const recordContextCompactorTelemetry = (event: PiContextCompactorTelemetryEvent): void => {
        void auditRecorder.record({
          type: 'compaction',
          attemptId: event.attemptId,
          stage: event.stage,
          strategy: event.strategy,
          mode: event.mode,
          outcome: event.outcome,
          durationMs: event.durationMs,
          ...(event.reason && { reason: event.reason }),
          ...(event.willRetry !== undefined && { willRetry: event.willRetry }),
          ...(event.splitTurn !== undefined && { splitTurn: event.splitTurn }),
          ...(event.errorCode && { errorCode: event.errorCode }),
          ...(event.errorMessage && { errorMessage: event.errorMessage }),
          ...(event.factKey && { factKey: event.factKey }),
          ...(event.ruleId && { ruleId: event.ruleId }),
          ...(event.failureCategory && { failureCategory: event.failureCategory }),
          ...(event.stateFingerprint && { stateFingerprint: event.stateFingerprint }),
          ...(event.metadata && {
            recentUserCount: event.metadata.recentUserCount,
            recentUserTokens: event.metadata.recentUserTokens,
            pinnedFactCount: event.metadata.pinnedFactCount,
            pinnedFactTokens: event.metadata.pinnedFactTokens,
            totalEnhancementTokens: event.metadata.totalEnhancementTokens,
            ...(event.metadata.compactionEntryId && { compactionEntryId: event.metadata.compactionEntryId }),
          }),
        })
      }
      const builtinTools = buildBuiltinToolDefinitions(
        sdk,
        cwd,
        input.runtimeEnv,
        input.getWorkflow,
        input.onSuccessfulFrozenBunInstall,
        input.fileCheckpoint,
      )
      const productTools = buildDomiProductToolDefinitions(sdk, input, productToolRuntimeState)
      const adapterReadOnlyToolDefinitions = new Map<string, ToolDefinition>(
        [...builtinTools, ...productTools]
          .filter((tool) => isParallelReadOnlyPiToolName(tool.name))
          .map((tool) => [tool.name, tool] as const),
      )
      const customTools = filterToolsForModelPresentation([
        buildCurrentSessionCompactionTool(
          sdk,
          () => { compactContextRequested = true },
        ),
        ...(input.worktreeHandoff ? [buildWorktreeHandoffTool(
          sdk,
          input.worktreeHandoff,
          (request) => {
            if (active.worktreeHandoffTerminating || pendingWorktreeHandoff) {
              throw new Error('当前 turn 已存在 Worktree handoff 请求')
            }
            active.worktreeHandoffTerminating = true
            pendingWorktreeHandoff = request
            rejectPendingInterruptPrompts(active, new Error('当前 Local 会话正在交接到 managed Worktree 子会话'))
            active.pendingNativeQueueDeliveries.steering.length = 0
            active.pendingNativeQueueDeliveries.followUp.length = 0
            active.session?.clearQueue()
          },
        )] : []),
        ...builtinTools,
        ...productTools,
        ...(input.customTools ?? []),
      ], input.modelPresentationPreset ?? 'standard')

      const settingsManager = sdk.SettingsManager.inMemory({
        steeringMode: input.steeringMode ?? 'one-at-a-time',
        followUpMode: input.followUpMode ?? 'one-at-a-time',
        // 使用 Pi SDK 原生压缩策略：
        // - 手动压缩由 session.compact() 触发；
        // - 自动压缩在上下文达到模型窗口的约 80% 时触发；Pi 以 reserveTokens 表示预留空间。
        compaction: { enabled: true, reserveTokens: autoCompactionReserveTokens },
        // Pi 原生 retry 通过 agent.continue() 在同一 transcript 中恢复，能保留已完成的
        // tool_result；不能用外层重投原始 prompt 替代，否则会重复执行副作用工具。
        // 单段和整轮均最多 8 次；累计 backoff 最多 5 分钟。±20% jitter 避免多个
        // 客户端在固定指数退避边界同时重试。provider retry 保持默认 0，避免嵌套计数。
        retry: {
          enabled: true,
          maxRetries: PI_NATIVE_MAX_RETRIES,
          maxTotalRetries: PI_NATIVE_MAX_TOTAL_RETRIES,
          baseDelayMs: PI_NATIVE_RETRY_BASE_DELAY_MS,
          maxTotalDelayMs: PI_NATIVE_MAX_TOTAL_DELAY_MS,
          jitterRatio: PI_NATIVE_RETRY_JITTER_RATIO,
        },
        ...buildPiRemoteConnectionSettings(input),
      })
      const openAIReasoningProfile = (input.provider === 'openai-codex' || input.provider === 'openai-responses')
        ? resolveReasoningProfile({
          modelId: input.model,
          transport: inferReasoningTransport(input.provider),
        })
        : undefined
      const deepSeekReasoningTransport = inferReasoningTransport(input.provider)
      const deepSeekReasoningProfile = input.provider === 'deepseek'
        ? resolveReasoningProfile({
          modelId: input.model,
          transport: deepSeekReasoningTransport,
        })
        : undefined
      const modelExtensionFactories = [
        ...(model.reasoning && (input.provider === 'openai-codex' || input.provider === 'openai-responses')
          && (openAIReasoningProfile || model.thinkingLevelMap)
          ? [createOpenAIReasoningRequestExtension({
              profile: openAIReasoningProfile,
              thinkingLevel: input.openAIThinkingLevel ?? input.thinkingLevel,
              thinkingLevelMap: input.provider === 'openai-codex' && openAIReasoningProfile
                ? undefined
                : model.thinkingLevelMap,
            })]
          : []),
        ...(deepSeekReasoningProfile?.encodings['anthropic-messages']?.kind === 'deepseek-output-effort'
          ? [createDeepSeekReasoningRequestExtension({
              provider: input.provider,
              transport: deepSeekReasoningTransport,
              profile: deepSeekReasoningProfile,
              thinkingLevel: input.thinkingLevel,
            })]
          : []),
        ...(input.provider === 'openai-codex' && input.codexFastMode
          ? [createCodexFastModeExtension({ fastMode: true })]
          : []),
      ]
      const extensionFactories = [
        ...(model.reasoning ? modelExtensionFactories : []),
        ...(contextCompactorSettings.enabled && contextCompactorMode
          ? [{
              name: 'domi-context-compactor',
              hidden: true,
              factory: createPiContextCompactorExtension({
                settings: contextCompactorSettings,
                mode: contextCompactorMode,
                getHostSnapshot: getContextCompactorHostSnapshot,
                isActive: () => contextCompactorLifecycleActive,
                createAttemptId: () => activeCompactionLifecycle?.attemptId ?? `pi-context-compactor:${Date.now()}:unmatched`,
                onTelemetry: recordContextCompactorTelemetry,
              }),
            }]
          : []),
      ]
      const resourceLoader = createTrustedPiResourceLoader(
        sdk,
        this.extensionTrustStore,
        cwd,
        {
          cwd,
          agentDir: input.piAgentDir,
          settingsManager,
          noSkills: true,
          additionalSkillPaths: input.additionalSkillPaths ?? [],
          skillsOverride: createDomiSkillsOverride(input.additionalSkillPaths),
          agentsFilesOverride: createDomiAgentsFilesOverride(),
          ...(extensionFactories.length > 0 && { extensionFactories }),
          systemPromptOverride: () => input.systemPrompt,
        },
      )
      await resourceLoader.reload()
      active.resourceLoader = resourceLoader
      const beforeCompactHandlers = resourceLoader.getExtensions().extensions
        .flatMap(extension => extension.handlers.get('session_before_compact')?.map(() => extension.path) ?? [])
      const contextCompactorHandlerConflict = contextCompactorSettings.enabled
        && beforeCompactHandlers.some(path => !path.includes('domi-context-compactor'))
      if (contextCompactorHandlerConflict) {
        // The inline factory has already been loaded, so deactivate its handler explicitly.
        // Falling back must not let Domi preflight cancel or alter another authoritative handler.
        contextCompactorLifecycleActive = false
        recordContextCompactorTelemetry({
          timestamp: Date.now(),
          attemptId: `pi-context-compactor-conflict:${Date.now()}`,
          stage: 'preflight',
          strategy: contextCompactorSettings.strategy,
          mode: contextCompactorMode ?? 'observe',
          outcome: contextCompactorSettings.failurePolicy === 'strict_cancel' ? 'failed' : 'fallback',
          durationMs: 0,
          errorCode: 'authoritative_handler_conflict',
          errorMessage: `Multiple session_before_compact handlers are registered: ${beforeCompactHandlers.join(', ')}`,
        })
        if (contextCompactorSettings.failurePolicy === 'strict_cancel') {
          throw new Error('ContextCompactor requires exclusive session_before_compact ownership.')
        }
      }

      const skillDiagnostics = resourceLoader.getSkills().diagnostics
      for (const diagnostic of skillDiagnostics) {
        const level = diagnostic.type === 'error' ? 'error' : 'warn'
        console[level](`[Pi SDK] Skill 加载诊断: ${diagnostic.path ?? '(unknown)'} ${diagnostic.message}`)
      }

      const { session } = await sdk.createAgentSession({
        cwd,
        agentDir: input.piAgentDir,
        modelRuntime,
        settingsManager,
        resourceLoader,
        sessionManager,
        model,
        thinkingLevel: input.thinkingLevel ?? 'off',
        noTools: 'builtin',
        customTools,
      })
      if (contextCompactorSettings.enabled && contextCompactorMode && !contextCompactorHandlerConflict) {
        session.agent.transformContext = wrapPiContextCompactorTransform({
          previousTransform: session.agent.transformContext,
          getBranchEntries: () => sessionManager.getBranch(),
          getHostSnapshot: getContextCompactorHostSnapshot,
          settings: contextCompactorSettings,
          mode: contextCompactorMode,
          onTelemetry: recordContextCompactorTelemetry,
        })
      }
      if (piAi && input.codexFastMode && input.provider === 'openai-codex' && isCodexFastModeSupportedModel(input.model)) {
        // Pi 的通用 streamSimple 会丢弃 provider 专属 serviceTier；这里直接走
        // provider stream，确保 request body 与 usage.cost 都使用 priority tier。
        session.agent.streamFunction = async (requestModel, context, options) => {
          const authResult = await modelRuntime.getAuth(requestModel)
          if (!authResult?.auth.apiKey) throw new Error('无法获取 ChatGPT (Codex) OAuth access token')
          const auth = authResult.auth

          const env = authResult.env || options?.env ? { ...(authResult.env ?? {}), ...(options?.env ?? {}) } : undefined
          const retrySettings = settingsManager.getProviderRetrySettings()
          const configuredTimeoutMs = settingsManager.getHttpIdleTimeoutMs()
          const timeoutMs = options?.timeoutMs ?? retrySettings.timeoutMs ?? (configuredTimeoutMs === 0 ? 2_147_483_647 : configuredTimeoutMs)
          const websocketConnectTimeoutMs = options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs()

          return piAi.stream(requestModel, context, withCodexFastModeServiceTier({
            ...options,
            apiKey: auth.apiKey,
            env,
            timeoutMs,
            websocketConnectTimeoutMs,
            maxRetries: options?.maxRetries ?? retrySettings.maxRetries,
            maxRetryDelayMs: options?.maxRetryDelayMs ?? retrySettings.maxRetryDelayMs,
            headers: { ...auth.headers, ...options?.headers },
          }))
        }
      }
      // 代理作用域必须只覆盖模型 provider stream：在整个 session.prompt() 链上设
      // AsyncLocalStorage 会把 MCP/产品工具等同一 Agent loop 中的 fetch 也错误地送进 Codex 代理。
      const providerStreamFn = session.agent.streamFunction
      session.agent.streamFunction = (requestModel, context, options) => {
        if (activeCompactionLifecycle && contextCompactorSettings.enabled && contextCompactorMode) {
          activeCompactionLifecycle.providerRequestOrdinal += 1
          const providerRequestId = `${activeCompactionLifecycle.attemptId}:provider:${activeCompactionLifecycle.providerRequestOrdinal}`
          activeCompactionLifecycle.lastProviderRequestId = providerRequestId
          void auditRecorder.record({
            type: 'compaction',
            attemptId: activeCompactionLifecycle.attemptId,
            stage: 'lifecycle',
            strategy: contextCompactorSettings.strategy,
            mode: contextCompactorMode,
            outcome: 'observed',
            durationMs: 0,
            reason: activeCompactionLifecycle.reason,
            ...(activeCompactionLifecycle.inline !== undefined && { inline: activeCompactionLifecycle.inline }),
            providerRequestId,
          })
        }
        try {
          input.onContextBreakdown?.(buildPiContextBreakdown({
            systemPrompt: context.systemPrompt ?? '',
            messages: context.messages,
            tools: context.tools ?? [],
            toolSources: input.customToolSources,
            estimateMessageTokens: (message) => sdk.estimateTokens(message as Parameters<typeof sdk.estimateTokens>[0]),
          }))
        } catch {
          // 构成估算只能 best-effort，绝不能阻断真实 provider request。
        }
        try {
          const envelope = capturePiRequestEnvelope({
            capturedAt: Date.now(),
            provider: requestModel.provider,
            modelId: requestModel.id,
            reasoningLevel: session.agent.state.thinkingLevel,
            contextWindow: requestModel.contextWindow,
            systemPrompt: context.systemPrompt ?? '',
            messageCount: context.messages.length,
            tools: context.tools ?? [],
            piActiveLeafId: sessionManager.getLeafId(),
            runtimeContext: input.getRequestEnvelopeContext?.(),
          })
          void auditRecorder.record({ type: 'model_request', envelope })
        } catch {
          // Observability 只能 best-effort；fingerprint 或可选状态读取失败不能阻断 provider request。
        }
        return runWithPiRequestProxy(
          requestProxyDispatcher,
          () => providerStreamFn(requestModel, context, options),
        )
      }
      installRuntimeGuardHooks(session, runtimeGuard)
      // beforeToolCall 顺序：Pi Extension → terminating tool 单独调用规则 → 最终 Execution Policy
      // → 已授权调用的批次调度登记。调度层不会绕过或替换授权结果。
      installSessionTerminatingToolHooks(session)
      installWorktreeHandoffLoopStop(session, () => active.worktreeHandoffTerminating)
      const supportsInlineTurnCompaction = (session as AgentSession & {
        supportsInlineTurnCompaction?: boolean
      }).supportsInlineTurnCompaction === true
      // 新 Pi 在 prepareNextTurn 中完成压缩并直接继续同一个 Agent loop；旧 Pi 才需要
      // turn-stop → compact → hidden continuation 的兼容路径。Worktree 等终止态仍先短路。
      const autoCompactionTurnStop = installPiAutoCompactionTurnStop(session, {
        compactThresholdTokens: autoCompactionThresholdTokens,
        calculateContextTokens: sdk.calculateContextTokens,
        estimateTokens: sdk.estimateTokens,
        enabled: !supportsInlineTurnCompaction,
      })
      const resourceToolNames = new Set(
        session.getAllTools()
          .filter((tool) => tool.sourceInfo.source !== 'sdk' && tool.sourceInfo.source !== 'builtin')
          .map((tool) => tool.name),
      )
      installPiFinalToolGuard(session, {
        cwd,
        auditRecorder,
        authorize: ({ toolName, input: toolInput, options }) => input.authorizeToolCall(toolName, toolInput, options),
        resolveToolSource: (toolName) => resourceToolNames.has(toolName)
          ? 'resource'
          : input.customToolSources?.[toolName] ?? 'host',
        resolveToolAnnotations: (toolName) => resourceToolNames.has(toolName)
          ? undefined
          : input.customToolAnnotations?.[toolName],
      })
      installPiToolExecutionScheduler(
        session,
        (toolName) => {
          const definition = adapterReadOnlyToolDefinitions.get(toolName)
          return definition !== undefined && session.getToolDefinition(toolName) === definition
        },
      )
      active.session = session
      resolveActiveReady(active, session)

      if (active.abortRequested) {
        await session.abort().catch(() => {})
        throw createAbortError()
      }

      input.onSessionId?.(session.sessionId, session.sessionFile)
      input.onModelResolved?.(session.model?.id ?? input.model ?? 'default')
      input.onContextWindow?.(model.contextWindow ?? DEFAULT_CONTEXT_WINDOW, contextWindowSource)

      queue.push({
        type: 'system',
        subtype: 'init',
        session_id: session.sessionId,
        model: session.model?.id ?? input.model,
      } as unknown as SDKMessage)

      const assistantUuidTracker = createPiAssistantUuidTracker()
      let lastPartialAssistant: AssistantMessage | undefined
      const toolCallAssistantUuids = new Map<string, string>()
      const toolResultPoints = new Map<string, { message: ToolResultMessage; uuid: string }>()
      // Pi 会在 native retry 前先发出 error assistant，再以 agent_end.willRetry 标记。
      // 延迟向 orchestrator 透传该 error，避免它先触发外层重试而重放整个 prompt。
      const retryTerminalGate = createPiRetryTerminalGate<{
        assistantMessage: AssistantMessage
        sdkMessage: SDKMessage
        assistantUuid: string
      }>()
      const overflowRecovery = createPiOverflowRecoveryState()
      // message_end 发生在 Pi 落盘前；保留对象身份，待 prompt 完成后从
      // SessionManager entries 精确取得 Pi entry ID，绝不按文本猜测。
      const finalAssistantUuids = new Map<AssistantMessage, string>()

      const persistPiEntryBindings = (): void => {
        const bindings: Record<string, string> = {}
        for (const entry of sessionManager.getEntries()) {
          if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
          const uuid = finalAssistantUuids.get(entry.message as AssistantMessage)
          if (uuid) bindings[uuid] = entry.id
        }
        if (Object.keys(bindings).length > 0) input.onPiEntryBindings?.(bindings)
      }

      const assistantUuidFor = (): string => assistantUuidTracker.get()
      const resetAssistantStream = (): void => {
        assistantUuidTracker.reset()
        lastPartialAssistant = undefined
      }

      const emitTerminalRetryError = (terminalRetryError: {
        assistantMessage: AssistantMessage
        sdkMessage: SDKMessage
        assistantUuid: string
      }): void => {
        finalAssistantUuids.set(terminalRetryError.assistantMessage, terminalRetryError.assistantUuid)
        runtimeGuard.recordMessage(terminalRetryError.assistantMessage)
        queue.push(terminalRetryError.sdkMessage)
        resetAssistantStream()
      }

      const discardCancelledTerminalState = (): boolean => {
        if (!active.abortRequested && !active.interrupting) return false
        retryTerminalGate.settle(true)
        overflowRecovery.clear()
        autoCompactionTurnStop.settle('aborted')
        compactContextRequested = false
        pendingCompactionContinuation = undefined
        pendingTerminalResult = undefined
        return true
      }

      assistantDeltaCoalescer = createDeltaBatchCoalescer((deltas) => {
        queue.push({
          type: 'assistant_delta',
          uuid: assistantUuidFor(),
          deltas,
          session_id: session.sessionId,
          ...(input.model && { _channelModelId: input.model }),
        } as unknown as SDKMessage)
      }, PI_DELTA_BATCH_INTERVAL_MS)

      active.processNativeQueueSnapshot = (snapshot) => {
        const processKind = (kind: AgentQueueMessageKind, nativeContents: readonly string[]): void => {
          const pending = active.pendingNativeQueueDeliveries[kind]
          const remaining = selectItemsPresentInNativeQueue(pending, nativeContents, (item) => item.content)
          const remainingSet = new Set(remaining)
          const delivered = pending.filter((item) => !remainingSet.has(item))
          pending.splice(0, pending.length, ...remaining)
          for (const item of delivered) {
            const deliveredMessage = item.onDelivered?.()
            if (deliveredMessage) queue.push(deliveredMessage)
          }
        }
        processKind('steering', snapshot.steering)
        processKind('followUp', snapshot.followUp)
      }

      unsubscribe = session.subscribe((event: AgentSessionEvent) => {
        try {
          void recordPiAgentAuditEvent(auditRecorder, event)
          switch (event.type) {
            case 'message_update': {
              if (!isAssistantPiMessage(event.message)) break
              lastPartialAssistant = event.message
              const delta = serializePiAssistantDelta(event.assistantMessageEvent)
              if (delta) assistantDeltaCoalescer?.schedule(delta)
              break
            }
            case 'message_end': {
              assistantDeltaCoalescer?.flush()
              if (active.interrupting && isAbortedAssistantMessage(event.message)) {
                if (lastPartialAssistant) {
                  const converted = convertPiMessage(lastPartialAssistant, session.sessionId, input.model, {
                    final: true,
                    uuid: assistantUuidFor(),
                  })
                  if (converted?.type === 'assistant') queue.push(converted)
                }
                resetAssistantStream()
                break
              }
              const isAssistant = isAssistantPiMessage(event.message)
              if (isAssistant && activePromptOutputEvidence) {
                recordPiPromptAssistantOutput(activePromptOutputEvidence, event.message)
              }
              const assistantUuid = isAssistant ? assistantUuidFor() : undefined
              const converted = convertPiMessage(event.message, session.sessionId, input.model, {
                final: true,
                ...(assistantUuid && { uuid: assistantUuid }),
              })
              if (converted?.type === 'user' && !hasToolResult(converted)) {
                const deliveredUser = converted as SDKUserMessage
                const content = (deliveredUser.message?.content ?? [])
                  .filter((block): block is { type: 'text'; text: string } => (
                    block.type === 'text' && 'text' in block && typeof block.text === 'string'
                  ))
                  .map((block) => block.text)
                  .join('\n')
                const claimed = claimPendingNativeQueueDelivery(
                  active.pendingNativeQueueDeliveries,
                  content,
                  (item) => item.content,
                )
                if (claimed) {
                  const deliveredMessage = claimed.item.onDelivered?.()
                  if (deliveredMessage) queue.push(deliveredMessage)
                }
                // Pi 会为原生 steering/follow-up 产生真实 user message；展示必须使用上面的
                // Domi UUID 与 raw display text 合成消息，不能再把 SDK enriched prompt 直接透出。
                break
              }
              if (isAssistant && assistantUuid) {
                for (const block of (event.message as AssistantMessage).content) {
                  if (block.type === 'toolCall' && typeof block.id === 'string') {
                    toolCallAssistantUuids.set(block.id, assistantUuid)
                  }
                }
              } else if (event.message.role === 'toolResult' && converted?.type === 'user') {
                const toolResult = event.message as ToolResultMessage
                const uuid = (converted as { uuid?: unknown }).uuid
                if (typeof uuid === 'string') {
                  toolResultPoints.set(toolResult.toolCallId, { message: toolResult, uuid })
                }
              }
              const shouldDeferNativeOverflow = isAssistant
                && shouldDeferPiOverflowTerminalMessage(event.message as AssistantMessage, session.model)
              const shouldDeferAssistantTerminal = isAssistant && (
                (event.message as AssistantMessage).stopReason === 'error' || shouldDeferNativeOverflow
              )
              if (shouldDeferAssistantTerminal && converted?.type === 'assistant' && assistantUuid) {
                // Native retry 会丢弃该失败 assistant；不应消耗 Domi 的 turn/budget 配额。
                // 关键：此处不能重置 UUID。retry 后的新 partial/final 必须原地替换此前
                // 已经展示的 partial，避免用户同时看到断流残片和恢复后的完整回答。
                retryTerminalGate.defer({
                  assistantMessage: event.message as AssistantMessage,
                  sdkMessage: converted,
                  assistantUuid,
                })
              } else {
                runtimeGuard.recordMessage(event.message)
                if (converted && (converted.type !== 'user' || hasToolResult(converted))) queue.push(converted)
                if (isAssistant && assistantUuid) {
                  finalAssistantUuids.set(event.message as AssistantMessage, assistantUuid)
                  resetAssistantStream()
                }
              }
              break
            }
            case 'queue_update': {
              const snapshot: NativeQueueSnapshot = {
                steering: [...event.steering],
                followUp: [...event.followUp],
              }
              const processSnapshot = active.processNativeQueueSnapshot
              if (processSnapshot) {
                processOrDeferNativeQueueSnapshot(
                  active.nativeQueueDeliverySuppression,
                  snapshot,
                  processSnapshot,
                )
              }
              break
            }
            case 'agent_end': {
              if (active.abortRequested || (active.interrupting && active.pendingInterruptPrompts.length > 0)) {
                // 用户停止或插入新 prompt 时，当前 loop 的错误与 result 都不得泄漏到下一轮。
                discardCancelledTerminalState()
                resetAssistantStream()
                break
              }
              const deferredRetryError = retryTerminalGate.peek()
              const waitsForNativeOverflowRecovery = shouldDeferPiOverflowTerminalError(
                deferredRetryError?.assistantMessage,
                session.model,
                event.willRetry,
                active.abortRequested,
              )
              // Pi 在 agent_end 后才检测 overflow 并压缩。此时若先将错误交给
              // orchestrator，会触发外层恢复或清理，打断同 transcript 的 continue。
              const terminalRetryError = waitsForNativeOverflowRecovery
                ? undefined
                : retryTerminalGate.settle(event.willRetry)
              if (waitsForNativeOverflowRecovery) overflowRecovery.defer()
              if (event.willRetry) {
                // native retry 会在同一 session 中调用 continue()，不要向上游发送终态，
                // 并保留当前 UUID，供恢复后的输出替换此前 partial。
                break
              }
              if (terminalRetryError) emitTerminalRetryError(terminalRetryError)
              // Pi can start auto-compaction after agent_end but before session.prompt()
              // resolves. Defer the terminal result until then, otherwise the orchestrator's
              // result-drain timeout may dispose the session and abort compaction.
              pendingTerminalResult = convertResultMessage(
                event.messages,
                session.sessionId,
                runtimeGuard.getResultOverride(event.messages),
              )
              break
            }
            case 'auto_retry_start':
            case 'auto_retry_attempt_start':
            case 'auto_retry_end':
              for (const retry of mapPiNativeRetryEvent(event, { runStartedAt: retryRunStartedAt })) input.onRetry?.(retry)
              break
            case 'tool_execution_start': {
              recordSkillTriggerFromToolStart(input, event as SkillTriggerToolStartEvent)
              break
            }
            case 'tool_execution_update':
              queue.push({
                type: 'tool_progress',
                session_id: session.sessionId,
                tool_use_id: event.toolCallId,
                tool_name: displayToolName(event.toolName, event.args as Record<string, unknown> | undefined),
                parent_tool_use_id: null,
              } as unknown as SDKMessage)
              break
            case 'compaction_start':
              if (contextCompactorSettings.enabled && contextCompactorMode) {
                activeCompactionLifecycle = {
                  attemptId: `pi-compaction-lifecycle:${Date.now()}:${successfulCompactionBoundaryVersion + 1}`,
                  startedAt: Date.now(),
                  reason: event.reason,
                  ...(event.inline !== undefined && { inline: event.inline }),
                  providerRequestOrdinal: 0,
                }
              }
              // 压缩开始（手动 /compact 或自动阈值/溢出触发）：发前端已识别的 compacting system 消息，
              // 展示「正在压缩上下文...」分隔符。此前迁移遗漏了该事件，导致自动压缩与手动压缩都无 UI。
              queue.push({
                type: 'system',
                subtype: 'compacting',
                session_id: session.sessionId,
              } as unknown as SDKMessage)
              break
            case 'compaction_end': {
              if (contextCompactorSettings.enabled && contextCompactorMode) {
                const lifecycle = activeCompactionLifecycle
                void auditRecorder.record({
                  type: 'compaction',
                  attemptId: lifecycle?.attemptId ?? `pi-compaction-lifecycle:${Date.now()}:unmatched`,
                  stage: 'lifecycle',
                  strategy: contextCompactorSettings.strategy,
                  mode: contextCompactorMode,
                  outcome: !event.aborted && event.result ? 'compacted' : event.aborted ? 'aborted' : 'failed',
                  durationMs: lifecycle ? Math.max(0, Date.now() - lifecycle.startedAt) : 0,
                  reason: event.reason,
                  willRetry: event.willRetry,
                  ...(event.inline !== undefined ? { inline: event.inline } : lifecycle?.inline !== undefined ? { inline: lifecycle.inline } : {}),
                  ...(event.result?.usage ? {
                    summaryInputTokens: event.result.usage.input,
                    summaryOutputTokens: event.result.usage.output,
                  } : {}),
                  ...(lifecycle?.lastProviderRequestId ? { providerRequestId: lifecycle.lastProviderRequestId } : {}),
                  ...(event.errorMessage && { errorMessage: event.errorMessage }),
                })
                activeCompactionLifecycle = undefined
              }
              if (!event.aborted && event.result) {
                successfulCompactionBoundaryVersion += 1
                if (event.inline) pendingInlineCompactionFailure = undefined
              } else if (event.inline) {
                pendingInlineCompactionFailure = event.aborted
                  ? 'Pi inline 自动压缩已取消，原任务未继续。'
                  : event.errorMessage ?? 'Pi inline 自动压缩失败，原任务未继续。'
              }
              const noopKind = event.errorMessage
                ? classifyCompactionNoopError(event.errorMessage)
                : undefined
              // session.compact() may first report Nothing to compact, after which Domi appends a
              // non-triggering anchor and retries. Keep the pending stop alive until that retry
              // reaches a real success/final failure; otherwise the first noop erases its permit.
              if (noopKind !== 'nothing_to_compact') {
                autoCompactionTurnStop.settle(
                  !event.aborted && event.result
                    ? 'success'
                    : event.aborted
                      ? 'aborted'
                      : 'failed',
                )
              }
              const recoveryAction = overflowRecovery.settleCompaction({
                reason: event.reason,
                aborted: event.aborted,
                hasResult: event.result !== undefined,
                willRetry: event.willRetry,
                discard: active.abortRequested || active.interrupting,
              })
              if (recoveryAction !== 'none') {
                const terminalRetryError = retryTerminalGate.settle(recoveryAction === 'discard')
                if (terminalRetryError) emitTerminalRetryError(terminalRetryError)
              }
              // 所有压缩结果都必须有可识别的终态，确保 renderer 能结束底部进度追踪。
              if (!event.aborted && event.result) {
                // 自动压缩与手动压缩都必须同步压缩后的预估占用；否则终止型工具恰好在
                // 自动压缩后结束时，renderer 会永久保留压缩前的高占用圆环。
                queue.push(createPiCompactionBoundaryMessage(session.sessionId, event.result))
              } else if (event.aborted) {
                queue.push({
                  type: 'system',
                  subtype: 'status',
                  session_id: session.sessionId,
                  compact_result: 'failed',
                  compact_error: '上下文压缩已取消。',
                } as unknown as SDKMessage)
              } else if (event.errorMessage && !isCompactionNoopError(event.errorMessage)) {
                queue.push({
                  type: 'system',
                  subtype: 'status',
                  session_id: session.sessionId,
                  compact_result: 'failed',
                  compact_error: event.errorMessage,
                } as unknown as SDKMessage)
              }
              break
            }
            case 'agent_settled': {
              // 防御上游缺少 compaction_end 的异常事件序列，不能无限吞掉已 deferred 的错误。
              const recoveryAction = overflowRecovery.settleFallback(active.abortRequested || active.interrupting)
              if (recoveryAction !== 'none') {
                const terminalRetryError = retryTerminalGate.settle(recoveryAction === 'discard')
                if (terminalRetryError) emitTerminalRetryError(terminalRetryError)
              }
              break
            }
          }
        } catch (error) {
          queue.fail(error)
        }
      })

      if (input.compactRequest) {
        // 手动压缩：走 pi 原生 session.compact()，而非把 /compact 当普通 prompt 发给模型。
        // compaction_start/end 事件已在上面的 subscribe 中转成 compacting/compact_boundary system 消息；
        // compact() 不发 agent_end，故这里补一个合成 result 消息收束本轮（供 orchestrator 结束消费循环）。
        session.compact(input.compactInstructions)
          .then(() => {
            queue.push({
              type: 'result',
              subtype: 'success',
              usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              terminal_reason: 'completed',
              isSyntheticCompactionResult: true,
              session_id: session.sessionId,
            } as unknown as SDKMessage)
            queue.close()
          })
          .catch((error) => {
            // 「会话太小无需压缩」/「已压缩」是良性情况，不是执行错误：
            // pi 会抛 "Nothing to compact (session too small)" / "Already compacted"。
            // 这里不 fail 队列（否则前端弹通用「执行错误」），改为正常收尾并给出友好提示。
            const noopKind = classifyCompactionNoopError(error)
            if (noopKind) {
              queue.push(createCompactionNoopMessage(session.sessionId, noopKind))
              queue.push({
                type: 'result',
                subtype: 'success',
                usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                terminal_reason: 'completed',
                isSyntheticCompactionResult: true,
                session_id: session.sessionId,
              } as unknown as SDKMessage)
              queue.close()
            } else {
              queue.fail(error)
            }
          })
          .finally(cleanupActiveSession)
      } else {
        for (const aside of input.nextTurnAsides ?? []) {
          const content = aside.content.trim()
          if (!content) continue
          await session.sendCustomMessage({
            customType: 'domi_aside',
            content,
            display: true,
            details: { id: aside.id },
          }, { deliverAs: 'nextTurn' })
        }

        const runPromptChain = async (): Promise<void> => {
          let nextPrompt: {
            content: string
            skipSkillExpansion: boolean
            delivery?: 'hidden_compaction_continuation' | 'hidden_incomplete_turn_continuation'
          } | undefined = {
            content: appendOutputFormatInstruction(input.prompt, input.outputFormat),
            skipSkillExpansion: false,
          }
          let nextInterrupt: PendingInterruptPrompt | undefined
          while (nextPrompt !== undefined) {
            const currentInterrupt = nextInterrupt
            nextInterrupt = undefined
            if (runtimeGuard.shouldStopBeforeNextTurn()) {
              currentInterrupt?.rejectAccepted(createAbortError())
              rejectPendingInterruptPrompts(active, createAbortError())
              return
            }
            const promptInput = nextPrompt
            let prompt: string
            try {
              prompt = promptInput.skipSkillExpansion
                ? promptInput.content
                : await preparePromptWithDomiSkills(resourceLoader, promptInput.content, input.skillMentions)
            } catch (error) {
              currentInterrupt?.rejectAccepted(error)
              throw error
            }
            nextPrompt = undefined
            const compactionBoundaryVersionAtPromptStart = successfulCompactionBoundaryVersion
            const promptOutputEvidence = createPiPromptOutputEvidence()
            activePromptOutputEvidence = promptOutputEvidence
            try {
              if (active.abortRequested) {
                currentInterrupt?.rejectAccepted(createAbortError())
                rejectPendingInterruptPrompts(active, createAbortError())
                return
              }
              currentInterrupt?.resolveAccepted()
              if (promptInput.delivery === 'hidden_compaction_continuation') {
                await continuePiAfterCompaction(session, prompt)
              } else if (promptInput.delivery === 'hidden_incomplete_turn_continuation') {
                await continuePiAfterIncompleteTurn(session, prompt)
              } else {
                await session.prompt(prompt, { source: 'rpc' })
              }
              // prompt 返回后到下一次 await 前不会再发生 renderer 取消；先丢弃已取消 loop 的
              // deferred 终态，也能避开与 Pi-only incomplete continuation 的结算区冲突。
              discardCancelledTerminalState()
              persistPiEntryBindings()
              if (pendingWorktreeHandoff && input.worktreeHandoff) {
                const toolResultPoint = toolResultPoints.get(pendingWorktreeHandoff.toolCallId)
                const toolResultEntry = toolResultPoint
                  ? sessionManager.getEntries().find((entry) => entry.type === 'message' && entry.message === toolResultPoint.message)
                  : undefined
                finalizeWorktreeHandoffRequest(
                  pendingWorktreeHandoff,
                  {
                    assistantMessageUuid: toolCallAssistantUuids.get(pendingWorktreeHandoff.toolCallId),
                    toolResultMessageUuid: toolResultPoint?.uuid,
                    piToolResultEntryId: toolResultEntry?.id,
                  },
                  input.worktreeHandoff,
                )
                pendingWorktreeHandoff = undefined
                worktreeHandoffFinalized = true
              }
              const manualCompactionRequested = compactContextRequested
              const autoCompactionRequested = autoCompactionTurnStop.needsCompaction()
              if (manualCompactionRequested || autoCompactionRequested) {
                let compactionResult: PiCompactionAfterTurnResult
                try {
                  compactionResult = await compactCurrentSessionAfterTurn(session, {
                    onNoop: (message) => queue.push(message),
                    hasFreshSuccessfulBoundary: () => (
                      successfulCompactionBoundaryVersion > compactionBoundaryVersionAtPromptStart
                    ),
                    retryAfterAnchor: () => withPiCompactionKeepRecentTokens(
                      settingsManager,
                      0,
                      () => session.compact(),
                    ),
                  })
                } catch (error) {
                  // 用户在压缩期间停止时，Pi 会取消 summarization；这是正常中止而不是运行错误。
                  if (active.abortRequested) return
                  throw error
                }
                compactContextRequested = false
                if (compactionResult === 'already_compacted_without_fresh_boundary') {
                  if (autoCompactionRequested) autoCompactionTurnStop.settle('failed')
                  throw new Error('Pi 报告上下文已压缩，但本轮没有可验证的成功压缩边界；已停止续跑以避免使用陈旧状态。')
                }
                if (compactionResult === 'nothing_to_compact') {
                  if (autoCompactionRequested) autoCompactionTurnStop.settle('failed')
                  throw new Error('当前大型工具 turn 即使加入安全压缩边界后仍无法由 Pi 压缩；已停止续跑以避免上下文溢出。')
                }
                // Cancellation can arrive while Pi is compacting, after its first agent_end.
                // Do not plan a continuation or render that stale terminal result.
                if (!discardCancelledTerminalState()) {
                  const autoCompactionSucceeded = autoCompactionTurnStop.takeCompacted()
                  const compactedAtFreshBoundary = compactionResult === 'compacted' || compactionResult === 'already_compacted'
                  if (autoCompactionRequested && (!autoCompactionSucceeded || !compactedAtFreshBoundary)) {
                    throw new Error('自动压缩完成后未收到成功边界；已停止续跑以避免内部指令提前进入模型上下文。')
                  }
                  const shouldContinueAfterCompaction = manualCompactionRequested || autoCompactionSucceeded
                  if (shouldContinueAfterCompaction) {
                    const continuation = planPiCompactionContinuation({
                      continuationCount: automaticCompactionContinuations,
                      abortRequested: active.abortRequested,
                      runtimeLimitReached: runtimeGuard.shouldStopBeforeNextTurn(),
                    })
                    if (continuation.shouldContinue) {
                      automaticCompactionContinuations += 1
                      pendingCompactionContinuation = appendOutputFormatInstruction(continuation.prompt, input.outputFormat)
                      // 当前终态仅表示为执行压缩而结束的内部 loop，不应让上层把原任务视为完成。
                      pendingTerminalResult = undefined
                    } else if (continuation.reason === 'continuation_limit') {
                      pendingTerminalResult = createCompactionContinuationLimitResult(session.sessionId)
                    }
                  }
                }
              } else {
                const inlineCompactionFailure = pendingInlineCompactionFailure
                pendingInlineCompactionFailure = undefined
                const nativeCompactionFailure = autoCompactionTurnStop.takeFailure()
                if (inlineCompactionFailure && !active.abortRequested && !active.interrupting) {
                  pendingTerminalResult = {
                    type: 'result',
                    subtype: 'error_during_execution',
                    terminal_reason: 'compaction_failed',
                    errors: [inlineCompactionFailure],
                    session_id: session.sessionId,
                  } as unknown as SDKMessage
                } else if (nativeCompactionFailure && !active.abortRequested && !active.interrupting) {
                  pendingTerminalResult = {
                    type: 'result',
                    subtype: 'error_during_execution',
                    terminal_reason: 'compaction_failed',
                    errors: [nativeCompactionFailure === 'aborted'
                      ? '自动压缩已取消，原任务未继续。'
                      : '自动压缩失败，原任务未继续。请重试或手动压缩上下文。'],
                    session_id: session.sessionId,
                  } as unknown as SDKMessage
                } else if (autoCompactionTurnStop.takeCompacted() && !discardCancelledTerminalState()) {
                  // 最近 provider usage 本身已超过阈值时，Pi 原生 post-agent check 会先完成压缩；
                  // 无需再次 compact，只需在成功边界之后安排隐藏续跑。
                  const continuation = planPiCompactionContinuation({
                    continuationCount: automaticCompactionContinuations,
                    abortRequested: active.abortRequested,
                    runtimeLimitReached: runtimeGuard.shouldStopBeforeNextTurn(),
                  })
                  if (continuation.shouldContinue) {
                    automaticCompactionContinuations += 1
                    pendingCompactionContinuation = appendOutputFormatInstruction(continuation.prompt, input.outputFormat)
                    pendingTerminalResult = undefined
                  } else if (continuation.reason === 'continuation_limit') {
                    pendingTerminalResult = createCompactionContinuationLimitResult(session.sessionId)
                  }
                }
              }
              if (!pendingCompactionContinuation && pendingTerminalResult) {
                const incompleteContinuation = planPiIncompleteTurnContinuation({
                  modelId: session.model?.id ?? input.model,
                  messages: session.agent.state.messages,
                  promptOutputEvidence,
                  continuationCount: automaticIncompleteTurnContinuations,
                  abortRequested: active.abortRequested,
                  runtimeLimitReached: runtimeGuard.shouldStopBeforeNextTurn(),
                  terminalSucceeded: (pendingTerminalResult as { subtype?: string }).subtype === 'success',
                })
                if (incompleteContinuation.shouldContinue) {
                  automaticIncompleteTurnContinuations += 1
                  pendingIncompleteTurnContinuation = appendOutputFormatInstruction(
                    incompleteContinuation.prompt,
                    input.outputFormat,
                  )
                  // 模型的正常 stop 只结束了未完成的过渡句，不能让上层误判原任务已经完成。
                  pendingTerminalResult = undefined
                }
              }
              if (pendingTerminalResult) {
                queue.push(pendingTerminalResult)
                pendingTerminalResult = undefined
              }
            } finally {
              activePromptOutputEvidence = undefined
              if (active.interrupting) {
                session.agent.state.messages = dropTrailingAbortedAssistant(session.agent.state.messages)
              }
              active.interrupting = false
            }
            if (active.abortRequested) {
              rejectPendingInterruptPrompts(active, createAbortError())
              return
            }
            if (runtimeGuard.shouldStopBeforeNextTurn()) {
              rejectPendingInterruptPrompts(active, createAbortError())
              return
            }
            if (worktreeHandoffFinalized) {
              const handoffError = new Error('当前 Local 会话已交接到 managed Worktree 子会话')
              rejectPendingInterruptPrompts(active, handoffError)
              session.agent.clearAllQueues()
              return
            }
            const pendingInterrupt = active.pendingInterruptPrompts.shift()
            nextInterrupt = pendingInterrupt
            if (pendingInterrupt) {
              // 用户的新指令优先于模型自动续跑，避免旧的未完成步骤覆盖用户刚改变的方向。
              pendingIncompleteTurnContinuation = undefined
              nextPrompt = { content: pendingInterrupt.content, skipSkillExpansion: false }
            } else if (pendingCompactionContinuation) {
              nextPrompt = {
                content: pendingCompactionContinuation,
                skipSkillExpansion: true,
                delivery: 'hidden_compaction_continuation',
              }
              pendingCompactionContinuation = undefined
            } else if (pendingIncompleteTurnContinuation) {
              nextPrompt = {
                content: pendingIncompleteTurnContinuation,
                skipSkillExpansion: true,
                delivery: 'hidden_incomplete_turn_continuation',
              }
              pendingIncompleteTurnContinuation = undefined
            }
          }
        }

        runPromptChain()
          .then(() => queue.close())
          .catch((error) => queue.fail(error))
          .finally(cleanupActiveSession)
      }
    } catch (error) {
      rejectActiveReady(active, error)
      queue.fail(error)
    }

    try {
      while (true) {
        const next = await queue.next()
        if (next.done) break
        yield next.value
      }
    } finally {
      cleanupActiveSession()
    }
  }

  abort(sessionId: string): void {
    const active = this.activeSessions.get(sessionId)
    if (!active) return
    active.abortRequested = true
    rejectPendingInterruptPrompts(active, createAbortError())
    if (!active.session) rejectActiveReady(active, createAbortError())
    active.session?.abortCompaction()
    active.session?.abort().catch(() => {})
  }

  async retryNow(sessionId: string): Promise<boolean> {
    const active = this.activeSessions.get(sessionId)
    if (!active || active.abortRequested || active.interrupting) return false
    const session = await waitForActiveSession(active)
    return session.retryNow()
  }

  async navigateSessionTree(
    sessionId: string,
    input: SessionTreeNavigationAdapterInput,
  ): Promise<SessionTreeNavigationAdapterResult> {
    const active = this.activeSessions.get(sessionId)
    let abortedRun = false
    if (active?.session) {
      const session = active.session
      if (session.isStreaming) {
        abortedRun = true
        active.abortRequested = true
        rejectPendingInterruptPrompts(active, createAbortError())
        session.abortCompaction()
        await session.abort().catch(() => {})
      }
      try {
        const result = await session.navigateTree(input.entryId)
        return {
          ...(result.editorText !== undefined && { editorText: result.editorText }),
          activeLeafId: session.sessionManager.getLeafId(),
          abortedRun,
        }
      } catch (error) {
        // abort 后 query 的 finally 可能抢先 dispose AgentSession；idle fallback 仍能精确复现一期语义。
        console.warn('[Pi SDK] 活跃 AgentSession 树导航失败，回退到 artifact 解析:', error)
      }
    }

    const navigation = resolveNavigationTarget(readPiSessionEntries(input.sessionFile), input.entryId)
    return { ...navigation, abortedRun }
  }

  async sendQueuedMessage(
    sessionId: string,
    message: SDKUserMessageInput,
    options?: SendQueuedMessageOptions,
  ): Promise<void> {
    const active = this.activeSessions.get(sessionId)
    if (!active) throw new Error('当前会话没有正在运行的 Agent')
    const session = await waitForActiveSession(active)
    if (active.abortRequested) throw createAbortError()
    if (active.worktreeHandoffTerminating) {
      throw new Error('当前 Local 会话正在交接到 managed Worktree 子会话，无法继续追加消息')
    }
    if (active.runtimeGuard?.shouldStopBeforeNextTurn()) {
      session.agent.clearAllQueues()
      const stopOverride = active.runtimeGuard.getLimitResultOverride()
      throw new Error(stopOverride?.errors[0] ?? 'Agent 已达到运行限制，无法继续追加消息')
    }
    const content = active.resourceLoader
      ? await preparePromptWithDomiSkills(active.resourceLoader, message.message.content, options?.skillMentions)
      : message.message.content
    if (active.runtimeGuard?.shouldStopBeforeNextTurn()) {
      session.agent.clearAllQueues()
      const stopOverride = active.runtimeGuard.getLimitResultOverride()
      throw new Error(stopOverride?.errors[0] ?? 'Agent 已达到运行限制，无法继续追加消息')
    }
    if (active.worktreeHandoffTerminating) {
      throw new Error('当前 Local 会话正在交接到 managed Worktree 子会话，无法继续追加消息')
    }
    if (options?.interrupt) {
      const accepted = new Promise<void>((resolve, reject) => {
        active.pendingInterruptPrompts.push({
          content,
          resolveAccepted: resolve,
          rejectAccepted: reject,
        })
      })
      accepted.catch(() => {})
      if (session.isStreaming) {
        // Pi 没有单独的 interrupt()；公开取消 API 是 abort()。
        // 这里把 abort 产生的内部 aborted 终态压住，再由 query 的 prompt chain 发送新消息。
        active.interrupting = true
        active.interruptAbortPromise ??= session.abort()
          .finally(() => {
            active.interruptAbortPromise = undefined
          })
        await active.interruptAbortPromise
      }
      await accepted
      options.onAccepted?.()
      return
    }
    const queueKind: AgentQueueMessageKind = options?.queueKind
      ?? (message.priority === 'now' ? 'steering' : 'followUp')
    const pendingDelivery: PendingNativeQueueDelivery = {
      content,
      messageId: options?.queueMessageId,
      onDelivered: options?.onDelivered,
    }
    const processSnapshot = active.processNativeQueueSnapshot ?? (() => {})
    await withNativeQueueDeliverySuppressed(
      active.nativeQueueDeliverySuppression,
      async () => {
        const before = queueKind === 'steering'
          ? [...session.getSteeringMessages()]
          : [...session.getFollowUpMessages()]
        active.pendingNativeQueueDeliveries[queueKind].push(pendingDelivery)
        try {
          if (queueKind === 'steering') {
            await session.steer(content)
          } else {
            await session.followUp(content)
          }
          const after = queueKind === 'steering'
            ? session.getSteeringMessages()
            : session.getFollowUpMessages()
          // Pi 可能在 steer/followUp 内展开 prompt template；用实际队列新增文本校准内容匹配键。
          pendingDelivery.content = findAddedNativeQueueContent(before, after) ?? pendingDelivery.content
        } catch (error) {
          const pending = active.pendingNativeQueueDeliveries[queueKind]
          const index = pending.indexOf(pendingDelivery)
          if (index >= 0) pending.splice(index, 1)
          throw error
        }
      },
      () => getNativeQueueSnapshot(session),
      processSnapshot,
    )
    options?.onAccepted?.()
  }

  async withQueuedMessageDeliverySuppressed<T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const active = this.activeSessions.get(sessionId)
    if (!active) throw new Error('当前会话没有正在运行的 Agent')
    const session = await waitForActiveSession(active)
    return withNativeQueueDeliverySuppressed(
      active.nativeQueueDeliverySuppression,
      operation,
      () => getNativeQueueSnapshot(session),
      active.processNativeQueueSnapshot ?? (() => {}),
    )
  }

  async clearQueuedMessages(
    sessionId: string,
    options?: { abort?: boolean },
  ): Promise<{
    steering: string[]
    followUp: string[]
    steeringMessageIds: string[]
    followUpMessageIds: string[]
  }> {
    const active = this.activeSessions.get(sessionId)
    if (!active) throw new Error('当前会话没有正在运行的 Agent')
    const session = await waitForActiveSession(active)
    return withNativeQueueDeliverySuppressed(
      active.nativeQueueDeliverySuppression,
      async () => {
        // 先按 clear 前的权威 SDK 内容结算已送达项，不能让随后清空 pending callback
        // 吞掉 transaction 开始到 clearQueue 之间发生的真实送达。
        active.processNativeQueueSnapshot?.(getNativeQueueSnapshot(session))
        active.nativeQueueDeliverySuppression.deferredSnapshot = undefined

        let abortPromise: Promise<void> | undefined
        if (options?.abort) {
          active.abortRequested = true
          rejectPendingInterruptPrompts(active, createAbortError())
          session.abortCompaction()
          // 调用顺序保持 abort → clearQueue；clearQueue 是同步 API，先捕获未送达消息，
          // 再等待 abort 完成，避免 query cleanup 提前 dispose session。
          abortPromise = session.abort()
        }
        const cleared = session.clearQueue()
        const clearedSteeringPending = selectItemsPresentInNativeQueue(
          active.pendingNativeQueueDeliveries.steering,
          cleared.steering,
          (item) => item.content,
        )
        const clearedFollowUpPending = selectItemsPresentInNativeQueue(
          active.pendingNativeQueueDeliveries.followUp,
          cleared.followUp,
          (item) => item.content,
        )
        active.pendingNativeQueueDeliveries.steering.length = 0
        active.pendingNativeQueueDeliveries.followUp.length = 0
        await abortPromise
        return {
          steering: [...cleared.steering],
          followUp: [...cleared.followUp],
          steeringMessageIds: clearedSteeringPending.flatMap((item) => item.messageId ? [item.messageId] : []),
          followUpMessageIds: clearedFollowUpPending.flatMap((item) => item.messageId ? [item.messageId] : []),
        }
      },
      () => getNativeQueueSnapshot(session),
      active.processNativeQueueSnapshot ?? (() => {}),
    )
  }

  async cancelQueuedMessage(_sessionId: string, _messageUuid: string): Promise<void> {
    // Pi 的公开 SDK 当前只暴露 clearQueue，不支持按消息 UUID 删除。
  }

  async setPermissionMode(_sessionId: string, _mode: string): Promise<void> {
    // Domi 权限由工具包装层实时读取 sessionPermissionModes，自身无需同步给 Pi。
  }

  dispose(): void {
    for (const active of this.activeSessions.values()) {
      if (!active.disposed) {
        active.disposed = true
        rejectPendingInterruptPrompts(active, createAbortError())
        active.session?.dispose()
      }
      rejectActiveReady(active, createAbortError())
    }
    this.activeSessions.clear()
  }
}

export function cleanupPiRuntimeResources(): void {
  // Pi 是 in-process runtime，旧 Claude SDK 时代那个持久化的 native `claude` CLI 子进程已不存在，
  // 因此不再需要旧 Runtime 的 before-quit 孤儿进程扫描。
  //
  // Pi 的 bash 工具确实会 spawn 子进程，但它以 detached 独立进程组启动，abort()/timeout 时由
  // pi 内部 killProcessTree（SIGTERM + 5s SIGKILL）级联杀整个进程组；adapter.dispose()/abort()
  // 会传播 session.abort()/dispose()。故正常路径无需额外兜底。
  //
  // 残留风险（低）：某个 exec 长命令或 stdio MCP 子进程若在 dispose/abort 未覆盖时退出，可能残留。
  // pi 未从公开入口（exports 仅 '.' 与 './rpc-entry'）导出 killTrackedDetachedChildren，
  // 无法在不深依赖其内部实现的前提下调用，故此处保持空实现；如需兜底应由 pi 侧补公开 API。
}

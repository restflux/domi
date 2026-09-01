/**
 * AgentOrchestrator — Agent 编排层
 *
 * 从 agent-service.ts 提取的核心业务逻辑，负责：
 * - 并发守卫（同一会话不允许并行请求）
 * - 渠道查找 + API Key 解密
 * - 环境变量构建 + SDK 路径解析
 * - 用户/助手消息持久化
 * - 事件流遍历 + 文本累积 + 事件持久化
 * - 错误处理 + 部分内容保存
 * - 自动标题生成
 *
 * 通过 EventBus 分发 AgentEvent，通过 SessionCallbacks 发送控制信号，
 * 完全解耦 Electron IPC，可独立测试（mock Adapter + EventBus）。
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { AgentSendInput, AgentGenerateTitleInput, AgentProviderAdapter, AgentSessionMeta, AgentNextTurnAside, AgentAssistantDeltaPayload, CodexOAuthCredentials, TypedError, RetryAttempt, SDKMessage, SDKAssistantMessage, SDKResultMessage, AgentStreamPayload, RewindSessionPreview, RewindSessionResult, RewindUndoState, UndoRewindSessionResult, NavigateSessionTreeResult, SessionTreeResult, ProviderType, AgentExecutionControlsUpdate, AgentWorkflow, ExecutionPolicyMode, AgentQueueMessageKind, AgentQueueReplayMessageInput, AgentClearMessageQueueResult, SessionTargetView, SkillTriggerEvent } from '@domi/shared'
import {
  DOMI_DEFAULT_PERMISSION_MODE,
  THINKING_SIGNATURE_ERROR_CODE,
  THINKING_SIGNATURE_ERROR_MESSAGE,
  THINKING_SIGNATURE_ERROR_TITLE,
  isPersistableSDKSystemMessage,
  normalizeMcpTransportType,
  inferReasoningTransport,
  resolveReasoningProfile,
  normalizeAgentExecutionSettings,
  isAgentWorkflow,
  isExecutionPolicyMode,
} from '@domi/shared'
import type { AgentContextBreakdown, DomiPermissionMode, AskUserRequest, ContextWindowSource, ExitPlanModeRequest, SDKSystemMessage, ApplyBaseStrategy } from '@domi/shared'
import type { PiAgentQueryOptions, ReadyWorktreeHandoffRequest } from './adapters/pi-agent-adapter'
import type { PiContextCompactorHostSnapshot } from './adapters/pi-context-compactor'
import { isPromptTooLongError, isThinkingSignatureError, friendlyErrorMessage, mapSDKErrorToTypedError } from './adapters/pi-agent-adapter'
import { getPiAssistantErrorDetails, hasPiAssistantTextContent, stripPiAssistantError } from './adapters/pi-message-adapter'
import { isTransientNetworkError, isMalformedResponseError, isSessionNotFoundError } from './error-patterns'
import { AgentEventBus } from './agent-event-bus'
import { decryptApiKey, getChannelById, listChannels, persistCodexOAuthCredentials, resolveChannelRuntimeApiKey, resolveCodexOAuthCredentials } from './channel-manager'
import { getAdapter, fetchTitle } from '@domi/core'
import { getFetchFn } from './proxy-fetch'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { appendSDKMessages, updateAgentSessionMeta, getAgentSessionMeta, getAgentSessionSDKMessagesRaw, prepareSDKMessageTruncation, prepareSDKMessageRestore, removeSDKErrorMessage, preparePiAgentSessionRewind, preparePiAgentSessionRestore, preparePiAgentSessionRecovery } from './agent-session-manager'
import { getAgentWorkspace, getProjectFilesPath, getWorkspaceAgentsMdPath, getLegacyWorkspaceClaudeMdPath, getWorkspaceMcpConfig, getEffectiveWorkspaceMcpConfig, getEffectivePiSkillPaths, getWorkspaceAttachedDirectories, getWorkspaceAttachedFiles } from './agent-workspace-manager'
import { getAgentWorkspacePath, getAgentSessionWorkspacePath, getAgentPlanSidecarDir, getAgentSessionSkillTriggersPath, getWorkspaceSkillUsagePath, getConfigDir, getSdkConfigDir } from './config-paths'
import { getRuntimeStatus } from './runtime-init'
import {
  buildWorkspaceSkillNames,
  buildWorkspaceSkillTriggerRoots,
  createSkillTriggerRecorder,
} from './skill-trigger-recorder'
import { buildQueuedAgentAsideContext, normalizeAgentNextTurnAsides } from './agent-next-turn-aside'
import { parseAgentCompactCommand } from './agent-compact-command'
import { resolveTrustedProjectInstruction, resolveTrustedWorkspaceInstruction } from './project-instruction-resolver'
import { assertAgentPlanCommandMayBeQueued, parseAgentPlanCommand, resolveAgentPlanCommandWorkflow } from './agent-plan-command.ts'
import {
  buildAgentImageCommandPrompt,
  collectAvailableAgentImageToolNames,
  parseAgentImageCommand,
} from './agent-image-command'
import { getSettings } from './settings-service'
import { buildSystemPrompt, buildDynamicContext } from './agent-prompt-builder'
import { getEffectiveWorkSystemPrompt } from './system-prompt-manager'
import { resolveModelPresentationSystemPrompt } from './model-presentation'
import { MAX_CONTEXT_MESSAGES, buildContextPrompt, buildRecoveryPrompt, buildReferencedSessionsPrompt } from './agent-session-context-prompt'
import { buildReferencedPlanningPrompt } from './planning-reference-context'
import { permissionService } from './agent-permission-service'
import type { CanUseToolOptions } from './agent-permission-service'
import { askUserService } from './agent-ask-user-service'
import { createDirectWorkflowAdjustmentUserMessage, extractDirectWorkflowAdjustment } from './agent-ask-user-response'
import { exitPlanService, type ExitPlanPermissionResult } from './agent-exit-plan-service'
import { AgentRunExecutionLeaseRegistry } from './agent-run-execution-lease'
import {
  assertWorktreeContinuationRunEnvelope,
  resolveWorktreeContinuationRunWorkflow,
  worktreeContinuationAuthorizationRegistry,
  type TrustedWorktreeContinuationAuthorization,
} from './agent-worktree-continuation-authorization.ts'
import { appendUsageEntry } from './usage-record-service'
import { getBuiltinMcpName } from './builtin-mcp/baseline'
import { injectChromeDevtoolsMcpServer } from './builtin-mcp/chrome-devtools'
import {
  shouldInjectChromeDevtoolsMcp,
  shouldRequireChromeDevtoolsRestartForQueuedMessage,
} from './builtin-mcp/chrome-devtools-intent'
import { isBuiltinMcpUserEnabled } from './builtin-mcp/settings'
import { buildPiBuiltinTools } from './adapters/pi-builtin-tools'
import { buildPiMcpTools } from './adapters/pi-mcp-tools'
import type { AgentToolAnnotationsMap } from './agent-tool-annotations'
import { buildAgentRuntimeEnv, mergeRuntimeEnv, type AgentRuntimeEnv } from './agent-runtime-env'
import {
  buildWorktreeDependencyPreparationPrompt,
  resolveAgentWorktreeDependencySnapshotRuntime,
  type AgentWorktreeDependencySnapshotRuntime,
} from './worktree-dependency-snapshot.ts'
import { getWorktreeDependencySnapshotService } from './worktree-dependency-snapshot-node.ts'
import { createAgentStartupTimingRecorder } from './agent-startup-timing.ts'
import {
  isUserFacingRunOutput,
  shouldFailRunForEmptyResponse,
} from './agent-run-message-visibility'
import { resolvePiThinkingLevel } from './agent-thinking-level'
import { resolvePiReasoningCapability } from './adapters/pi-model-registry'
import { generateCodexTitle } from './adapters/pi-codex-title-generator'
import { createFallbackTitle, sanitizeGeneratedTitle, TITLE_PROMPT } from './title-generation'
import { AuditWriter } from './audit/audit-writer.ts'
import type { PiRunAuditTimingCallback } from './audit/pi-run-audit.ts'
import { createPiExecutionController } from './pi-execution-controller.ts'
import { gitPushSessionTrustService } from './execution-policy/git-push-session-trust.ts'
import { resolveProductionAgentSessionTarget } from './agent-session-target.ts'
import { canOfferAgentWorktreeHandoff, prepareAgentWorktreeHandoff, validateAgentWorktreeHandoff } from './agent-worktree-handoff.ts'
import { canOfferAgentWorktreeApply } from './agent-worktree-apply.ts'
import { SessionCheckoutError } from './session-checkout/index.ts'
import { clearAndReplayNativeQueue } from './agent-message-queue-replay.ts'
import {
  buildSessionTree,
  filterMessagesToActivePiBranch,
  prependHistoricalTranscript,
  readPiSessionEntries,
  resolveNavigationTarget,
} from './session-tree-service.ts'
import { buildVisionRelayAccessScope } from './vision-relay-access-scope.ts'
import { resolveLaterCheckpointUserIds, type AgentFileRollbackResult } from './agent-file-checkpoint.ts'
import { getAgentFileCheckpointStore } from './agent-file-checkpoint-production.ts'
import type { AgentRewindUndoHostState } from './agent-rewind-undo-types.ts'
import type { AgentStopSource } from './agent-stop-source.ts'
import { AgentStopTracker } from './agent-stop-tracker.ts'

// ===== 类型定义 =====

/**
 * 会话控制信号回调
 *
 * 解耦 Electron webContents，使 Orchestrator 可独立测试。
 * agent-service.ts 负责将这些回调绑定到 webContents.send()。
 */
export interface SessionCallbacks {
  /** 发送流式错误 */
  onError: (error: string) => void
  /** 发送轻量流式终态；完整历史由专用消息 IPC 按需加载。 */
  onComplete: (opts?: { stoppedByUser?: boolean; startedAt?: number; resultSubtype?: string; resultErrors?: string[]; backgroundTasksPending?: boolean }) => void
  /** 发送标题更新 */
  onTitleUpdated: (title: string) => void
  /** 用户消息已持久化，外部入口可据此通知前端切到实时会话 */
  onRunStarted?: (opts: { startedAt: number }) => void
  /** 可见阶段事实变化后通知宿主刷新派生 Work Activity。 */
  onWorkActivityChanged?: () => void
}

type RecoverableAgentQueryOptions = {
  prompt: string
  resumeSessionId?: string
  resumeSessionAt?: string
}

interface NativeQueuedMessageRecord {
  uuid: string
  kind: AgentQueueMessageKind
  rawText: string
}

// ===== 工具函数 =====

const EMPTY_RESPONSE_RESULT_SUBTYPE = 'empty_response'

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingActiveQueueChannelError(error: unknown): boolean {
  return errorMessageOf(error).includes('无活跃消息通道可注入队列消息')
}

function isPartialSDKMessage(message: SDKMessage): boolean {
  return (message as Record<string, unknown>)._partial === true
}

function isAssistantDeltaSDKMessage(message: SDKMessage): message is SDKMessage & {
  type: 'assistant_delta'
  uuid: string
  deltas: AgentAssistantDeltaPayload['deltas']
  session_id?: string
  _channelModelId?: string
} {
  const record = message as Record<string, unknown>
  return record.type === 'assistant_delta'
    && typeof record.uuid === 'string'
    && Array.isArray(record.deltas)
}

/**
 * 从 stderr 中提取 API 错误信息
 *
 * 解析类似这样的错误：
 * "401 {\"error\":{\"message\":\"...\"}}"
 * "API error: 400 Bad Request ..."
 */
function extractApiError(stderr: string): { statusCode: number; message: string } | null {
  if (!stderr) return null

  // 模式 1：JSON 错误格式 - "401 {...}"
  const jsonMatch = stderr.match(/(\d{3})\s+(\{[^}]*"error"[^}]*\})/s)
  if (jsonMatch) {
    try {
      const statusCode = parseInt(jsonMatch[1]!)
      const errorObj = JSON.parse(jsonMatch[2]!)
      const message = errorObj.error?.message || errorObj.message || '未知错误'
      return { statusCode, message }
    } catch {
      // JSON 解析失败，继续尝试其他模式
    }
  }

  // 模式 2：API error 格式 - "API error (attempt X/Y): 401 401 {...}"
  const apiErrorMatch = stderr.match(/API error[^:]*:\s+(\d{3})\s+\d{3}\s+(\{.*?\})/s)
  if (apiErrorMatch) {
    try {
      const statusCode = parseInt(apiErrorMatch[1]!)
      const errorObj = JSON.parse(apiErrorMatch[2]!)
      const message = errorObj.error?.message || errorObj.message || '未知错误'
      return { statusCode, message }
    } catch {
      // JSON 解析失败
    }
  }

  // 模式 3：直接的状态码 + 消息
  const simpleMatch = stderr.match(/(\d{3})[:\s]+(.+?)(?:\n|$)/i)
  if (simpleMatch) {
    const statusCode = parseInt(simpleMatch[1]!)
    const message = simpleMatch[2]!.trim()
    if (statusCode >= 400 && statusCode < 600) {
      return { statusCode, message }
    }
  }

  return null
}

// ===== 自动重试工具函数 =====

/** 可自动重试的 TypedError 错误码 */
const AUTO_RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'rate_limited',
  'provider_error',      // overloaded 映射为 provider_error
  'service_error',
  'service_unavailable',
  'network_error',
])

/** 判断 typed_error 事件是否可自动重试 */
function isAutoRetryableTypedError(error: TypedError): boolean {
  return AUTO_RETRYABLE_ERROR_CODES.has(error.code)
}

/** 判断 catch 块中的 API 错误是否可自动重试（HTTP 429 / 5xx / 已知可恢复错误模式 / 瞬时网络错误） */
function isAutoRetryableCatchError(
  apiError: { statusCode: number; message: string } | null,
  rawErrorMessage?: string,
  stderr?: string,
): boolean {
  if (apiError) {
    // 529 是 Anthropic 的过载状态码，通常很快恢复；与 429 / 5xx 一并重试。
    if (apiError.statusCode === 429 || apiError.statusCode >= 500) return true
  }
  // 已知的可恢复错误模式（无 HTTP 状态码但可重试）
  if (rawErrorMessage) {
    if (rawErrorMessage.includes('context_management')) return true
  }
  // 兜底：extractApiError 未识别但 stderr / 错误文本中包含 502 / 529 或 overloaded 关键字时也视为可重试
  // 502 (Bad Gateway) 通常是上游网关瞬时异常，与 529 一样很快自行恢复
  const text = `${rawErrorMessage ?? ''}\n${stderr ?? ''}`
  if (/\b502\b|\b529\b|overloaded/i.test(text)) return true
  // 瞬时网络错误（terminated / ECONNRESET / socket hang up 等）
  if (isTransientNetworkError(rawErrorMessage, stderr)) return true
  // 上游响应体解析失败（JSON Parse error 等）：网关瞬时异常返回非 JSON 体，重试通常即可恢复
  if (isMalformedResponseError(rawErrorMessage, stderr)) return true
  return false
}

/** 最大自动重试次数 */
const MAX_AUTO_RETRIES = 25

/** 重试可见性阈值：前 N 次重试不通知 UI，避免偶发瞬时波动频繁惊扰用户 */
const RETRY_VISIBILITY_THRESHOLD = 5

/** 自动重试累计等待预算（毫秒） */
const MAX_AUTO_RETRY_WAIT_MS = 5 * 60_000

/** 重试单次延迟上限（毫秒） */
const RETRY_MAX_DELAY_MS = 15_000

/**
 * 计算重试延迟（指数退避 + ±20% jitter）
 *
 * 基础序列：1s, 2s, 4s, 8s, 15s, 15s...（cap = 15s）
 * 叠加 ±20% 随机抖动，避免大量 session 同时重试造成惊群。
 * 累计等待会被限制在 5 分钟以内。
 */
function getRetryDelayMs(attempt: number, elapsedRetryDelayMs: number): number {
  const remainingMs = MAX_AUTO_RETRY_WAIT_MS - elapsedRetryDelayMs
  if (remainingMs <= 0) return 0

  const base = Math.min(1000 * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS)
  const jitter = base * (Math.random() * 0.4 - 0.2)
  return Math.min(remainingMs, Math.max(0, Math.round(base + jitter)))
}

const DEFAULT_SESSION_TITLE = '新 Agent 会话'

/**
 * 聚合一次 Pi 调用涉及的所有附加目录（去重，保持插入顺序）。
 *
 * 初版宿主文件检查点明确只覆盖当前 Session Target，附加目录只用于模型上下文和既有工具授权，
 * 不得因为它们出现在本列表中就宣称可以随消息 rewind。
 *
 * 来源：
 *   1. extraDirs：调用方传入的临时附加目录（例如 sendMessage 时用户当次提交的目录）
 *   2. 当前会话的私有工作目录，以及会话级 attachedDirectories + attachedFiles 的父目录
 *   3. 工作区级 attachedDirectories + attachedFiles 的父目录
 *   4. 项目文件根目录（本地项目为用户目录，空白项目为 workspace-files/）
 */
function collectAttachedDirectories(params: {
  sessionMeta?: AgentSessionMeta
  workspaceSlug?: string
  extraDirs?: string[]
}): string[] {
  const { sessionMeta, workspaceSlug, extraDirs } = params
  const result: string[] = []
  const push = (dir: string | undefined | null) => {
    if (!dir) return
    if (!result.includes(dir)) result.push(dir)
  }

  for (const d of extraDirs ?? []) push(d)
  if (workspaceSlug && sessionMeta) push(getAgentSessionWorkspacePath(workspaceSlug, sessionMeta.id))
  for (const d of sessionMeta?.attachedDirectories ?? []) push(d)
  for (const file of sessionMeta?.attachedFiles ?? []) push(dirname(file))

  if (workspaceSlug) {
    for (const d of getWorkspaceAttachedDirectories(workspaceSlug)) push(d)
    for (const f of getWorkspaceAttachedFiles(workspaceSlug)) push(dirname(f))
    push(getProjectFilesPath(workspaceSlug))
  }

  return result
}

function escapePromptXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function buildPiAdditionalDirectoriesPrompt(directories: string[]): string {
  if (directories.length === 0) return ''
  const directoryLines = directories
    .map((dir, index) => `  <directory index="${index + 1}">${escapePromptXml(dir)}</directory>`)
    .join('\n')
  return `

<attached_directories>
这些目录已由 Domi 授权给当前会话，和当前工作目录同属于用户允许访问的范围。
如需读取或修改这些目录中的内容，请直接使用绝对路径，不要先复制到当前工作目录。
${directoryLines}
</attached_directories>`
}

// ===== AgentOrchestrator =====

export class AgentOrchestrator {
  private adapter: AgentProviderAdapter
  private eventBus: AgentEventBus
  private activeSessions = new Map<string, number>()
  private runExecutionLeases = new AgentRunExecutionLeaseRegistry()
  /** 文件/对话 rewind 占用同一 session mutation slot，供发送与 Checkout guard 共同识别。 */
  private rewindSessions = new Set<string>()

  /** 当前 Pi run 已实际桥接 Chrome DevTools 工具的会话。 */
  private activeChromeDevtoolsSessions = new Set<string>()

  /** 停止来源需持久化，便于问题发生后区分按钮、队列中止、Bridge 与内部导航。 */
  private stopAuditWriter = new AuditWriter({ auditDir: join(getConfigDir(), 'audit') })

  /** 当前 Pi run 已实际注入的生图工具，供流式追加的 /image 命令复用。 */
  private activeImageToolNames = new Map<string, string[]>()

  /** 队列消息本地记录（sessionId → UUID 集合，用于防重） */
  private queuedMessageUuids = new Map<string, Set<string>>()

  /** Pi SDK 原生队列的 renderer 镜像元数据；实际送达时序仍以 SDK queue_update 为准。 */
  private nativeQueuedMessages = new Map<string, NativeQueuedMessageRecord[]>()

  /** 已中止 run 的 generation 与来源；仅允许同一 generation 的终态消费，避免迟到 stop 污染下一轮。 */
  private stopTracker = new AgentStopTracker()

  /** Legacy Runtime 运行中的权限模式。 */
  private sessionPermissionModes = new Map<string, DomiPermissionMode>()

  /** Pi 运行中的有效 Execution Policy 与 Workflow。持久模式与当前 run 临时 lease 分离。 */
  private sessionExecutionPolicies = new Map<string, ExecutionPolicyMode>()
  private sessionWorkflows = new Map<string, AgentWorkflow>()

  /** 当前 Pi run 的受控文件工具应写入哪个 user-message checkpoint。 */
  private activeFileCheckpointContexts = new Map<string, { generation: number; targetRoot: string; userMessageUuid: string }>()

  /** Adapter 尚未创建时，用户停止仍必须能取消 Windows Worktree 依赖快照物化。 */
  private dependencyPreparationControllers = new Map<string, { generation: number; controller: AbortController }>()

  constructor(adapter: AgentProviderAdapter, eventBus: AgentEventBus) {
    this.adapter = adapter
    this.eventBus = eventBus
  }

  /**
   * 消费当前 run 的停止标记。
   *
   * SDK 在 query.close() 后不一定走异常路径：某些版本会先正常 yield result 再结束迭代。
   * 标记绑定 run generation，迟到的旧 stop 不能让下一轮被误报为用户中止。
   */
  private consumeStoppedByUser(sessionId: string, runGeneration: number): boolean {
    const source = this.stopTracker.consume(sessionId, runGeneration)
    if (!source) return false
    console.log(`[Agent 编排] 已消费停止标记: sessionId=${sessionId}, generation=${runGeneration}, source=${source}`)
    this.recordStopAudit('consumed', { sessionId, generation: runGeneration, source })
    return true
  }

  private recordStopAudit(
    action: 'requested' | 'ignored' | 'consumed',
    data: { sessionId: string; source: AgentStopSource; generation?: number; reason?: string },
  ): void {
    void this.stopAuditWriter.record({ category: 'agent_stop', action, data }).then((result) => {
      if (!result.written) console.warn(`[Agent 编排] 停止审计写入失败: action=${action}, sessionId=${data.sessionId}`)
    })
  }

  private emitTemporaryExecutionChanged(sessionId: string, runGeneration: number, active: boolean): void {
    this.eventBus.emit(sessionId, {
      kind: 'domi_event',
      event: { type: 'temporary_execution_changed', sessionId, active, runToken: runGeneration },
    })
  }

  /** 为当前 run 授予一次性执行；不写 session meta，也不改变后续 turn 的持久模式。 */
  private grantTemporaryExecution(sessionId: string, runGeneration: number): boolean {
    if (this.activeSessions.get(sessionId) !== runGeneration) return false
    this.runExecutionLeases.grant(sessionId, runGeneration)
    this.sessionExecutionPolicies.set(sessionId, 'full-access')
    this.sessionWorkflows.set(sessionId, 'direct')
    this.sessionPermissionModes.set(sessionId, 'bypassPermissions')
    this.emitTemporaryExecutionChanged(sessionId, runGeneration, true)
    return true
  }

  /** 在用户队列消息进入下一任务前或 run 结束时撤销一次性执行。 */
  private revokeTemporaryExecution(sessionId: string, runGeneration: number | undefined): boolean {
    if (runGeneration === undefined || !this.runExecutionLeases.revoke(sessionId, runGeneration)) return false
    const session = getAgentSessionMeta(sessionId)
    const persistent = session
      ? normalizeAgentExecutionSettings({
          executionPolicy: session.executionPolicy,
          workflow: session.workflow,
          piToolProfile: session.piToolProfile,
          permissionMode: session.permissionMode,
        })
      : { executionPolicy: 'full-access' as const, workflow: 'read-only' as const, piToolProfile: 'read-only' as const }
    this.sessionExecutionPolicies.set(sessionId, persistent.executionPolicy)
    this.sessionWorkflows.set(sessionId, persistent.workflow)
    this.sessionPermissionModes.set(sessionId, 'bypassPermissions')
    this.emitTemporaryExecutionChanged(sessionId, runGeneration, false)
    return true
  }

  /**
   * 构建 SDK 环境变量
   *
   * 注入 API Key、Base URL、代理、Shell 配置等。
   * 对 Kimi Coding Plan / MiniMax Coding Plan：使用 Bearer 认证（ANTHROPIC_AUTH_TOKEN）。
   */
  private buildPiRuntimeEnv(
    proxyUrl: string | undefined,
    runtimeStatus: ReturnType<typeof getRuntimeStatus> = getRuntimeStatus(),
  ): AgentRuntimeEnv {
    return buildAgentRuntimeEnv({
      proxyUrl,
      runtimeStatus,
      windowsShellPreference: getSettings().windowsShellPreference,
      processEnv: process.env,
    })
  }

  /**
   * 构建工作区 MCP 服务器配置
   */
  private buildMcpServers(workspaceSlug: string | undefined, includePiGlobal = false): Record<string, Record<string, unknown>> {
    const mcpServers: Record<string, Record<string, unknown>> = {}
    if (!workspaceSlug) return mcpServers

    const mcpConfig = includePiGlobal
      ? getEffectiveWorkspaceMcpConfig(workspaceSlug)
      : getWorkspaceMcpConfig(workspaceSlug)
    for (const [name, entry] of Object.entries(mcpConfig.servers ?? {})) {
      if (!entry.enabled) continue
      if (name === 'memos-cloud') continue
      const type = normalizeMcpTransportType((entry as { type?: unknown }).type)

      if (type === 'stdio' && entry.command) {
        const mergedEnv: Record<string, string> = {
          ...(process.env.PATH && { PATH: process.env.PATH }),
          ...entry.env,
        }
        mcpServers[name] = {
          type: 'stdio',
          command: entry.command,
          ...(entry.args && entry.args.length > 0 && { args: entry.args }),
          ...(Object.keys(mergedEnv).length > 0 && { env: mergedEnv }),
          required: false,
          startup_timeout_sec: entry.timeout ?? 30,
          ...(entry.trustReadOnlyAnnotations === true && { trustReadOnlyAnnotations: true }),
        }
      } else if ((type === 'http' || type === 'sse') && entry.url) {
        mcpServers[name] = {
          type,
          url: entry.url,
          ...(entry.headers && Object.keys(entry.headers).length > 0 && { headers: entry.headers }),
          required: false,
          ...(entry.trustReadOnlyAnnotations === true && { trustReadOnlyAnnotations: true }),
        }
      } else {
        console.warn(`[Agent 编排] MCP 服务器 "${name}" 配置不完整，已跳过（type=${entry.type}, command=${entry.command ?? '无'}, url=${entry.url ?? '无'}）`)
      }
    }

    if (Object.keys(mcpServers).length > 0) {
      console.log(`[Agent 编排] 已加载 ${Object.keys(mcpServers).length} 个 MCP 服务器`)
    }

    return mcpServers
  }

  /**
   * 生成 Agent 会话标题
   *
   * 使用 Provider 适配器系统，支持所有渠道。任何错误返回 null。
   */
  async generateTitle(input: AgentGenerateTitleInput, signal?: AbortSignal): Promise<string | null> {
    const { userMessage, channelId, modelId } = input
    if (signal?.aborted) return null
    console.log('[Agent 标题生成] 开始生成标题:', { channelId, modelId, userMessage: userMessage.slice(0, 50) })

    // 渠道信息在异常路径也要用于判断是否应用 OpenCode Go 本地兜底，因此提前解析；
    // 同时保留 listChannels 自身的错误边界：解析失败时按“无渠道”处理并返回 null。
    let channel: import('@domi/shared').Channel | undefined
    try {
      channel = listChannels().find((c) => c.id === channelId)
    } catch (error) {
      console.warn('[Agent 标题生成] 渠道解析失败:', error)
      return null
    }
    if (!channel) {
      console.warn('[Agent 标题生成] 渠道不存在:', channelId)
      return null
    }

    if (channel.provider === 'openai-codex') {
      const fallbackTitle = createFallbackTitle(userMessage)
      try {
        const [credentials, proxyUrl] = await Promise.all([
          resolveCodexOAuthCredentials(channelId),
          getEffectiveProxyUrl(),
        ])
        if (signal?.aborted) return null
        const generatedTitle = await generateCodexTitle({
          modelId,
          prompt: TITLE_PROMPT + userMessage,
          credentials,
          proxyUrl,
          signal,
          onCredentialsRefreshed: (refreshed) => persistCodexOAuthCredentials(channelId, refreshed),
        })
        if (signal?.aborted) return null
        const title = generatedTitle ? sanitizeGeneratedTitle(generatedTitle) : null
        if (title) {
          console.log(`[Agent 标题生成] ChatGPT OAuth 语义标题生成成功: "${title}"`)
          return title
        }
        console.warn('[Agent 标题生成] ChatGPT OAuth 返回空标题，使用本地兜底')
      } catch (error) {
        if (signal?.aborted) return null
        console.warn('[Agent 标题生成] ChatGPT OAuth 语义标题生成失败，使用本地兜底:', error)
      }
      return fallbackTitle
    }

    try {
      const apiKey = await resolveChannelRuntimeApiKey(channelId)
      const providerAdapter = getAdapter(channel.provider)
      const request = providerAdapter.buildTitleRequest({
        baseUrl: channel.baseUrl,
        apiKey,
        modelId,
        prompt: TITLE_PROMPT + userMessage,
      })

      const proxyUrl = await getEffectiveProxyUrl()
      const fetchFn = getFetchFn(proxyUrl)
      const title = await fetchTitle(request, providerAdapter, fetchFn)
      const result = title ? sanitizeGeneratedTitle(title) : null
      if (!result) {
        console.warn('[Agent 标题生成] API 未返回可用标题')
        // OpenCode Go 的推理模型可能把输出预算全花在推理上返回空正文，或
        // 内容块为数组；任何取不到可用标题的情况都回退到首行兜底，保证会话一定被重命名。
        return channel.provider === 'opencode-go-openai' ? createFallbackTitle(userMessage) : null
      }

      console.log(`[Agent 标题生成] 生成标题成功: "${result}"`)
      return result
    } catch (error) {
      console.warn('[Agent 标题生成] 生成失败:', error)
      // OpenCode Go 的服务端偶发返回空标题/异常响应/超时，异常路径同样要完成重命名。
      return channel.provider === 'opencode-go-openai' ? createFallbackTitle(userMessage) : null
    }
  }

  /**
   * 流完成后自动生成标题
   *
   * 如果会话标题仍为默认值，自动调用标题生成并通过回调通知。
   */
  private async autoGenerateTitle(
    sessionId: string,
    userMessage: string,
    channelId: string,
    modelId: string,
    callbacks: SessionCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) return
    try {
      const meta = getAgentSessionMeta(sessionId)
      if (!meta || meta.title !== DEFAULT_SESSION_TITLE) return

      const title = await this.generateTitle({ userMessage, channelId, modelId }, signal)
      if (!title || signal?.aborted) return

      // 标题请求是异步的；请求期间用户可能已手动重命名，不能用旧结果覆盖。
      const latestMeta = getAgentSessionMeta(sessionId)
      if (!latestMeta || latestMeta.title !== DEFAULT_SESSION_TITLE) return

      updateAgentSessionMeta(sessionId, { title })
      callbacks.onTitleUpdated(title)
      console.log(`[Agent 编排] 自动标题生成完成: "${title}"`)
    } catch (error) {
      if (signal?.aborted) return
      console.warn('[Agent 编排] 自动标题生成失败:', error)
    }
  }

  /**
   * Session-not-found 恢复：保留磁盘 sdkSessionId，本轮切换到上下文回填模式
   *
   * 当 resume 的目标 session 报 "No conversation found" 时触发。注意该错误可能是
   * listSessions 路径哈希不匹配导致的误检（见步骤 9.6 注释），不代表会话真正失效，
   * 因此不清除磁盘 meta：本轮以非 resume 模式恢复，若失败下一轮仍可尝试 resume（#903）。
   * 调用方负责设置本地 existingSdkSessionId = undefined 和流程控制（break/continue）。
   *
   * @returns lastRetryableError 描述字符串
   */
  private prepareSessionNotFoundRecovery(
    sessionId: string,
    queryOptions: RecoverableAgentQueryOptions,
    contextualMessage: string,
    agentCwd: string,
    workspaceSlug: string | undefined,
    accumulatedMessages: SDKMessage[],
    queryStartedAt: number,
  ): string {
    return this.prepareResumeFallbackRecovery(
      sessionId,
      queryOptions,
      contextualMessage,
      agentCwd,
      workspaceSlug,
      accumulatedMessages,
      queryStartedAt,
      '检测到 session-not-found（可能为误检），保留 sdkSessionId 并切换到上下文回填模式',
      'Session 暂不可 resume，切换到上下文回填模式',
    )
  }

  /**
   * Resume 失败恢复：本轮切到「非 resume + 历史回填恢复」模式，注入 session 自引用让 Agent
   * 优先通过 session-cleaner 读取干净历史继续工作。使用 <session_recovery> 标签指向当前会话，
   * 比 buildContextPrompt（仅注入 20 条摘要）提供完整得多的上下文连续性。
   *
   * 关于磁盘 meta 的 sdkSessionId（由 clearPersistedSession 控制，默认 false 即保留）：
   * - 默认保留：本轮恢复只改本地 queryOptions，不动磁盘；若本轮成功，SDK 新会话的 ID 会经
   *   onSessionId 回调自动覆盖 meta；若本轮失败到终止，下一轮仍可尝试 resume 旧 ID（#903）。
   *   这是「迷了就别删」的安全默认，适用于 session-not-found（可能为误检）等不确定场景。
   * - 仅 thinking-signature 跨模型不兼容时传 true：旧 ID 指向的 JSONL 焊死了旧模型思考块，
   *   当前模型 resume 必然再次失败，此时主动清除可避免下一轮无谓的失败往返。
   */
  private prepareResumeFallbackRecovery(
    sessionId: string,
    queryOptions: RecoverableAgentQueryOptions,
    contextualMessage: string,
    agentCwd: string,
    workspaceSlug: string | undefined,
    accumulatedMessages: SDKMessage[],
    queryStartedAt: number,
    logMessage: string,
    retryReason: string,
    clearPersistedSession = false,
  ): string {
    console.log(`[Agent 编排] ${logMessage}`)
    // 先持久化当前已累积的消息，确保 JSONL 文件包含最新内容
    this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
    accumulatedMessages.length = 0
    // 仅在确定旧会话永久无效时（thinking-signature）才清除磁盘 meta；
    // 其余场景保留，新 SDK 会话产生的 sdkSessionId 会通过 onSessionId 回调自动覆盖。
    if (clearPersistedSession) {
      try { updateAgentSessionMeta(sessionId, { sdkSessionId: undefined }) } catch { /* 忽略 */ }
    }
    queryOptions.resumeSessionId = undefined
    queryOptions.resumeSessionAt = undefined
    queryOptions.prompt = buildRecoveryPrompt(sessionId, contextualMessage, { agentCwd, workspaceSlug })
    return retryReason
  }

  /**
   * 持久化累积的 SDKMessage（Phase 4: 直接存储原始 SDKMessage）
   *
   * 只持久化 assistant、user、result 和需要长期可见的 system 消息。
   */
  private persistSDKMessages(
    sessionId: string,
    accumulatedMessages: SDKMessage[],
    durationMs?: number,
  ): void {
    if (accumulatedMessages.length === 0) return

    const hasCompactBoundary = accumulatedMessages.some((m) => {
      return m.type === 'system' && (m as SDKSystemMessage).subtype === 'compact_boundary'
    })

    const toPersist = accumulatedMessages.filter(
      (m) => m.type === 'assistant' || m.type === 'user' || m.type === 'result'
        || (m.type === 'system' && isPersistableSDKSystemMessage(m as SDKSystemMessage))
    ).filter((m) => {
      if (isPartialSDKMessage(m)) return false
      if (m.type === 'system') {
        const sysMsg = m as SDKSystemMessage
        if (hasCompactBoundary && sysMsg.subtype === 'status' && sysMsg.compact_result === 'success') {
          return false
        }
      }
      // 过滤 SDK 内部生成的 user 文本消息（如 Skill 展开 prompt），与实时流过滤逻辑一致
      if (m.type === 'user') {
        const content = (m as { message?: { content?: Array<{ type: string }> } }).message?.content
        const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
        if (!hasToolResult) return false
      }
      return true
    })

    if (toPersist.length === 0) return

    // 为没有 _createdAt 的消息补上时间戳（assistant 消息来自 SDK 原始输出，不含时间）
    const now = Date.now()
    const withTimestamps = toPersist.map((m) => {
      const msg = m as Record<string, unknown>
      if (typeof msg._createdAt === 'number') return m
      // 为 result 消息附加 _durationMs
      if (m.type === 'result' && durationMs != null) {
        return { ...m, _createdAt: now, _durationMs: durationMs } as unknown as SDKMessage
      }
      return { ...m, _createdAt: now } as unknown as SDKMessage
    })

    appendSDKMessages(sessionId, withTimestamps)
  }

  /**
   * 记录本轮 Agent 查询的 token 用量与费用（追加式写入 usage-entries.jsonl）
   *
   * 跳过 synthetic compaction 收束 result；普通 result 可聚合同一 run 内多次 provider 调用，
   * 请求数由逐条 final assistant usage 采集，兼容端点只保留可验证下限。
   */
  private recordAgentUsage(
    resultMsg: SDKResultMessage,
    sessionId: string,
    channelName: string,
    channelProvider: string,
    modelId: string | undefined,
    title: string | undefined,
    durationMs: number,
  ): void {
    if (resultMsg.isSyntheticCompactionResult) return
    const usage = resultMsg.usage
    if (!usage) return
    const totalCostUsd = resultMsg.total_cost_usd
    const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    const outputTokens = usage.output_tokens ?? 0
    // 无真实调用的合成结果不记录（防止垃圾条目污染统计）
    if (inputTokens <= 0 && outputTokens <= 0 && totalCostUsd == null) return
    const providerRequestCount = resultMsg._providerRequestCount ?? 1
    const providerRequestCountAccuracy = resultMsg._providerRequestCountAccuracy ?? 'minimum'

    try {
      appendUsageEntry({
        timestamp: Date.now(),
        mode: 'agent',
        channelId: resultMsg._channelId ?? '',
        channelName,
        provider: channelProvider,
        modelId: resultMsg._channelModelId ?? modelId,
        sessionId,
        title,
        inputTokens,
        outputTokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheCreationTokens: usage.cache_creation_input_tokens,
        costUsd: totalCostUsd,
        durationMs,
        providerRequestCount,
        providerRequestCountAccuracy,
      })
    } catch (error) {
      // 用量记录失败不影响主流程
      console.warn('[Agent 编排] 记录 token 用量失败:', error)
    }
  }

  private persistUserMessage(
    sessionId: string,
    userMessage: string,
    createdAt = Date.now(),
    nextTurnAsides: readonly AgentNextTurnAside[] = [],
    presetUuid?: string,
  ): string {
    const uuid = presetUuid ?? randomUUID()
    const userSDKMsg: SDKMessage = {
      type: 'user',
      uuid,
      message: {
        content: [{ type: 'text', text: userMessage }],
      },
      parent_tool_use_id: null,
      _createdAt: createdAt,
      ...(nextTurnAsides.length > 0 && { _asides: nextTurnAsides }),
    } as unknown as SDKMessage
    appendSDKMessages(sessionId, [userSDKMsg])
    return uuid
  }

  private persistEmptyResponseError(
    sessionId: string,
    resultSubtype: string | undefined,
    resultErrors: string[] | undefined,
  ): string {
    const detail = resultErrors?.find((error) => error.trim().length > 0)?.trim()
    const subtype = resultSubtype ?? 'unknown'
    const errorContent = detail
      ? `Agent 本轮结束了，但没有返回任何可展示内容。错误详情：${detail}`
      : resultSubtype === 'success'
        ? 'Agent 本轮结束了，但没有返回任何可展示内容。你的消息已保留，可以直接重试或切换模型。'
        : `Agent 本轮异常结束（${subtype}），但没有返回任何可展示内容。你的消息已保留，可以直接重试或切换模型。`
    const errorSDKMsg: SDKMessage = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: errorContent }],
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      error: { message: errorContent, errorType: EMPTY_RESPONSE_RESULT_SUBTYPE },
      _createdAt: Date.now(),
      _errorCode: 'unknown_error',
      _errorTitle: '没有收到模型回复',
      _errorCanRetry: true,
      _errorActions: [
        { key: 'r', label: '重试', action: 'retry' },
        { key: 'm', label: '重新选择模型', action: 'select_model' },
      ],
    } as unknown as SDKMessage
    appendSDKMessages(sessionId, [errorSDKMsg])
    console.warn(`[Agent 编排] 本轮没有收到可展示内容: sessionId=${sessionId}, resultSubtype=${subtype}`)
    return errorContent
  }

  /**
   * 发送消息并流式推送事件
   *
   * 核心编排方法，从 agent-service.ts 的 runAgent 提取。
   * 通过 EventBus 分发 AgentEvent，通过 callbacks 发送控制信号。
   */
  async sendMessage(input: AgentSendInput, callbacks: SessionCallbacks): Promise<void> {
    const { sessionId, userMessage, rawUserMessage, userMessageUuid, nextTurnAsides, channelId, modelId, workspaceId: requestedWorkspaceId, additionalDirectories, customTools, executionPolicyOverride, workflowOverride, permissionModeOverride, mentionedSkills, mentionedMcpServers, mentionedSessionIds, mentionedTodoIds, mentionedCalendarEventIds, automationContext, retryOfErrorUuid, worktreeContinuationAuthorizationToken } = input
    const normalizedNextTurnAsides = normalizeAgentNextTurnAsides(nextTurnAsides)
    const stderrChunks: string[] = []
    const streamStartedAt = input.startedAt ?? Date.now()
    let userMessagePersisted = false
    let persistedUserMessageUuid: string | undefined
    let sessionMeta = getAgentSessionMeta(sessionId)
    let trustedWorktreeContinuation: TrustedWorktreeContinuationAuthorization | undefined
    let prevalidatedWorktreeContinuationTarget: Awaited<ReturnType<typeof resolveProductionAgentSessionTarget>> | undefined
    if (
      worktreeContinuationAuthorizationToken === undefined
      && worktreeContinuationAuthorizationRegistry.isConfirmationInProgress(sessionId)
    ) {
      callbacks.onError('Worktree 续跑确认正在处理中，请等待完成后再发送')
      callbacks.onComplete({ startedAt: streamStartedAt })
      return
    }
    if (worktreeContinuationAuthorizationToken === undefined) {
      worktreeContinuationAuthorizationRegistry.noteSessionActivity(sessionId)
    }

    const persistInitialUserMessage = (): void => {
      if (userMessagePersisted) return
      persistedUserMessageUuid = this.persistUserMessage(
        sessionId,
        rawUserMessage ?? userMessage,
        streamStartedAt,
        normalizedNextTurnAsides,
        userMessageUuid,
      )
      userMessagePersisted = true
      callbacks.onRunStarted?.({ startedAt: streamStartedAt })
    }

    // 0. 并发保护
    if (this.rewindSessions.has(sessionId)) {
      callbacks.onError('会话正在回退，请等待完成后再发送')
      callbacks.onComplete({ startedAt: streamStartedAt })
      return
    }
    if (this.activeSessions.has(sessionId)) {
      worktreeContinuationAuthorizationRegistry.clearSession(sessionId)
      console.warn(`[Agent 编排] 会话 ${sessionId} 正在处理中，拒绝新请求`)
      try {
        persistInitialUserMessage()
        if (persistedUserMessageUuid) getAgentFileCheckpointStore().markNoMutation(sessionId, persistedUserMessageUuid)
      } catch (error) {
        console.error('[Agent 编排] 持久化被拒绝的用户消息失败:', error)
      }
      callbacks.onError('上一条消息仍在处理中，请稍候再试')
      callbacks.onComplete({ startedAt: streamStartedAt })
      return
    }

    if (sessionMeta?.delegationCheckoutReleasedAt !== undefined) {
      callbacks.onError('该协作会话已结束并释放 Worktree 占用，历史记录仍可查看，但不能继续运行。请创建新的协作子会话。')
      callbacks.onComplete({ startedAt: streamStartedAt })
      return
    }

    // 在 finalize undo、追加用户消息以及任何 await 之前抢占 session slot。
    // rewind/undo 会因此 fail closed；Session Tree 若显式中止本轮，generation 检查会阻止旧 preflight 继续。
    const runGeneration = this.runExecutionLeases.createRunToken()
    this.activeSessions.set(sessionId, runGeneration)
    this.activeChromeDevtoolsSessions.delete(sessionId)
    this.activeImageToolNames.delete(sessionId)

    const releaseActiveRun = (): void => {
      if (worktreeContinuationAuthorizationToken !== undefined) {
        worktreeContinuationAuthorizationRegistry.clearSession(sessionId)
      }
      const ownsActiveRun = this.activeSessions.get(sessionId) === runGeneration
      if (ownsActiveRun) {
        this.revokeTemporaryExecution(sessionId, runGeneration)
        this.activeSessions.delete(sessionId)
        this.activeChromeDevtoolsSessions.delete(sessionId)
        this.activeImageToolNames.delete(sessionId)
        this.sessionPermissionModes.delete(sessionId)
        this.sessionExecutionPolicies.delete(sessionId)
        this.sessionWorkflows.delete(sessionId)
        this.queuedMessageUuids.delete(sessionId)
        this.nativeQueuedMessages.delete(sessionId)
        const checkpointContext = this.activeFileCheckpointContexts.get(sessionId)
        if (checkpointContext?.generation === runGeneration) this.activeFileCheckpointContexts.delete(sessionId)
      }
    }

    try {
      await this.recoverInterruptedRewind(sessionId)
      if (this.activeSessions.get(sessionId) !== runGeneration || this.rewindSessions.has(sessionId)) {
        releaseActiveRun()
        callbacks.onError('会话状态已变化，本次发送已取消')
        callbacks.onComplete({ startedAt: streamStartedAt })
        return
      }
    } catch (error) {
      releaseActiveRun()
      callbacks.onError(`未完成的回退事务恢复失败：${error instanceof Error ? error.message : String(error)}`)
      callbacks.onComplete({ startedAt: streamStartedAt })
      return
    }

    // 一次性 continuation 在写入 transcript 前完成完整 envelope、精确消息、run generation
    // 与权威 Checkout lease 校验。失败输入不能留下伪造的已确认用户消息。
    if (worktreeContinuationAuthorizationToken !== undefined) {
      try {
        if (typeof worktreeContinuationAuthorizationToken !== 'string' || !worktreeContinuationAuthorizationToken.trim()) {
          throw new Error('Worktree 续跑授权格式无效')
        }
        assertWorktreeContinuationRunEnvelope(input)
        const sessionWorkspaceId = sessionMeta?.workspaceId
        if (sessionWorkspaceId && requestedWorkspaceId && requestedWorkspaceId !== sessionWorkspaceId) {
          throw new Error('当前会话所属项目与请求项目不一致，已拒绝 Worktree 续跑')
        }
        const workspace = sessionWorkspaceId ? getAgentWorkspace(sessionWorkspaceId) : undefined
        if (sessionWorkspaceId && !workspace) throw new Error(`指定的 Agent 项目不存在或已删除: ${sessionWorkspaceId}`)
        prevalidatedWorktreeContinuationTarget = await resolveProductionAgentSessionTarget({
          sessionId,
          workspace,
          agentCwdMode: sessionMeta?.agentCwdMode,
        })
        trustedWorktreeContinuation = worktreeContinuationAuthorizationRegistry.consume({
          token: worktreeContinuationAuthorizationToken,
          sessionId,
          continuationMessage: userMessage,
          runGeneration,
          lease: prevalidatedWorktreeContinuationTarget.lease,
        })
      } catch (error) {
        worktreeContinuationAuthorizationRegistry.clearSession(sessionId)
        releaseActiveRun()
        callbacks.onError(error instanceof Error ? error.message : 'Worktree 续跑授权无效或已过期')
        callbacks.onComplete({ startedAt: streamStartedAt })
        return
      }
    }

    // 手动重试直接删除原错误，避免它在下一轮完成后仍被历史回放。
    // 删除失败不阻断重试（例如旧版本遗留的无 UUID 错误）。
    if (retryOfErrorUuid) {
      try {
        removeSDKErrorMessage(sessionId, retryOfErrorUuid)
      } catch (error) {
        console.warn(`[Agent 编排] 删除重试前错误失败: ${retryOfErrorUuid}`, error)
      }
    }

    try {
      // 用户开始新的 turn 后，最近一次回退不再可撤销；必须在追加新 transcript 前先原子收口。
      getAgentFileCheckpointStore().finalizeRewindUndo(sessionId)
      persistInitialUserMessage()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[Agent 编排] 持久化用户消息失败:', error)
      releaseActiveRun()
      callbacks.onError(`消息保存或回退撤销窗口收口失败：${message}`)
      callbacks.onComplete({ startedAt: streamStartedAt })
      return
    }

    // 0.5 清除上一轮中断标记
    try { updateAgentSessionMeta(sessionId, { stoppedByUser: false }) } catch { /* 会话可能已删除 */ }

    // 环境 / 配置类错误的统一上报：持久化为 TypedError 消息，由 SDKMessageRenderer 渲染
    const reportPreflightError = (typedError: TypedError) => {
      if (persistedUserMessageUuid && !this.activeFileCheckpointContexts.has(sessionId)) {
        try {
          getAgentFileCheckpointStore().markNoMutation(sessionId, persistedUserMessageUuid)
        } catch (error) {
          console.warn('[file-checkpoint] failed to mark no-mutation preflight turn:', error)
        }
      }
      const errorContent = typedError.title
        ? `${typedError.title}: ${typedError.message}`
        : typedError.message
      const errorSDKMsg: SDKMessage = {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: errorContent }],
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        error: { message: typedError.message, errorType: typedError.code },
        _createdAt: Date.now(),
        _errorCode: typedError.code,
        _errorTitle: typedError.title,
        _errorDetails: typedError.details,
        _errorCanRetry: typedError.canRetry,
        _errorActions: typedError.actions,
      } as unknown as SDKMessage
      try { appendSDKMessages(sessionId, [errorSDKMsg]) } catch (e) {
        console.error('[Agent 编排] 持久化 preflight error 失败:', e)
      }
      releaseActiveRun()
      callbacks.onError(errorContent)
      callbacks.onComplete({ startedAt: streamStartedAt })
    }

    // 会话元数据是运行项目的权威来源。渲染端的当前项目只是导航状态，不能
    // 覆盖已存在会话的项目归属，否则会把 Agent cwd 指到另一个用户项目根。
    const sessionWorkspaceId = sessionMeta?.workspaceId
    if (sessionWorkspaceId && requestedWorkspaceId && requestedWorkspaceId !== sessionWorkspaceId) {
      reportPreflightError({
        code: 'unknown_error',
        title: '会话项目不匹配',
        message: '当前会话所属项目与请求项目不一致，已拒绝执行以避免访问错误的项目目录。',
        actions: [],
        canRetry: false,
      })
      return
    }
    const workspaceId = sessionWorkspaceId ?? requestedWorkspaceId
    // runtime 同样以会话元数据为真源；仅兼容尚未持久化 runtime 的历史会话输入。

    if (workspaceId) {
      const workspace = getAgentWorkspace(workspaceId)
      if (!workspace) {
        reportPreflightError({
          code: 'workspace_not_found',
          title: '项目不存在',
          message: `指定的 Agent 项目不存在或已删除: ${workspaceId}`,
          actions: [],
          canRetry: false,
        })
        return
      }

    }

    // 1. Windows 平台：检查 Shell 环境可用性
    if (process.platform === 'win32') {
      const runtimeStatus = getRuntimeStatus()
      const shellStatus = runtimeStatus?.shell

      if (shellStatus && !shellStatus.gitBash?.available && !shellStatus.wsl?.available) {
        reportPreflightError({
          code: 'windows_shell_missing',
          title: 'Windows 环境未就绪',
          message:
            '需要 Git Bash 或 WSL 才能运行 Agent。建议安装 Git for Windows（自带 Git Bash），安装完成后点「打开环境检测」刷新状态。',
          details: [
            `Git Bash: ${shellStatus.gitBash?.error || '未检测到'}`,
            `WSL: ${shellStatus.wsl?.error || '未检测到'}`,
          ],
          actions: [
            { key: 'e', label: '打开环境检测', action: 'open_environment_check' },
            { key: 'g', label: '去官方下载 Git', action: 'open_external', payload: 'https://git-scm.com/download/win' },
          ],
          canRetry: false,
        })
        return
      }
    }

    // 2. 获取渠道信息并解密 API Key
    const channel = getChannelById(channelId)
    if (!channel) {
      reportPreflightError({
        code: 'channel_not_found',
        title: '渠道不存在',
        message: '当前会话引用的渠道已被删除或不可用，请在设置中重新选择。',
        actions: [
          { key: 's', label: '打开渠道设置', action: 'open_channel_settings' },
        ],
        canRetry: false,
      })
      return
    }

    let apiKey: string
    let codexOAuthCredentials: CodexOAuthCredentials | undefined
    try {
      // ChatGPT (Codex) OAuth 渠道必须保留完整凭据给 Pi runtime，才能按真实
      // expires 刷新；其余渠道只需解密 API Key。
      if (channel.provider === 'openai-codex') {
        codexOAuthCredentials = await resolveCodexOAuthCredentials(channelId)
        apiKey = codexOAuthCredentials.access
      } else {
        apiKey = decryptApiKey(channelId)
      }
    } catch (err) {
      if (channel.provider === 'openai-codex') {
        reportPreflightError({
          code: 'expired_oauth_token',
          title: 'ChatGPT 登录已失效',
          message: '无法刷新 ChatGPT 登录凭据，登录可能已过期或被撤销。请在设置中重新登录 ChatGPT。',
          actions: [
            { key: 's', label: '打开渠道设置', action: 'open_channel_settings' },
          ],
          canRetry: false,
        })
        return
      }
      reportPreflightError({
        code: 'api_key_decrypt_failed',
        title: 'API Key 解密失败',
        message: '无法解密此渠道的 API Key，可能是系统密钥环异常。请到设置中重新填写 API Key。',
        actions: [
          { key: 's', label: '打开渠道设置', action: 'open_channel_settings' },
        ],
        canRetry: false,
      })
      return
    }

    const appSettings = getSettings()
    console.log('[Agent 编排] Agent runtime: pi')

    if (!channel.enabled) {
      reportPreflightError({
        code: 'channel_disabled',
        title: '渠道已禁用',
        message: '当前会话引用的渠道已被禁用，请在设置中启用渠道或重新选择模型。',
        actions: [
          { key: 's', label: '打开渠道设置', action: 'open_channel_settings' },
        ],
        canRetry: false,
      })
      return
    }

    if (this.activeSessions.get(sessionId) !== runGeneration || this.rewindSessions.has(sessionId)) {
      releaseActiveRun()
      callbacks.onError('会话状态已变化，本次发送已取消')
      callbacks.onComplete({ startedAt: streamStartedAt })
      return
    }
    const completeRun = (
      opts?: { stoppedByUser?: boolean; startedAt?: number; resultSubtype?: string; resultErrors?: string[] },
    ): void => {
      releaseActiveRun()
      callbacks.onComplete(opts)
    }
    // 轻量完成：turn 主体结束但仍有后台任务在飞行。
    // 关键区别——不调用 releaseActiveRun，保留 activeSessions/activeChannels/sessionPermissionModes，
    // 以便 ① adapter 保持的通道在任务完成时自动续轮 ② 用户在等待期手动注入消息能复用通道。
    // UI 侧通过 backgroundTasksPending 进入"空闲可输入"态（spinner 停、输入框启用）。
    const idleComplete = (
      opts?: { startedAt?: number; resultSubtype?: string; resultErrors?: string[] },
    ): void => {
      callbacks.onComplete({ ...opts, backgroundTasksPending: true })
    }
    const failRun = (
      error: string,
      opts?: { stoppedByUser?: boolean; startedAt?: number; resultSubtype?: string; resultErrors?: string[] },
    ): void => {
      releaseActiveRun()
      callbacks.onError(error)
      callbacks.onComplete(opts)
    }

    const runAuditWriter = new AuditWriter({ auditDir: join(getConfigDir(), 'audit') })
    const onPiAuditTimingEvent: PiRunAuditTimingCallback = async (event) => {
      await runAuditWriter.record({
        category: 'pi_run_timing',
        action: event.phase,
        timestamp: event.timestamp,
        data: { ...event },
      })
    }
    const startupTiming = createAgentStartupTimingRecorder({
      sessionId,
      ...(workspaceId && { workspaceId }),
      runStartedAt: streamStartedAt,
      onTimingEvent: async (event) => {
        await runAuditWriter.record({
          category: 'agent_startup_timing',
          action: event.phase,
          timestamp: event.timestamp,
          data: { ...event },
        })
      },
    })

    // 3. 构建环境变量
    // 同步凭证到 process.env（SDK in-process 代码可能直接读取 process.env）
    // 3. 构建 Pi 工具执行环境（Shell + proxy），模型凭据通过 query options 传入。
    const proxyUrl = await getEffectiveProxyUrl()
    const runtimeStatus = getRuntimeStatus()
    const runtimeEnv = this.buildPiRuntimeEnv(proxyUrl, runtimeStatus)
    const sdkEnv = runtimeEnv.env

    // 4. 读取已有的 SDK session ID（用于 resume）
    let existingSdkSessionId = sessionMeta?.sdkSessionId

    console.log(`[Agent 编排] Resume 状态: sdkSessionId=${existingSdkSessionId || '无'}, domi sessionId=${sessionId}`)

    // 5. 状态初始化
    const accumulatedMessages: SDKMessage[] = []
    // 委派子会话必须继承当前实际运行的模型；未显式传入时与 runtime 的默认值保持一致。
    const selectedModelId = modelId || channel.models.find((item) => item.enabled)?.id
    if (!selectedModelId) {
      failRun('当前渠道没有已启用模型', { startedAt: streamStartedAt })
      return
    }
    const selectedChannelModel = channel.models.find((item) => item.id === selectedModelId)
    let resolvedModel = selectedModelId
    let titleGenerationStarted = false
    /** 捕获到的 SDK session ID（用于 resume / recovery） */
    let capturedSdkSessionId = existingSdkSessionId
    let agentCwd: string | undefined
    let promptCwd: string | undefined
    let executionWorkspaceRoot = homedir()
    let localBaselineRoot = homedir()
    let sessionTargetPrompt: {
      kind: 'local' | 'isolated'
      ownership: 'owner' | 'inherited'
      followupOnly?: boolean
      followupReason?: 'delivered' | 'discarded' | 'retained' | 'preview_active'
      checkpointCount?: number
      deliveryBaseOid?: string
      reviewBaseOid?: string
      reviewBaseStrategy?: ApplyBaseStrategy
      reviewLocalHeadOid?: string
      previousReview?: {
        summary: string
        suggestedCommitMessage: string
        changedFiles?: string[]
      }
    } | undefined
    let sessionTargetRevision: number | undefined
    let contextCompactorHostSnapshot: PiContextCompactorHostSnapshot | undefined
    let gitPushTrustTarget: { checkoutId: string; sourceRef: string } | undefined
    let deliveredFollowupOnly = false
    let agentInitializationStartedAt: number | undefined
    let worktreeDependencyPreparationPrompt = ''
    let worktreeDependencySnapshotContext: {
      projectRoot: string
      localRoot: string
      runtime: AgentWorktreeDependencySnapshotRuntime
    } | undefined
    let pendingWorktreeHandoff: ReadyWorktreeHandoffRequest | undefined
    let workspaceSlug: string | undefined
    let workspace: import('@domi/shared').AgentWorkspace | undefined

    try {
      console.log(`[Agent 编排] 启动 Pi runtime — 模型: ${selectedModelId}, resume: ${existingSdkSessionId ?? '无'}`)

      // 确定 Agent 工作目录
      agentCwd = homedir()
      promptCwd = agentCwd
      workspaceSlug = undefined
      workspace = undefined
      if (workspaceId) {
        const ws = getAgentWorkspace(workspaceId)
        if (!ws) {
          throw new Error(`指定的 Agent 项目不存在或已删除: ${workspaceId}`)
        }
        workspaceSlug = ws.slug
        workspace = ws
        sdkEnv.DOMI_WORKSPACE_DIR = getAgentWorkspacePath(ws.slug)
        sdkEnv.DOMI_WORKSPACE_SLUG = ws.slug
        sdkEnv.DOMI_NOWLEDGE_MEM_ENABLED = getWorkspaceMcpConfig(ws.slug).servers['nowledge-mem']?.enabled ? '1' : '0'


        if (existingSdkSessionId) {
          console.log(`[Agent 编排] 将尝试 resume: ${existingSdkSessionId}`)
        } else {
          console.log(`[Agent 编排] 无 sdkSessionId，将作为新会话启动（回填历史上下文）`)
        }
      }

      const sessionTargetStartedAt = Date.now()
      try {
        const runTarget = prevalidatedWorktreeContinuationTarget ?? await resolveProductionAgentSessionTarget({
          sessionId,
          workspace,
          agentCwdMode: sessionMeta?.agentCwdMode,
        })
        agentCwd = runTarget.cwd
        promptCwd = runTarget.promptCwd
        executionWorkspaceRoot = runTarget.workspaceRoot
        localBaselineRoot = runTarget.localBaselineRoot
        deliveredFollowupOnly = runTarget.followupOnly
        sessionTargetPrompt = {
          kind: runTarget.lease.kind,
          ownership: runTarget.lease.ownerSessionId === sessionId ? 'owner' : 'inherited',
          ...(runTarget.followupOnly ? { followupOnly: true } : {}),
          ...(runTarget.followupReason ? { followupReason: runTarget.followupReason } : {}),
          ...(runTarget.lease.checkpointCount ? { checkpointCount: runTarget.lease.checkpointCount } : {}),
          ...(runTarget.lease.deliveryBaseOid ? { deliveryBaseOid: runTarget.lease.deliveryBaseOid } : {}),
          ...(runTarget.lease.reviewBaseOid ? { reviewBaseOid: runTarget.lease.reviewBaseOid } : {}),
          ...(runTarget.lease.reviewBaseStrategy ? { reviewBaseStrategy: runTarget.lease.reviewBaseStrategy } : {}),
          ...(runTarget.lease.reviewLocalHeadOid ? { reviewLocalHeadOid: runTarget.lease.reviewLocalHeadOid } : {}),
          ...(runTarget.lease.previousReview ? {
            previousReview: {
              summary: runTarget.lease.previousReview.summary,
              suggestedCommitMessage: runTarget.lease.previousReview.suggestedCommitMessage,
              changedFiles: [...runTarget.lease.previousReview.changedFiles],
            },
          } : {}),
        }
        sessionTargetRevision = runTarget.lease.revision
        if (appSettings.agentContextCompactorMode === 'observe' || appSettings.agentContextCompactorMode === 'enhance') {
          contextCompactorHostSnapshot = {
            sessionTarget: {
              kind: runTarget.lease.kind,
              ownership: runTarget.lease.ownerSessionId === sessionId ? 'owner' : 'inherited',
              ...(runTarget.lease.kind === 'isolated' ? { checkoutId: runTarget.lease.checkoutId } : {}),
              revision: runTarget.lease.revision,
              ...(runTarget.lease.checkpointCount ? { checkpointCount: runTarget.lease.checkpointCount } : {}),
              ...(runTarget.lease.deliveryBaseOid ? { deliveryBaseOid: runTarget.lease.deliveryBaseOid } : {}),
              ...(runTarget.lease.previousReview ? {
                previousReview: {
                  reviewId: runTarget.lease.previousReview.reviewId,
                  iteration: runTarget.lease.previousReview.iteration,
                  summary: runTarget.lease.previousReview.summary,
                  suggestedCommitMessage: runTarget.lease.previousReview.suggestedCommitMessage,
                  changedFiles: [...runTarget.lease.previousReview.changedFiles],
                },
              } : {}),
            },
          }
          try {
            const { getSessionCheckoutModule } = await import('./session-checkout/production.ts')
            const target = await getSessionCheckoutModule().inspect(sessionId)
            const delivery = target.delivery
            const review = delivery && 'review' in delivery ? delivery.review : undefined
            contextCompactorHostSnapshot = {
              ...contextCompactorHostSnapshot,
              ...(delivery ? {
                delivery: {
                  state: delivery.state,
                  ...(review ? {
                    review: {
                      reviewId: review.reviewId,
                      iteration: review.iteration,
                      summary: review.summary,
                      suggestedCommitMessage: review.suggestedCommitMessage,
                      changedFiles: [...review.changedFiles],
                      validationStatus: review.validationStatus,
                      ...(review.validationSummary ? { validationSummary: review.validationSummary } : {}),
                      tests: review.tests.map(test => ({ ...test })),
                    },
                  } : {}),
                },
              } : {}),
            }
          } catch (error) {
            console.warn('[ContextCompactor] host delivery snapshot unavailable; using lease-only evidence:', error)
          }
        }
        gitPushTrustTarget = {
          checkoutId: runTarget.lease.checkoutId,
          sourceRef: runTarget.lease.sourceRef,
        }
        await gitPushSessionTrustService.reconcile({
          sessionId,
          checkoutId: runTarget.lease.checkoutId,
          repositoryRoot: runTarget.workspaceRoot,
          sourceRef: runTarget.lease.sourceRef,
        })
        startupTiming.recordSessionTarget(sessionTargetStartedAt, {
          outcome: 'success',
          targetKind: sessionTargetPrompt.kind,
          ownership: sessionTargetPrompt.ownership,
        })
      } catch (error) {
        startupTiming.recordSessionTarget(sessionTargetStartedAt, { outcome: 'error' })
        if (error instanceof SessionCheckoutError) {
          const unselected = error.code === 'target_unselected' || error.code === 'parent_target_unselected'
          reportPreflightError({
            code: unselected ? 'session_target_unselected' : 'session_target_recovery_required',
            title: unselected ? '请选择 Session Target' : 'Session Target 暂不可用',
            message: error.message,
            actions: [],
            canRetry: false,
          })
          return
        }
        throw error
      }
      console.log(`[Agent 编排] 使用 checkout lease cwd: ${agentCwd} (${workspace?.name ?? '无项目'}/${sessionId})`)
      if (
        persistedUserMessageUuid
        && sessionTargetPrompt?.kind === 'isolated'
        && sessionTargetPrompt.ownership === 'owner'
        && !deliveredFollowupOnly
      ) {
        try {
          getAgentFileCheckpointStore().beginCheckpoint({
            sessionId,
            userMessageUuid: persistedUserMessageUuid,
            targetRoot: agentCwd,
          })
          this.activeFileCheckpointContexts.set(sessionId, {
            generation: runGeneration,
            targetRoot: agentCwd,
            userMessageUuid: persistedUserMessageUuid,
          })
        } catch (error) {
          console.warn('[file-checkpoint] begin checkpoint failed; controlled file tools remain usable:', error)
        }
      }
      agentInitializationStartedAt = Date.now()

      // 9.4.1 Fork session JSONL 迁移已在 forkAgentSession 中完成；fork 的 cwd 语义
      // 从源会话继承并持久化，避免历史相对路径在恢复时切换到另一文件根。



      // 9.6 直接信任已保存的 sdkSessionId，跳过 listSessions 预验证
      // 原因：listSessions({ dir }) 基于 cwd 路径哈希查找，但 session 级别的 cwd
      // （如 ~/.domi/agent-workspaces/workspace-xxx/sessionId）与 SDK 内部存储的路径哈希可能不匹配，
      // 导致 listSessions 始终返回 0 个会话，误杀有效的 resume。
      // SDK 本身会优雅处理无效的 resume ID（回退为新会话），无需预验证。
      if (existingSdkSessionId) {
        console.log(`[Agent 编排] 将直接使用已保存的 sdkSessionId 进行 resume: ${existingSdkSessionId}`)
      }

      // 10. 构建 Pi 内置工具、用户 MCP 和本轮动态 custom tools。
      const mcpServers = this.buildMcpServers(workspaceSlug, true)
      const chromeDevtoolsMcpName = getBuiltinMcpName('chrome-devtools')
      const chromeDevtoolsMentioned = mentionedMcpServers?.some((name) => (
        name === 'chrome-devtools' || name === chromeDevtoolsMcpName
      )) ?? false
      const chromeDevtoolsRequestedForRun = shouldInjectChromeDevtoolsMcp(
        isBuiltinMcpUserEnabled('chrome-devtools'),
        userMessage,
        chromeDevtoolsMentioned,
      )
      if (chromeDevtoolsRequestedForRun) {
        console.log('[Agent 编排] 正在启动浏览器调试工具 (chrome-devtools)')
        injectChromeDevtoolsMcpServer(mcpServers)
      }

      const visionAccessScope = buildVisionRelayAccessScope({
        targetRoot: workspace ? agentCwd : undefined,
        sessionWorkbenchRoot: workspaceSlug ? getAgentSessionWorkspacePath(workspaceSlug, sessionId) : undefined,
        // Vision Relay only trusts directories signed by the main-process picker.
        // Exact file uploads are copied into the session workbench, already covered above.
        attachedDirectories: sessionMeta?.visionRelayAttachedDirectories ?? [],
      })
      const piSdk = await import('@earendil-works/pi-coding-agent')
      const triggeredBy = sessionMeta?.sourceDelegationId || (sessionMeta?.delegationDepth ?? 0) > 0
        ? 'delegation' as const
        : input.triggeredBy === 'bridge' || input.triggeredBy === 'channel'
          ? 'automation' as const
          : input.triggeredBy
      const builtinToolResult = await buildPiBuiltinTools(piSdk, {
        sessionId,
        channelId,
        modelId: selectedModelId,
        provider: channel.provider,
        channelModel: selectedChannelModel,
        workspaceId,
        workspaceSlug,
        agentCwd,
        localRoot: localBaselineRoot,
        visionAccessScope,
        permissionMode: permissionModeOverride ?? sessionMeta?.permissionMode ?? DOMI_DEFAULT_PERMISSION_MODE,
        workflow: 'read-only',
        // Tool execution starts only after the run workflow is initialized below; fail closed before that point.
        getWorkflow: () => deliveredFollowupOnly
          ? 'read-only'
          : this.sessionWorkflows.get(sessionId) ?? 'read-only',
        triggeredBy,
        ...(sessionTargetPrompt && { sessionTarget: sessionTargetPrompt }),
      })
      const piBuiltinTools: unknown[] = [...builtinToolResult.tools, ...(customTools ?? [])]
      const piToolAnnotations: AgentToolAnnotationsMap = { ...builtinToolResult.toolAnnotations }
      const collaborationAvailable = builtinToolResult.collaborationAvailable

      let piMcpTools: unknown[] = []
      if (Object.keys(mcpServers).length > 0) {
        try {
          const reservedProductToolNames = new Set<string>()
          for (const tool of piBuiltinTools) {
            if (tool && typeof tool === 'object' && 'name' in tool && typeof tool.name === 'string') {
              reservedProductToolNames.add(tool.name)
            }
          }
          const result = await buildPiMcpTools(mcpServers, reservedProductToolNames)
          piMcpTools = result.tools
          Object.assign(piToolAnnotations, result.toolAnnotations)
        } catch (error) {
          console.warn('[Agent 编排] Pi MCP 工具桥接失败，已跳过用户 MCP:', error)
        }
      }
      const availableImageToolNames = collectAvailableAgentImageToolNames([...piBuiltinTools, ...piMcpTools])
      this.activeImageToolNames.set(sessionId, availableImageToolNames)

      if (chromeDevtoolsRequestedForRun) {
        const chromeDevtoolsToolsAvailable = piMcpTools.some((tool) => (
          !!tool
          && typeof tool === 'object'
          && 'name' in tool
          && typeof tool.name === 'string'
          && tool.name.startsWith('mcp__chrome_devtools__')
        ))
        if (chromeDevtoolsToolsAvailable) this.activeChromeDevtoolsSessions.add(sessionId)
      }

      // 11. 构建动态上下文和最终 prompt
      const dynamicCtx = buildDynamicContext({
        workspaceName: workspace?.name,
        workspaceSlug,
        agentCwd: promptCwd,
      })

      // `/plan` 是宿主识别的当前 run 控制命令。transcript 保留原始输入，模型 prompt
      // 只移除命令标记；Renderer 不能仅靠 workflowOverride 伪造 Plan First。
      const planCommand = parseAgentPlanCommand(userMessage)

      // 11.5 注入 mention 引用指令（Skill/MCP/会话）— 仅影响 prompt，不影响持久化
      let enrichedMessage = planCommand.matched ? planCommand.promptMessage : userMessage
      const referencedSessionsBlock = buildReferencedSessionsPrompt(sessionId, mentionedSessionIds, workspaceSlug)
      if (referencedSessionsBlock) {
        enrichedMessage = `${referencedSessionsBlock}\n\n${enrichedMessage}`
        console.log(`[Agent 编排] 注入 referenced_sessions: ${mentionedSessionIds?.length ?? 0} sessions`)
      }
      if (mentionedSkills?.length || mentionedMcpServers?.length) {
        const toolLines: string[] = ['用户在消息中明确引用了以下工具，请在本次回复中主动调用：']
        for (const slug of mentionedSkills ?? []) {
          const qualifiedName = workspaceSlug
            ? `domi-workspace-${workspaceSlug}:${slug}`
            : slug
          toolLines.push(`- Skill: ${qualifiedName}（请立即调用此 Skill）`)
        }
        for (const name of mentionedMcpServers ?? []) {
          toolLines.push(`- MCP 服务器: ${name}（请使用此 MCP 服务器的工具来完成任务）`)
        }
        enrichedMessage = `<mentioned_tools>\n${toolLines.join('\n')}\n</mentioned_tools>\n\n${enrichedMessage}`
        console.log(`[Agent 编排] 注入 mentioned_tools: ${mentionedSkills?.length ?? 0} skills, ${mentionedMcpServers?.length ?? 0} MCP`)
      }
      const referencedPlanningBlock = buildReferencedPlanningPrompt(
        mentionedTodoIds,
        mentionedCalendarEventIds,
        { requireToolRead: true },
      )
      if (referencedPlanningBlock) {
        enrichedMessage = `${referencedPlanningBlock}\n\n${enrichedMessage}`
        console.log(`[Agent 编排] 注入 referenced_planning: ${mentionedTodoIds?.length ?? 0} todos, ${mentionedCalendarEventIds?.length ?? 0} calendar events`)
      }

      const imageCommand = parseAgentImageCommand(userMessage)
      if (imageCommand.matched) {
        enrichedMessage = buildAgentImageCommandPrompt({
          command: imageCommand,
          enrichedMessage,
          availableToolNames: availableImageToolNames,
        })
        console.log(`[Agent 编排] 识别生图快捷命令: /${imageCommand.command}, 可用工具 ${availableImageToolNames.length} 个`)
      }

      const contextualMessage = `${dynamicCtx}\n\n${enrichedMessage}`

      const compactCommand = parseAgentCompactCommand(userMessage)
      const isCompactCommand = compactCommand.matched
      const finalPrompt = isCompactCommand
        ? '/compact'
        : existingSdkSessionId
          ? contextualMessage
          : buildContextPrompt(sessionId, contextualMessage, { agentCwd: promptCwd, workspaceSlug })

      if (existingSdkSessionId) {
        console.log(`[Agent 编排] 使用 resume 模式，SDK session ID: ${existingSdkSessionId}`)
      } else if (finalPrompt !== contextualMessage) {
        console.log(`[Agent 编排] 无 resume，已回填历史上下文（最近 ${MAX_CONTEXT_MESSAGES} 条消息）`)
      }

      // 12. 解析 Pi Execution Policy 与 Workflow。
      if (executionPolicyOverride !== undefined && !isExecutionPolicyMode(executionPolicyOverride)) {
        throw new Error(`无效的 Execution Policy override: ${String(executionPolicyOverride)}`)
      }
      if (workflowOverride !== undefined && !isAgentWorkflow(workflowOverride)) {
        throw new Error(`无效的 Workflow override: ${String(workflowOverride)}`)
      }
      const persistedControls = normalizeAgentExecutionSettings({
        executionPolicy: sessionMeta?.executionPolicy,
        workflow: sessionMeta?.workflow,
        piToolProfile: sessionMeta?.piToolProfile,
        permissionMode: sessionMeta?.permissionMode,
      })
      const legacyWorkflow: AgentWorkflow | undefined = permissionModeOverride === 'plan'
        ? 'read-only'
        : permissionModeOverride === 'bypassPermissions' ? 'direct' : undefined
      // Execution Policy values remain accepted as compatibility input, but Execute always
      // means Full Access. Plan First is a run-local lifecycle and cannot be restored as a
      // third persistent user mode from renderer overrides or legacy metadata.
      const initialExecutionPolicy: ExecutionPolicyMode = 'full-access'
      const requestedWorkflow = workflowOverride
        ?? legacyWorkflow
        ?? persistedControls.workflow
      const planCommandWorkflow = resolveAgentPlanCommandWorkflow(requestedWorkflow, planCommand.matched)
      let initialWorkflow: AgentWorkflow = planCommandWorkflow.runWorkflow
      this.sessionExecutionPolicies.set(sessionId, initialExecutionPolicy)
      this.sessionWorkflows.set(sessionId, initialWorkflow)
      const continuationWorkflow = resolveWorktreeContinuationRunWorkflow(initialWorkflow, trustedWorktreeContinuation)
      if (continuationWorkflow.grantTemporaryExecution) {
        if (trustedWorktreeContinuation?.runGeneration !== runGeneration) {
          throw new Error('Worktree 续跑授权对应的 run 已变化')
        }
        if (!this.grantTemporaryExecution(sessionId, runGeneration)) {
          throw new Error('Worktree 续跑授权对应的 run 已结束')
        }
        initialWorkflow = continuationWorkflow.workflow
      }

      const dependencyRuntime = resolveAgentWorktreeDependencySnapshotRuntime({
        platform: process.platform,
        arch: process.arch,
        targetKind: sessionTargetPrompt.kind,
        ownership: sessionTargetPrompt.ownership,
        workflow: initialWorkflow,
        followupOnly: deliveredFollowupOnly,
        shellKind: runtimeEnv.shellKind,
        bun: runtimeStatus?.bun ?? { available: false, version: null },
        environment: mergeRuntimeEnv(process.env, runtimeEnv.env),
      })
      if (dependencyRuntime) {
        const controller = new AbortController()
        this.dependencyPreparationControllers.set(sessionId, { generation: runGeneration, controller })
        const preparation = await getWorktreeDependencySnapshotService().prepare({
          projectRoot: agentCwd,
          localRoot: localBaselineRoot,
          runtime: dependencyRuntime,
          signal: controller.signal,
        })
        const currentPreparation = this.dependencyPreparationControllers.get(sessionId)
        if (currentPreparation?.generation === runGeneration) {
          this.dependencyPreparationControllers.delete(sessionId)
        }
        startupTiming.recordDependencySnapshot({
          status: preparation.status,
          durationMs: preparation.durationMs,
          overlapMs: 0,
          waitDurationMs: preparation.durationMs,
        })
        if (this.activeSessions.get(sessionId) !== runGeneration) {
          completeRun({ stoppedByUser: this.consumeStoppedByUser(sessionId, runGeneration), startedAt: streamStartedAt })
          return
        }
        if (preparation.status === 'ready') {
          worktreeDependencyPreparationPrompt = buildWorktreeDependencyPreparationPrompt(preparation)
        } else if (preparation.status === 'miss') {
          worktreeDependencyPreparationPrompt = buildWorktreeDependencyPreparationPrompt(preparation)
        } else if (preparation.status === 'unavailable') {
          worktreeDependencyPreparationPrompt = buildWorktreeDependencyPreparationPrompt(preparation)
        }
        if (preparation.status !== 'skipped' && preparation.status !== 'cancelled') {
          worktreeDependencySnapshotContext = {
            projectRoot: agentCwd,
            localRoot: localBaselineRoot,
            runtime: dependencyRuntime,
          }
        }
        console.log(`[dependency-snapshot] prepare status=${preparation.status} durationMs=${Math.round(preparation.durationMs)}`)
      } else {
        startupTiming.recordDependencySnapshot({
          status: 'skipped',
          durationMs: 0,
          overlapMs: 0,
          waitDurationMs: 0,
        })
      }

      const promptPermissionMode: DomiPermissionMode = 'bypassPermissions'
      this.sessionPermissionModes.set(sessionId, promptPermissionMode)
      const getPermissionMode = (): DomiPermissionMode => (
        (this.sessionWorkflows.get(sessionId) ?? initialWorkflow) === 'plan-first'
          ? 'plan'
          : 'bypassPermissions'
      )
      console.log(`[Agent 编排] Pi controls: policy=${initialExecutionPolicy}, workflow=${initialWorkflow}`)

      const emitPlanModeChanged = (
        active: boolean,
        source: 'initial' | 'tool' | 'permission',
        workflow?: AgentWorkflow,
      ): void => {
        this.eventBus.emit(sessionId, {
          kind: 'domi_event',
          event: { type: 'plan_mode_changed', sessionId, active, source, ...(workflow && { workflow }) },
        })
      }

      let planModeEntered = initialWorkflow === 'plan-first'
      // 每个新 run 都发布权威初始态：/plan 进入临时 Plan；普通替换 run 则立即清除
      // 上一 run 的临时 Plan 展示，且不携带持久 workflow 变更。
      emitPlanModeChanged(planModeEntered, 'initial')

      const authorizePiExecution = await (async () => {
            return createPiExecutionController({
              sessionId,
              ...(workspaceId && { workspaceId }),
              workspaceRoot: executionWorkspaceRoot,
              localBaselineRoot,
              ...(sessionTargetPrompt && { sessionTarget: sessionTargetPrompt }),
              ...(workspaceSlug && {
                sessionWorkbenchRoot: getAgentSessionWorkspacePath(workspaceSlug, sessionId),
              }),
              planSidecarDir: getAgentPlanSidecarDir(sessionId, workspaceSlug),
              interaction: input.triggeredBy && input.triggeredBy !== 'user' ? 'unattended' : 'interactive',
              getExecutionPolicy: () => this.sessionExecutionPolicies.get(sessionId) ?? initialExecutionPolicy,
              getWorkflow: () => deliveredFollowupOnly
                ? 'read-only'
                : this.sessionWorkflows.get(sessionId) ?? initialWorkflow,
              isRunActive: () => this.activeSessions.get(sessionId) === runGeneration,
              hasGitPushSessionTrust: async () => {
                if (!gitPushTrustTarget) return false
                return gitPushSessionTrustService.reconcile({
                  sessionId,
                  checkoutId: gitPushTrustTarget.checkoutId,
                  repositoryRoot: executionWorkspaceRoot,
                  sourceRef: gitPushTrustTarget.sourceRef,
                })
              },
              requestGitPushSessionTrust: async (toolInput, toolOptions) => {
                if (!gitPushTrustTarget) {
                  return { behavior: 'deny', message: '当前 Session Target 缺少普通 push 授权上下文。' }
                }
                try {
                  const proposal = await gitPushSessionTrustService.prepare({
                    sessionId,
                    checkoutId: gitPushTrustTarget.checkoutId,
                    repositoryRoot: executionWorkspaceRoot,
                    sourceRef: gitPushTrustTarget.sourceRef,
                  })
                  return permissionService.requestGitPushSessionTrustApproval(
                    sessionId,
                    proposal,
                    toolInput,
                    toolOptions,
                    (request) => {
                      this.eventBus.emit(sessionId, { kind: 'domi_event', event: { type: 'permission_request', request } })
                      queueMicrotask(() => callbacks.onWorkActivityChanged?.())
                    },
                  )
                } catch (error) {
                  return {
                    behavior: 'deny',
                    message: error instanceof Error ? error.message : String(error),
                  }
                }
              },
              requestProductToolApproval: async (toolName, toolInput, toolOptions) => permissionService.requestSingleApproval(
                sessionId,
                toolName,
                toolInput,
                toolOptions,
                (request) => {
                  this.eventBus.emit(sessionId, { kind: 'domi_event', event: { type: 'permission_request', request } })
                  queueMicrotask(() => callbacks.onWorkActivityChanged?.())
                },
              ),
              requestApproval: async (request, context) => {
                const call = context.call
                const result = await permissionService.requestSingleApproval(
                  sessionId,
                  call.toolName,
                  call.input,
                  {
                    signal: context.signal ?? new AbortController().signal,
                    toolUseID: call.toolCallId ?? randomUUID(),
                    displayName: call.displayName,
                    policy: {
                      category: request.category,
                      reason: request.reason,
                      scope: request.scope,
                      executionPolicy: this.sessionExecutionPolicies.get(sessionId) ?? initialExecutionPolicy,
                      workflow: deliveredFollowupOnly
                        ? 'read-only'
                        : this.sessionWorkflows.get(sessionId) ?? initialWorkflow,
                      decisionCode: request.decisionCode ?? request.category,
                    },
                  },
                  (request) => {
                    this.eventBus.emit(sessionId, { kind: 'domi_event', event: { type: 'permission_request', request } })
                    queueMicrotask(() => callbacks.onWorkActivityChanged?.())
                  },
                )
                return result.behavior === 'allow' ? 'approved' : 'denied'
              },
              audit: async (event) => {
                await runAuditWriter.record({
                  category: 'execution_policy',
                  action: event.action,
                  data: {
                    sessionId: event.sessionId,
                    ...(event.workspaceId && { workspaceId: event.workspaceId }),
                    toolName: event.toolName,
                    category: event.category,
                    outcome: event.outcome,
                    ...(event.approval && { approval: event.approval }),
                    executionPolicy: event.executionPolicy,
                    workflow: deliveredFollowupOnly
                      ? 'read-only'
                      : this.sessionWorkflows.get(sessionId) ?? initialWorkflow,
                    ...(sessionTargetPrompt && {
                      targetKind: sessionTargetPrompt.kind,
                      targetOwnership: sessionTargetPrompt.ownership,
                    }),
                    decisionCode: event.decisionCode,
                    ...(event.shellAnalysisStatus && { shellAnalysisStatus: event.shellAnalysisStatus }),
                    ...(event.shellStageCount !== undefined && { shellStageCount: event.shellStageCount }),
                    ...(event.shellReasonCodes && { shellReasonCodes: event.shellReasonCodes }),
                    durationMs: event.durationMs,
                  },
                })
              },
              askUser: (toolInput, signal) => askUserService.handleAskUserQuestion(
                sessionId,
                toolInput,
                signal,
                (request: AskUserRequest) => {
                  this.eventBus.emit(sessionId, { kind: 'domi_event', event: { type: 'ask_user_request', request } })
                  queueMicrotask(() => callbacks.onWorkActivityChanged?.())
                },
                (request, answers) => {
                  const adjustment = extractDirectWorkflowAdjustment(request, answers)
                  if (!adjustment) return

                  const message = createDirectWorkflowAdjustmentUserMessage(adjustment)
                  accumulatedMessages.push(message)
                  // 在解除 AskUser 阻塞前同步持久化当前 Direct 请求与用户调整，
                  // 确保重载后的顺序仍是“旧方案 → 用户调整 → Agent 新方案”。
                  this.persistSDKMessages(sessionId, accumulatedMessages)
                  accumulatedMessages.length = 0
                  this.eventBus.emit(sessionId, { kind: 'sdk_message', message })
                },
              ),
              exitPlan: (toolInput, signal) => exitPlanService.handleExitPlanMode(
                sessionId,
                toolInput,
                {
                  executionPolicy: this.sessionExecutionPolicies.get(sessionId) ?? initialExecutionPolicy,
                  planSidecarDir: getAgentPlanSidecarDir(sessionId, workspaceSlug),
                  runToken: runGeneration,
                  isRunActive: () => this.activeSessions.get(sessionId) === runGeneration,
                },
                signal,
                (request: ExitPlanModeRequest) => {
                  this.eventBus.emit(sessionId, { kind: 'domi_event', event: { type: 'exit_plan_mode_request', request } })
                  queueMicrotask(() => callbacks.onWorkActivityChanged?.())
                },
              ),
              onWorkflowChanged: (workflow, source) => {
                // 所有批准和 Plan 生命周期变更都必须仍属于创建 controller 的精确 run。
                // 旧审批即使在 AbortSignal 清理前迟到，也不能修改新 run 或持久 session meta。
                if (this.activeSessions.get(sessionId) !== runGeneration) return false

                const persistent = source === 'approve-plan-persistent'
                  || source === 'approve-read-only-persistent'
                const temporaryExecution = source === 'approve-plan-once'
                  || source === 'approve-read-only-once'

                if (source === 'enter-plan') {
                  this.sessionWorkflows.set(sessionId, workflow)
                } else if (persistent) {
                  this.revokeTemporaryExecution(sessionId, runGeneration)
                  this.sessionWorkflows.set(sessionId, 'direct')
                  this.sessionExecutionPolicies.set(sessionId, 'full-access')
                  this.sessionPermissionModes.set(sessionId, 'bypassPermissions')
                  updateAgentSessionMeta(sessionId, { workflow: 'direct', executionPolicy: 'full-access' })
                } else if (temporaryExecution) {
                  if (!this.grantTemporaryExecution(sessionId, runGeneration)) return false
                }

                planModeEntered = workflow === 'plan-first'
                // 只有明确的持久切换才把 workflow 发给 renderer 会话镜像；run-local
                // Plan/Direct 只更新活动态，避免下一轮 override 继承临时执行。
                emitPlanModeChanged(
                  planModeEntered,
                  source === 'enter-plan' ? 'tool' : 'permission',
                  persistent ? 'direct' : undefined,
                )
                if (source === 'enter-plan') {
                  this.eventBus.emit(sessionId, { kind: 'domi_event', event: { type: 'enter_plan_mode', sessionId } })
                }
                return true
              },
            })
          })()

      // 13. 构建 Adapter 查询选项
      const maxTurns = appSettings.agentMaxTurns && appSettings.agentMaxTurns > 0
        ? appSettings.agentMaxTurns
        : undefined
      const piReasoningCapability = await resolvePiReasoningCapability(channel.provider, selectedModelId, selectedChannelModel)
      const piThinkingLevel = resolvePiThinkingLevel(
        appSettings, sessionMeta, channel.provider, selectedModelId, piReasoningCapability,
      )
      const allAdditionalDirectories = collectAttachedDirectories({
        extraDirs: additionalDirectories,
        sessionMeta,
        workspaceSlug,
      })
      const worktreeHandoffAvailable = canOfferAgentWorktreeHandoff({
        targetKind: sessionTargetPrompt?.kind,
        triggeredBy: input.triggeredBy,
        sourceDelegationId: sessionMeta?.sourceDelegationId,
      })
      const worktreeApplyAvailable = !deliveredFollowupOnly && canOfferAgentWorktreeApply({
        targetKind: sessionTargetPrompt?.kind,
        ownership: sessionTargetPrompt?.ownership,
        triggeredBy: input.triggeredBy,
        sourceDelegationId: sessionMeta?.sourceDelegationId,
      })
      const trustedInstructions = workspaceSlug
        ? {
            workspace: resolveTrustedWorkspaceInstruction(
              getWorkspaceAgentsMdPath(workspaceSlug),
              getLegacyWorkspaceClaudeMdPath(workspaceSlug),
            ),
            project: resolveTrustedProjectInstruction(executionWorkspaceRoot),
          }
        : undefined
      if (trustedInstructions?.workspace.diagnostics.length) {
        console.warn(`[Agent 编排] 工作区 AGENTS.md 未注入: ${trustedInstructions.workspace.diagnostics.join('; ')}`)
      }
      const standardSystemPromptAppend = buildSystemPrompt({
        workspaceName: workspace?.name,
        workspaceSlug,
        sessionId,
        agentCwd: promptCwd,
        permissionMode: promptPermissionMode,
        executionPolicy: initialExecutionPolicy,
        workflow: initialWorkflow,
        interaction: input.triggeredBy && input.triggeredBy !== 'user' ? 'unattended' : 'interactive',
        collaborationAvailable,
        workSystemPrompt: getEffectiveWorkSystemPrompt(),
        currentModelId: selectedModelId,
        worktreeHandoffAvailable,
        worktreeApplyAvailable,
        ...(trustedInstructions && {
          trustedInstructions: {
            ...(trustedInstructions.workspace.source && { workspace: trustedInstructions.workspace.source }),
            project: trustedInstructions.project,
          },
        }),
        ...(sessionTargetPrompt && { sessionTarget: sessionTargetPrompt }),
      })
        + (worktreeDependencyPreparationPrompt ? `\n\n${worktreeDependencyPreparationPrompt}` : '')
        + (automationContext ? `\n\n## 定时任务执行上下文\n\n${automationContext}` : '')
      // Minimal 呈现预设用固定提示词替换全部 Domi 行为规则；附加目录仍作为环境事实追加。
      const modelPresentationPreset = sessionMeta?.modelPresentationPreset ?? 'standard'
      const systemPromptAppend = resolveModelPresentationSystemPrompt(
        modelPresentationPreset,
        standardSystemPromptAppend,
      )
      const startAutoTitleGeneration = (): void => {
        if (titleGenerationStarted) return
        titleGenerationStarted = true

        // 标题请求与前台 Agent run 使用独立的 Codex Responses 请求，可并发执行。
        // 自动标题只会写入仍为默认名称的会话，因此不会覆盖用户的手动重命名。
        this.autoGenerateTitle(sessionId, userMessage, channelId, resolvedModel, callbacks)
          .catch((err) => console.error('[Agent 编排] 标题生成未捕获异常:', err))
      }
      const handleSessionId = (sdkSessionId: string, piSessionFile?: string): void => {
        // 仅在 session_id 真正变化时才持久化。SDK v2 几乎每条消息都会回调 onSessionId，
        // capturedSdkSessionId 已初始化为 existingSdkSessionId，并在 recovery 时同步重置。
        const isNewSessionId = sdkSessionId !== capturedSdkSessionId
        const needsPiSessionFile = !!piSessionFile && sessionMeta?.piSessionFile !== piSessionFile
        capturedSdkSessionId = sdkSessionId
        if (isNewSessionId || needsPiSessionFile) {
          try {
            updateAgentSessionMeta(sessionId, {
              sdkSessionId,
              ...(piSessionFile ? { piSessionFile } : {}),
            })
            console.log(`[Agent 编排] 已保存 Pi session_id: ${sdkSessionId}`)
          } catch (err) {
            console.error(`[Agent 编排] 保存 SDK session_id 失败:`, err)
          }
        }

        startAutoTitleGeneration()
      }
      const handleModelResolved = (model: string): void => {
        // `[1m]` 是 SDK 内部上下文变体，不应泄漏到标题生成或用户可见的模型名。
        resolvedModel = model.replace(/\[1m\]$/i, '')
        console.log(`[Agent 编排] SDK 确认模型: ${resolvedModel}`)
        this.eventBus.emit(sessionId, { kind: 'domi_event', event: { type: 'model_resolved', model: resolvedModel } })
      }
      let resolvedContextWindow: number | undefined
      let resolvedContextWindowSource: ContextWindowSource | undefined
      let latestContextBreakdown: AgentContextBreakdown | undefined
      const handleContextWindow = (
        contextWindow: number,
        source: ContextWindowSource = 'runtime',
      ): void => {
        resolvedContextWindow = contextWindow
        resolvedContextWindowSource = source
        console.log(`[Agent 编排] 缓存 contextWindow: ${contextWindow}（${source}）`)
        // SDK / Pi runtime 构建结果优先于按模型名的 fallback；允许更权威的新值向下修正。
        this.eventBus.emit(sessionId, {
          kind: 'domi_event',
          event: { type: 'context_window', contextWindow, source },
        })
      }
      const attachExecutionContext = <T extends SDKMessage>(message: T): T => {
        const persistedMessage = message as Record<string, unknown>
        if (modelId) persistedMessage._channelModelId = modelId
        persistedMessage._channelProvider = channel.provider
        persistedMessage._channelId = channelId
        persistedMessage._agentRuntime = 'pi'
        if (resolvedContextWindow != null) persistedMessage._contextWindow = resolvedContextWindow
        if (resolvedContextWindowSource) persistedMessage._contextWindowSource = resolvedContextWindowSource
        if (latestContextBreakdown) persistedMessage._contextBreakdown = latestContextBreakdown
        return message
      }
      const piCustomTools = [...piBuiltinTools, ...piMcpTools]
      const piCustomToolSources: Record<string, NonNullable<CanUseToolOptions['toolSource']>> = {}
      for (const tool of piBuiltinTools) {
        if (tool && typeof tool === 'object' && 'name' in tool && typeof tool.name === 'string') {
          piCustomToolSources[tool.name] = 'product'
        }
      }
      for (const tool of piMcpTools) {
        if (tool && typeof tool === 'object' && 'name' in tool && typeof tool.name === 'string') {
          piCustomToolSources[tool.name] = tool.name.startsWith('mcp__chrome_devtools__')
            ? 'builtin-mcp'
            : 'mcp'
        }
      }
      const dependencySnapshotCaptureContext = worktreeDependencySnapshotContext
      // Skill 触发观测：每次 run 新建记录器（去重集合按 run 隔离），
      // 命中技能根目录时通过 domi_event 实时上浮到渲染层。
      const skillTriggerRecorder = workspaceSlug
        ? createSkillTriggerRecorder({
          sessionId,
          workspaceSlug,
          skillRoots: buildWorkspaceSkillTriggerRoots(workspaceSlug),
          skillNames: buildWorkspaceSkillNames(workspaceSlug),
          sessionTriggersPath: getAgentSessionSkillTriggersPath(sessionId),
          workspaceUsagePath: getWorkspaceSkillUsagePath(workspaceSlug),
        })
        : undefined
      const queryOptions: PiAgentQueryOptions = {
        sessionId,
        prompt: finalPrompt,
        // Pi runtime 使用渠道配置的真实模型 ID，不支持历史 `[1m]` 后缀变体：
        // 智谱等端点不识别 glm-5.2[1m] 这类后缀，会返回 1211「模型不存在」。
        // 因此 pi 分支直接使用用户配置的原始模型 ID，不追加任何 `[1m]`。
        model: selectedModelId,
        cwd: agentCwd,
        apiKey,
        baseUrl: channel.baseUrl,
        provider: channel.provider,
        channelName: channel.name,
        channelModel: selectedChannelModel,
        finishReasonMode: channel.finishReasonMode ?? 'auto',
        proxyUrl,
        runtimeEnv,
        fileCheckpoint: {
          beforeMutation: (filePath) => {
            const context = this.activeFileCheckpointContexts.get(sessionId)
            if (!context || context.generation !== runGeneration) return false
            getAgentFileCheckpointStore().trackFileBeforeMutation({
              sessionId,
              userMessageUuid: context.userMessageUuid,
              targetRoot: context.targetRoot,
              filePath,
            })
            return true
          },
          afterMutation: (filePath) => {
            const context = this.activeFileCheckpointContexts.get(sessionId)
            if (!context || context.generation !== runGeneration) return
            getAgentFileCheckpointStore().recordFileAfterMutation({
              sessionId,
              targetRoot: context.targetRoot,
              filePath,
            })
          },
          onError: (phase, filePath, error) => {
            const context = this.activeFileCheckpointContexts.get(sessionId)
            if (context?.generation === runGeneration) {
              try {
                getAgentFileCheckpointStore().markCheckpointIncomplete({
                  sessionId,
                  userMessageUuid: context.userMessageUuid,
                  targetRoot: context.targetRoot,
                  filePath,
                })
              } catch (markError) {
                console.warn(`[file-checkpoint] failed to persist incomplete coverage for ${filePath}:`, markError)
              }
            }
            console.warn(`[file-checkpoint] ${phase} mutation tracking failed for ${filePath}:`, error)
          },
        },
        ...(dependencySnapshotCaptureContext && {
          onSuccessfulFrozenBunInstall: async ({ cwd, signal }) => {
            if (resolve(cwd).toLowerCase() !== resolve(dependencySnapshotCaptureContext.projectRoot).toLowerCase()) {
              console.warn('[dependency-snapshot] install cwd changed; snapshot capture skipped')
              return
            }
            const capture = await getWorktreeDependencySnapshotService().capture({
              projectRoot: dependencySnapshotCaptureContext.projectRoot,
              localRoot: dependencySnapshotCaptureContext.localRoot,
              runtime: dependencySnapshotCaptureContext.runtime,
              signal,
            })
            console.log(`[dependency-snapshot] capture status=${capture.status} durationMs=${Math.round(capture.durationMs)}`)
          },
        }),
        ...(maxTurns != null && { maxTurns }),
        permissionMode: promptPermissionMode,
        authorizeToolCall: (toolName, toolInput, options) => authorizePiExecution({
          type: 'tool',
          toolName,
          input: toolInput,
          options,
        }),
        getWorkflow: () => deliveredFollowupOnly
          ? 'read-only'
          : this.sessionWorkflows.get(sessionId) ?? initialWorkflow,
        handleAskUserQuestion: (toolInput, signal) => authorizePiExecution({
          type: 'ask-user',
          input: toolInput,
          signal,
        }),
        handleRequestDirectWorkflow: (toolInput, signal) => authorizePiExecution({
          type: 'request-direct-workflow',
          input: toolInput,
          signal,
        }),
        handleExitPlanMode: (toolInput, signal) => authorizePiExecution({
          type: 'exit-plan',
          input: toolInput,
          signal,
        }),
        systemPrompt: systemPromptAppend + buildPiAdditionalDirectoriesPrompt(allAdditionalDirectories),
        ...(modelPresentationPreset !== 'standard' && { modelPresentationPreset }),
        resumeSessionId: existingSdkSessionId,
        piAgentDir: getSdkConfigDir(),
        piSessionDir: join(getSdkConfigDir(), 'sessions'),
        ...(allAdditionalDirectories.length > 0 && { additionalDirectories: allAdditionalDirectories }),
        ...(workspaceSlug ? { additionalSkillPaths: getEffectivePiSkillPaths(workspaceSlug) } : {}),
        ...(skillTriggerRecorder ? {
          skillTriggerRecorder,
          onSkillTrigger: (trigger: SkillTriggerEvent) => {
            this.eventBus.emit(sessionId, {
              kind: 'domi_event',
              event: { type: 'skill_triggered', trigger },
            })
          },
        } : {}),
        onTasksChanged: (tasks) => {
          try {
            updateAgentSessionMeta(sessionId, {
              workActivityTasks: tasks.map((task) => ({
                id: task.id,
                subject: task.subject,
                status: task.status,
                ...(task.activeForm?.trim() ? { activeForm: task.activeForm.trim() } : {}),
              })),
            })
            callbacks.onWorkActivityChanged?.()
          } catch { /* 会话可能已删除 */ }
        },
        ...(mentionedSkills?.length ? { skillMentions: mentionedSkills } : {}),
        ...(isCompactCommand ? {
          compactRequest: true,
          ...(compactCommand.instructions ? { compactInstructions: compactCommand.instructions } : {}),
        } : {}),
        steeringMode: appSettings.agentSteeringMode === 'all' ? 'all' : 'one-at-a-time',
        followUpMode: appSettings.agentFollowUpMode === 'all' ? 'all' : 'one-at-a-time',
        ...(normalizedNextTurnAsides.length > 0 && { nextTurnAsides: normalizedNextTurnAsides }),
        ...(sessionMeta?.codexFastMode && channel.provider === 'openai-codex' ? { codexFastMode: true } : {}),
        ...(codexOAuthCredentials && {
          codexOAuthCredentials,
          onCodexOAuthCredentialsRefreshed: (credentials: CodexOAuthCredentials) => {
            persistCodexOAuthCredentials(channelId, credentials)
          },
        }),
        ...((channel.provider === 'openai-codex' || channel.provider === 'openai-responses' || channel.provider === 'openai' || channel.provider === 'custom')
          && resolveReasoningProfile({
            modelId: selectedModelId,
            transport: inferReasoningTransport(channel.provider),
          })?.id.startsWith('openai-reasoning-') && {
            openAIThinkingLevel: piThinkingLevel!,
          }),
        thinkingLevel: piThinkingLevel!,
        ...(appSettings.agentMaxBudgetUsd != null && appSettings.agentMaxBudgetUsd > 0 && {
          maxBudgetUsd: appSettings.agentMaxBudgetUsd,
        }),
        ...(piCustomTools.length > 0 && {
          customTools: piCustomTools as PiAgentQueryOptions['customTools'],
          customToolSources: piCustomToolSources,
          customToolAnnotations: piToolAnnotations,
        }),
        onSessionId: handleSessionId,
        ...(Object.prototype.hasOwnProperty.call(sessionMeta ?? {}, 'piTreeActiveLeafId') && {
          resumeTreeLeafId: sessionMeta!.piTreeActiveLeafId,
          onTreeNavigationApplied: () => {
            const latest = getAgentSessionMeta(sessionId)
            if (latest?.piTreeActiveLeafId === sessionMeta!.piTreeActiveLeafId) {
              updateAgentSessionMeta(sessionId, { piTreeActiveLeafId: undefined })
            }
          },
        }),
        onPiEntryBindings: (bindings) => {
          const latest = getAgentSessionMeta(sessionId)
          if (!latest) return
          updateAgentSessionMeta(sessionId, {
            piEntryBindings: { ...(latest.piEntryBindings ?? {}), ...bindings },
          })
        },
        ...(worktreeHandoffAvailable ? {
          worktreeHandoff: {
            validate: async (_request, signal) => {
              const target = await validateAgentWorktreeHandoff({ parentSessionId: sessionId })
              let dirtyConfirmed = false
              if (target.dirty) {
                const confirmation = await askUserService.handleAskUserQuestion(
                  sessionId,
                  {
                    questions: [{
                      header: 'Worktree 交接',
                      question: 'Local Checkout 存在未提交修改。新 managed Worktree 只会从当前 HEAD 创建，不会复制这些修改。是否继续？',
                      multiSelect: false,
                      options: [
                        { label: '继续，不复制修改', description: '保留 Local 原状，在新的 managed Worktree 中从当前 HEAD 继续。' },
                        { label: '取消', description: '留在当前 Local 会话。' },
                      ],
                    }],
                  },
                  signal ?? new AbortController().signal,
                  (request: AskUserRequest) => {
                    this.eventBus.emit(sessionId, { kind: 'domi_event', event: { type: 'ask_user_request', request } })
                  },
                )
                const answers = confirmation.behavior === 'allow'
                  ? confirmation.updatedInput.answers as Record<string, string> | undefined
                  : undefined
                if (confirmation.behavior !== 'allow' || !answers || !Object.values(answers).includes('继续，不复制修改')) {
                  throw new SessionCheckoutError('dirty_confirmation_required', '用户未确认忽略 Local 未提交修改，已取消 Worktree handoff')
                }
                dirtyConfirmed = true
              }
              return { targetRevision: target.revision, targetCurrentOid: target.current.oid, dirtyConfirmed }
            },
            ready: (request) => {
              if (pendingWorktreeHandoff) throw new Error('当前 turn 已存在 Worktree handoff 请求')
              pendingWorktreeHandoff = request
            },
          },
        } : {}),
        onModelResolved: handleModelResolved,
        onContextWindow: handleContextWindow,
        onContextBreakdown: (breakdown) => {
          latestContextBreakdown = breakdown
          this.eventBus.emit(sessionId, {
            kind: 'domi_event',
            event: { type: 'context_breakdown', breakdown },
          })
        },
        retryRunStartedAt: streamStartedAt,
        ...(workspaceId && { auditWorkspaceId: workspaceId }),
        ...(onPiAuditTimingEvent && { onAuditTimingEvent: onPiAuditTimingEvent }),
        ...(appSettings.agentContextCompactorMode === 'observe' || appSettings.agentContextCompactorMode === 'enhance' ? {
          contextCompactor: {
            mode: appSettings.agentContextCompactorMode,
            getHostSnapshot: (signal: AbortSignal) => {
              if (signal.aborted) {
                const error = new Error('ContextCompactor host snapshot aborted.')
                error.name = 'AbortError'
                throw error
              }
              return structuredClone(contextCompactorHostSnapshot ?? {})
            },
          },
        } : {}),
        getRequestEnvelopeContext: () => ({
          executionPolicy: this.sessionExecutionPolicies.get(sessionId) ?? initialExecutionPolicy,
          workflow: deliveredFollowupOnly
            ? 'read-only'
            : this.sessionWorkflows.get(sessionId) ?? initialWorkflow,
          ...(sessionTargetPrompt && {
            sessionTarget: {
              kind: sessionTargetPrompt.kind,
              ownership: sessionTargetPrompt.ownership,
              ...(sessionTargetRevision !== undefined && { revision: sessionTargetRevision }),
            },
          }),
        }),
        onRetry: (retry) => {
          this.eventBus.emit(sessionId, { kind: 'domi_event', event: { type: 'retry', ...retry } })
        },
      }

      console.log(`[Agent 编排] 开始通过 Adapter 遍历事件流...`)

      // 14. 遍历 Adapter 产出的 AgentEvent 流（含自动重试）
      let lastRetryableError: string | undefined
      let retryDelayElapsedMs = 0
      let retryAttemptsScheduled = 0
      let retrySucceeded = false
      let skipNextRetryDelay = false
      let thinkingSignatureRecoveryAttempted = false
      let promptTooLongRecoveryAttempted = false
      let invisibleRecoveryAttempts = 0
      const canAutoRetry = (attempt: number): boolean =>
        attempt <= MAX_AUTO_RETRIES && retryDelayElapsedMs < MAX_AUTO_RETRY_WAIT_MS
      // Pi runtime 使用其 session 内的 native retry（agent.continue），能保留已完成的
      // tool_result；禁止外层以原 prompt 重开 query，但保留 session-not-found 等显式恢复。
      const canReplayPromptForRetry = (_attempt: number): boolean => false

      const canTryThinkingSignatureRecovery = (attempt: number): boolean =>
        !thinkingSignatureRecoveryAttempted &&
        canAutoRetry(attempt) &&
        !!(existingSdkSessionId || capturedSdkSessionId || queryOptions.resumeSessionId)
      const canTryPromptTooLongRecovery = (attempt: number): boolean =>
        !promptTooLongRecoveryAttempted &&
        canAutoRetry(attempt) &&
        !!(existingSdkSessionId || capturedSdkSessionId || queryOptions.resumeSessionId)

      const queryStartedAt = Date.now()
      if (agentInitializationStartedAt !== undefined) {
        startupTiming.recordAgentInitialization(agentInitializationStartedAt)
      }
      startupTiming.recordPiQuery({ resume: !!queryOptions.resumeSessionId })

      for (let attempt = 1; attempt <= MAX_AUTO_RETRIES + 1; attempt++) {
        // 非首次尝试：等待 + 发送重试事件到 UI
        if (attempt > 1) {
          if (skipNextRetryDelay) {
            skipNextRetryDelay = false
            console.log(`[Agent 编排] 已切换到上下文回填模式，立即重试`)
          } else {
            const retryAttempt = Math.max(1, attempt - 1 - invisibleRecoveryAttempts)
            const delayMs = getRetryDelayMs(retryAttempt, retryDelayElapsedMs)
            if (delayMs <= 0) {
              console.log(`[Agent 编排] 自动重试等待预算已耗尽 (${MAX_AUTO_RETRY_WAIT_MS}ms)，停止重试`)
              break
            }
            retryDelayElapsedMs += delayMs
            retryAttemptsScheduled = retryAttempt
            const delaySec = delayMs / 1000
            const attemptData: RetryAttempt = {
              attempt: retryAttempt,
              timestamp: Date.now(),
              reason: lastRetryableError ?? '未知错误',
              errorMessage: lastRetryableError ?? '',
              delaySeconds: delaySec,
            }

            // 前 RETRY_VISIBILITY_THRESHOLD 次重试静默进行，避免偶发瞬时波动频繁惊扰用户
            if (retryAttempt > RETRY_VISIBILITY_THRESHOLD) {
              this.eventBus.emit(sessionId, {
                kind: 'domi_event',
                event: { type: 'retry', status: 'starting', attempt: retryAttempt, maxAttempts: MAX_AUTO_RETRIES, delaySeconds: delaySec, reason: lastRetryableError ?? '未知错误' },
              })
              this.eventBus.emit(sessionId, {
                kind: 'domi_event',
                event: { type: 'retry', status: 'attempt', attemptData },
              })
            }

            console.log(`[Agent 编排] 第 ${retryAttempt} 次重试${retryAttempt <= RETRY_VISIBILITY_THRESHOLD ? '(静默)' : ''}，等待 ${delaySec}s...`)
            await new Promise((r) => setTimeout(r, delayMs))

            // 等待期间如果当前 run 被中止或已被新 generation 取代，退出。
            if (this.activeSessions.get(sessionId) !== runGeneration) {
              const wasStoppedByUser = this.consumeStoppedByUser(sessionId, runGeneration)
              this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
              try { updateAgentSessionMeta(sessionId, { stoppedByUser: wasStoppedByUser }) } catch { /* 会话可能已删除 */ }
              completeRun({ stoppedByUser: wasStoppedByUser, startedAt: streamStartedAt })
              return
            }
          }
        }

        let shouldRetryFromError = false

        try {
          // 获取异步迭代器（手动 .next() 以支持 Promise.race 中断）
          const queryIterable = this.adapter.query(queryOptions)
          const queryIterator = queryIterable[Symbol.asyncIterator]()

          // 手动事件循环：Promise.race（SDKMessage vs result drain timeout）
          let pendingNext: Promise<IteratorResult<SDKMessage>> | null = null
          // 捕获 result.subtype 以传递给前端（用于区分 success/error_max_turns/error_max_budget_usd）
          let capturedResultSubtype: string | undefined
          // 捕获 result.errors[] 错误详情：SDK 在 error_during_execution 等场景下会把真实错误原因
          // 放进 errors[]，透传到前端用于展示具体错误（而非泛泛的"任务执行过程中发生错误"）。
          let capturedResultErrors: string[] | undefined
          // result 收到后的安全超时：正常情况下 adapter 收到 terminal result 后会主动 break 自己的
          // for-await 循环（触发 SDK iterator.return → cleanup），让此处的 next() 立即拿到 done。
          // 此 timeout 仅作真正的兜底安全网，防止极端情况（SDK 行为再次变化等）下 iterator 不关闭、
          // 事件循环无限挂起。正常运行下不应触发——若日志频繁出现 drain timeout，说明 adapter 主动
          // 终止路径失效，需排查。
          let drainTimeoutPromise: Promise<'drain_timeout'> | null = null
          const RESULT_DRAIN_TIMEOUT_MS = 2_000
          // 后台任务等待态：result 走轻量完成后置 true，下一轮真正开始（收到 assistant/user/task 消息）时
          // 置回 false 并发 run_resumed，让 UI 从空闲态恢复运行态。
          let awaitingBackgroundWake = false
          let userFacingRunOutputCount = 0

          while (true) {
            if (!pendingNext) {
              pendingNext = queryIterator.next()
            }

            const racePromises: Array<Promise<{ kind: string; result: IteratorResult<SDKMessage> | null }>> = [
              pendingNext.then((r) => ({ kind: 'event' as const, result: r })),
            ]
            if (drainTimeoutPromise) {
              racePromises.push(drainTimeoutPromise.then(() => ({ kind: 'drain_timeout' as const, result: null })))
            }

            const raceResult = await Promise.race(racePromises)

            if (raceResult.kind === 'drain_timeout') {
              // 安全网：channel.close() 后 SDK 仍未在超时内关闭 iterator，强制退出
              console.warn(`[Agent 编排] drain timeout: SDK iterator 在 result 后 ${RESULT_DRAIN_TIMEOUT_MS}ms 内未关闭，强制退出`)
              pendingNext?.catch(() => {})
              pendingNext = null
              queryIterator.return?.(undefined as never).catch(() => {})
              break
            }

            const iterResult = raceResult.result
            if (!iterResult || iterResult.done) break

            pendingNext = null
            const msg = iterResult.value
            if (isAssistantDeltaSDKMessage(msg)) {
              this.eventBus.emit(sessionId, {
                kind: 'sdk_delta',
                delta: {
                  uuid: msg.uuid,
                  deltas: msg.deltas,
                  session_id: msg.session_id,
                  runStartedAt: streamStartedAt,
                  _channelModelId: msg._channelModelId,
                },
              })
              continue
            }
            const isPartialMessage = isPartialSDKMessage(msg)
            // 流式 partial、thinking、压缩状态和任务进度都不能证明本轮已经真正响应用户。
            // 显式 /compact 的成功语义在正常完成检查处单独放行。
            if (!isPartialMessage && isUserFacingRunOutput(msg)) {
              userFacingRunOutputCount += 1
            }

            // 后台任务唤醒：轻量完成后处于等待态，收到新一轮的首条实质消息时
            // 发 run_resumed，让 UI 从"空闲可输入"恢复到"运行中"。
            // applyAgentEvent 的流式分支不会重置 running，故必须显式通知。
            if (awaitingBackgroundWake) {
              const sub = msg.type === 'system' ? (msg as { subtype?: string }).subtype : undefined
              if (msg.type === 'assistant' || msg.type === 'user' || sub === 'task_started' || sub === 'task_progress') {
                awaitingBackgroundWake = false
                this.eventBus.emit(sessionId, { kind: 'domi_event', event: { type: 'run_resumed', sessionId } })
              }
            }

            // 检测 assistant 消息中的 SDK 错误
            if (msg.type === 'assistant' && !isPartialMessage) {
              const assistantMsg = msg as SDKAssistantMessage
              if (assistantMsg.error) {
                // Pi keeps generated text and transport failure in separate fields.
                const { detailedMessage, originalError } = getPiAssistantErrorDetails(assistantMsg)
                let errorCode = assistantMsg.error.errorType || 'unknown_error'
                if (isPromptTooLongError(detailedMessage, originalError)) {
                  errorCode = 'prompt_too_long'
                }
                const typedError = mapSDKErrorToTypedError(errorCode, friendlyErrorMessage(detailedMessage), originalError)

                // Session 不存在错误：清除 sdkSessionId，切换到上下文回填模式重试
                if (isSessionNotFoundError(detailedMessage, originalError) && existingSdkSessionId && canAutoRetry(attempt)) {
                  invisibleRecoveryAttempts += 1
                  skipNextRetryDelay = true
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  lastRetryableError = this.prepareSessionNotFoundRecovery(sessionId, queryOptions, contextualMessage, agentCwd, workspaceSlug, accumulatedMessages, queryStartedAt)
                  stderrChunks.length = 0
                  shouldRetryFromError = true
                  break
                }

                // Thinking signature 不兼容：通常由跨模型 resume 触发。
                // 先自动清除 SDK resume 关系，改用 Domi 已持久化上下文重跑一次；再失败才展示用户提示。
                if (
                  typedError.code === THINKING_SIGNATURE_ERROR_CODE &&
                  canTryThinkingSignatureRecovery(attempt)
                ) {
                  thinkingSignatureRecoveryAttempted = true
                  invisibleRecoveryAttempts += 1
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  skipNextRetryDelay = true
                  lastRetryableError = this.prepareResumeFallbackRecovery(
                    sessionId,
                    queryOptions,
                    contextualMessage,
                    agentCwd,
                    workspaceSlug,
                    accumulatedMessages,
                    queryStartedAt,
                    '检测到 thinking signature 不兼容，清除 sdkSessionId 并切换到上下文回填模式',
                    '思考签名不兼容，切换到上下文回填模式',
                    true,  // 跨模型签名不兼容是唯一确定永久无效的场景，清除磁盘 sdkSessionId
                  )
                  stderrChunks.length = 0
                  shouldRetryFromError = true
                  break
                }

                // 上下文过长：旧 SDK session 已经处于不可继续的超限状态。
                // 自动清除 resume 指针，改用 Domi 最近历史回填重跑一次；用于飞书/自动任务等无人值守入口自恢复。
                if (
                  typedError.code === 'prompt_too_long' &&
                  canTryPromptTooLongRecovery(attempt)
                ) {
                  promptTooLongRecoveryAttempted = true
                  invisibleRecoveryAttempts += 1
                  existingSdkSessionId = undefined
                  capturedSdkSessionId = undefined
                  skipNextRetryDelay = true
                  lastRetryableError = this.prepareResumeFallbackRecovery(
                    sessionId,
                    queryOptions,
                    contextualMessage,
                    agentCwd,
                    workspaceSlug,
                    accumulatedMessages,
                    queryStartedAt,
                    '检测到上下文过长，清除 sdkSessionId 并切换到上下文回填模式',
                    '上下文过长，切换到上下文回填模式',
                    true,
                  )
                  stderrChunks.length = 0
                  shouldRetryFromError = true
                  break
                }

                // 判断是否可自动重试
                if (isAutoRetryableTypedError(typedError) && canReplayPromptForRetry(attempt)) {
                  lastRetryableError = typedError.title
                    ? `${typedError.title}: ${typedError.message}`
                    : typedError.message
                  console.log(`[Agent 编排] 可重试错误 (assistant error): ${typedError.code} - ${lastRetryableError}`)
                  this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
                  accumulatedMessages.length = 0
                  // 与 catch 路径（isAutoRetryableCatchError）和思考签名回填路径保持一致：
                  // 重试前清空已累积的 stderr，避免 25 次重试上限内字符串无限增长
                  stderrChunks.length = 0
                  shouldRetryFromError = true
                  break
                }

                // 不可重试 → 终止
                const hasPiPartialOutput = hasPiAssistantTextContent(assistantMsg)
                if (hasPiPartialOutput) {
                  const partialOutput = attachExecutionContext(stripPiAssistantError(assistantMsg))
                  accumulatedMessages.push(partialOutput)
                  // Reuse the Pi UUID to replace the latest partial frame with normal markdown output.
                  this.eventBus.emit(sessionId, { kind: 'sdk_message', message: partialOutput })
                }
                this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
                accumulatedMessages.length = 0
                if (typedError.code === 'prompt_too_long') {
                  try { updateAgentSessionMeta(sessionId, { sdkSessionId: undefined }) } catch { /* 忽略 */ }
                }

                const errorContent = typedError.title
                    ? `${typedError.title}: ${typedError.message}`
                    : typedError.message
                const errorSDKMsg: SDKMessage = {
                  type: 'assistant',
                  message: {
                    content: [{ type: 'text', text: errorContent }],
                  },
                  parent_tool_use_id: null,
                  uuid: randomUUID(),
                  _channelModelId: modelId,
                  _channelProvider: channel.provider,
                  error: { message: typedError.message, errorType: typedError.code },
                  _createdAt: Date.now(),
                  _errorCode: typedError.code,
                  _errorTitle: typedError.title,
                  _errorDetails: typedError.details,
                  _errorCanRetry: typedError.canRetry,
                  _errorActions: typedError.actions,
                } as unknown as SDKMessage
                attachExecutionContext(errorSDKMsg)
                appendSDKMessages(sessionId, [errorSDKMsg])
                console.log(`[Agent 编排] 已保存 TypedError 消息: ${typedError.code} - ${typedError.title}`)

                // 如果之前有可见重试记录，发送 retry_failed
                if (retryAttemptsScheduled > RETRY_VISIBILITY_THRESHOLD && lastRetryableError) {
                  this.eventBus.emit(sessionId, {
                    kind: 'domi_event',
                    event: { type: 'retry', status: 'failed', attemptData: { attempt: retryAttemptsScheduled, timestamp: Date.now(), reason: lastRetryableError, errorMessage: typedError.message, delaySeconds: 0 } },
                  })
                }

                // 透传归一化后的错误消息到前端，避免 SDK 原始 API Error 直接暴露给用户。
                this.eventBus.emit(sessionId, { kind: 'sdk_message', message: errorSDKMsg })
                try { updateAgentSessionMeta(sessionId, {}) } catch { /* 忽略 */ }
                completeRun({ startedAt: streamStartedAt })
                return
              }
            }

            // 累积 assistant 和 user 消息用于持久化
            // - 跳过 replay 消息，避免 resume 时重复写入
            // - 对 user 消息，仅累积含 tool_result 的（初始用户消息已在步骤 5 手动持久化）
            // - 对 system 消息，仅累积需要长期可见的状态（压缩 / 权限拒绝）
            if (msg.type === 'assistant' || msg.type === 'user' || msg.type === 'result') {
              const msgRecord = msg as Record<string, unknown>
              if (!msgRecord.isReplay && !isPartialMessage) {
                if (msg.type === 'user') {
                  // 仅累积包含 tool_result 的 user 消息（跳过 SDK 重新发出的初始用户消息）
                  const content = (msg as { message?: { content?: Array<{ type: string }> } }).message?.content
                  const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
                  const isQueuedDelivery = msgRecord._queuedDelivery === true
                  if (hasToolResult || isQueuedDelivery) {
                    accumulatedMessages.push(msg)
                  }
                } else {
                  // 为结果消息注入渠道信息，确保持久化后能按 Agent SDK 运行窗口计算压缩阈值
                  if (msg.type === 'result' || msg.type === 'assistant') {
                    attachExecutionContext(msg)
                  }
                  accumulatedMessages.push(msg)
                }
              }
            } else if (msg.type === 'system') {
              const sysMsg = msg as SDKSystemMessage
              if (isPersistableSDKSystemMessage(sysMsg)) {
                accumulatedMessages.push(msg)
              }
            }

            // Turn 结束时：持久化累积消息
            if (msg.type === 'result') {
              capturedResultSubtype = (msg as { subtype?: string }).subtype
              // SDK 的 SDKResultError 在 errors[] 中携带真实错误原因（error_during_execution 等场景），
              // 捕获后既用于重试判定，也透传到前端展示具体错误。
              const rawResultErrors = (msg as { errors?: unknown }).errors
              capturedResultErrors = Array.isArray(rawResultErrors)
                ? rawResultErrors.filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
                : undefined
              this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
              accumulatedMessages.length = 0
              // Token 用量记录：每轮查询结束汇总一条（跳过合成的压缩收束 result）
              if (!isPartialMessage && (msg as { isSyntheticCompactionResult?: boolean }).isSyntheticCompactionResult !== true) {
                this.recordAgentUsage(
                  msg as SDKResultMessage,
                  sessionId,
                  channel.name,
                  channel.provider,
                  modelId,
                  sessionMeta?.title,
                  Date.now() - queryStartedAt,
                )
              }
              const resultTerminalReason = (msg as { terminal_reason?: string }).terminal_reason
              // adapter 在"本轮结束但仍有后台任务/定时任务在飞行"时打的注解：
              // 走轻量完成（UI 空闲可输入、host 保留会话），等待 task_notification 自动续轮。
              const keptOpenForTasks = (msg as Record<string, unknown>)._keepChannelOpenForTasks === true
              const keepChannelOpen = keptOpenForTasks
              // 分类打点：跟踪线上哪种 terminal_reason 最常见，配合 deferred_tool_use 回填决策
              const hasDeferredTool = (msg as { deferred_tool_use?: unknown }).deferred_tool_use != null
              console.log(
                `[Agent 编排] result 到达: sessionId=${sessionId}, subtype=${capturedResultSubtype ?? 'unknown'}, ` +
                `terminal_reason=${resultTerminalReason ?? 'undefined'}, keepChannelOpen=${keepChannelOpen}` +
                (keptOpenForTasks ? ', keptOpenForTasks=true' : '') +
                (hasDeferredTool ? ', hasDeferredTool=true' : '') +
                (capturedResultErrors?.length ? `, errors=${JSON.stringify(capturedResultErrors)}` : ''),
              )
              // error_during_execution 是 SDK 的兜底错误码，以 result（而非 assistant.error / 抛异常）形式到达，
              // 默认不会触发上面两条重试路径。这里用 errors[] 文本喂给现有的可重试判定（502/529/overloaded/
              // 网络瞬断 / 响应体解析失败等），命中则进入重试循环，复用统一的退避逻辑。
              if (
                capturedResultSubtype === 'error_during_execution' &&
                capturedResultErrors?.length &&
                isSessionNotFoundError(capturedResultErrors.join('\n'), stderrChunks.join('\n')) &&
                existingSdkSessionId &&
                canAutoRetry(attempt)
              ) {
                invisibleRecoveryAttempts += 1
                skipNextRetryDelay = true
                existingSdkSessionId = undefined
                capturedSdkSessionId = undefined
                lastRetryableError = this.prepareSessionNotFoundRecovery(sessionId, queryOptions, contextualMessage, agentCwd, workspaceSlug, accumulatedMessages, queryStartedAt)
                stderrChunks.length = 0
                shouldRetryFromError = true
                break
              }
              if (
                capturedResultSubtype === 'error_during_execution' &&
                capturedResultErrors?.length &&
                isAutoRetryableCatchError(null, capturedResultErrors.join('\n')) &&
                canReplayPromptForRetry(attempt)
              ) {
                lastRetryableError = capturedResultErrors[0]
                console.log(`[Agent 编排] 可重试错误 (result error_during_execution, attempt ${attempt}/${MAX_AUTO_RETRIES}): ${lastRetryableError}`)
                // 与 assistant.error / catch 重试路径保持一致：清空已累积 stderr，避免重试上限内无限增长
                stderrChunks.length = 0
                shouldRetryFromError = true
                break
              }
              if (keptOpenForTasks) {
                // 轻量完成：UI 置空闲可输入，但 host 保持运行态（不 releaseActiveRun、不 break、不启动 drain 超时），
                // while 循环继续 park 在 queryIterator.next()，等待后台任务完成时 SDK 自动 yield 的新一轮消息。
                awaitingBackgroundWake = true
                idleComplete({ startedAt: streamStartedAt, resultSubtype: capturedResultSubtype, resultErrors: capturedResultErrors })
              } else if (!keepChannelOpen && !drainTimeoutPromise) {
                // 启动 drain 超时安全网：正常情况下 adapter 收到 terminal result 会主动 break
                // 触发 iterator.return → 下一次 next() 立即返回 done，此 timeout 不会触发。
                // 仅在极端情况下（adapter 主动终止失效、SDK 行为再次变化）保护事件循环不无限挂起。
                drainTimeoutPromise = new Promise((resolve) =>
                  setTimeout(() => resolve('drain_timeout'), RESULT_DRAIN_TIMEOUT_MS),
                )
              }
            }

            // 过滤 SDK 内部生成的 user 消息（如 Skill 展开文本），避免在前端渲染为用户消息
            // 仅允许含 tool_result 的 user 消息通过（这些是工具调用的响应，需要展示）
            // 初始用户消息已通过前端乐观注入显示，无需 SDK 重复推送
            let shouldEmit = true
            if (msg.type === 'user') {
              const content = (msg as { message?: { content?: Array<{ type: string }> } }).message?.content
              const hasToolResult = Array.isArray(content) && content.some((b) => b.type === 'tool_result')
              const isQueuedDelivery = (msg as Record<string, unknown>)._queuedDelivery === true
              if (!hasToolResult && !isQueuedDelivery) {
                shouldEmit = false
              }
            }

            if (!shouldEmit) {
              // 跳过 SDK 内部 user 消息的前端推送
            } else {
              this.eventBus.emit(sessionId, { kind: 'sdk_message', message: msg })
            }
          }

          // 错误 break 触发了 → 继续循环
          if (shouldRetryFromError) {
            continue
          }

          const wasStoppedByUser = this.consumeStoppedByUser(sessionId, runGeneration)

          // 正常完成 — 如果之前有可见重试，发送 retry_cleared
          if (!wasStoppedByUser && retryAttemptsScheduled > RETRY_VISIBILITY_THRESHOLD) {
            this.eventBus.emit(sessionId, { kind: 'domi_event', event: { type: 'retry', status: 'cleared' } })
            console.log(`[Agent 编排] 重试成功，已在第 ${attempt} 次尝试后恢复`)
          }
          retrySucceeded = true

          // 15. 持久化 assistant 消息
          this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)

          try { updateAgentSessionMeta(sessionId, wasStoppedByUser ? { stoppedByUser: true } : {}) } catch { /* 忽略 */ }

          if (shouldFailRunForEmptyResponse({
            wasStoppedByUser,
            explicitCompactRequest: isCompactCommand,
            userFacingOutputCount: userFacingRunOutputCount,
          })) {
            const errorContent = this.persistEmptyResponseError(sessionId, capturedResultSubtype, capturedResultErrors)
            failRun(errorContent, {
              startedAt: streamStartedAt,
              resultSubtype: EMPTY_RESPONSE_RESULT_SUBTYPE,
              resultErrors: [errorContent],
            })
            return
          }

          const worktreeHandoff = !wasStoppedByUser ? pendingWorktreeHandoff : undefined
          pendingWorktreeHandoff = undefined
          const preparedWorktreeHandoff = worktreeHandoff
            ? await prepareAgentWorktreeHandoff({
                parentSessionId: sessionId,
                assistantMessageUuid: worktreeHandoff.assistantMessageUuid,
                toolResultMessageUuid: worktreeHandoff.toolResultMessageUuid,
                piToolResultEntryId: worktreeHandoff.piToolResultEntryId,
                task: worktreeHandoff.task,
                targetRevision: worktreeHandoff.targetRevision,
                targetCurrentOid: worktreeHandoff.targetCurrentOid,
                dirtyConfirmed: worktreeHandoff.dirtyConfirmed,
                channelId,
                modelId: selectedModelId,
                workspaceId,
                executionPolicy: this.sessionExecutionPolicies.get(sessionId) ?? initialExecutionPolicy,
                workflow: this.sessionWorkflows.get(sessionId) ?? initialWorkflow,
                permissionMode: getPermissionMode(),
              })
            : undefined

          if (preparedWorktreeHandoff && this.activeSessions.get(sessionId) !== runGeneration) {
            await preparedWorktreeHandoff.rollback()
            const stoppedDuringFork = this.consumeStoppedByUser(sessionId, runGeneration)
            completeRun({
              stoppedByUser: stoppedDuringFork,
              startedAt: streamStartedAt,
              resultSubtype: capturedResultSubtype,
              resultErrors: capturedResultErrors,
            })
            return
          }

          if (preparedWorktreeHandoff) {
            const handoffNotice = {
              type: 'system',
              subtype: 'worktree_handoff_created',
              session_id: sessionId,
              child_session_id: preparedWorktreeHandoff.child.id,
              child_session_title: preparedWorktreeHandoff.child.title,
              message: 'managed Worktree 子会话已创建，任务将在新会话中继续。',
              _createdAt: Date.now(),
            } as unknown as SDKMessage
            appendSDKMessages(sessionId, [handoffNotice])
            this.eventBus.emit(sessionId, { kind: 'sdk_message', message: handoffNotice })
          }

          // Plan 模式：Agent 完成规划后注入"接受计划"建议；handoff 已选择继续执行，不再请求原会话确认。
          if (!preparedWorktreeHandoff && planModeEntered && this.activeSessions.get(sessionId) === runGeneration) {
            this.eventBus.emit(sessionId, {
              kind: 'sdk_message',
              message: { type: 'prompt_suggestion', suggestion: '请执行该计划' } as unknown as SDKMessage,
            })
            console.log(`[Agent 编排] Plan 模式：已注入计划确认建议`)
          }

          // 发送完成信号
          completeRun({ stoppedByUser: wasStoppedByUser, startedAt: streamStartedAt, resultSubtype: capturedResultSubtype, resultErrors: capturedResultErrors })
          preparedWorktreeHandoff?.launch()

          break  // 成功完成，退出重试循环

        } catch (error) {
          // 打印 stderr
          const fullStderr = stderrChunks.join('').trim()
          if (fullStderr) {
            console.error(`[Agent 编排] 完整 stderr 输出 (${fullStderr.length} 字符):`)
            console.error(fullStderr)
          } else {
            console.error(`[Agent 编排] stderr 为空`)
          }

          // 当前 run 被中止或已被新 generation 取代。
          if (this.activeSessions.get(sessionId) !== runGeneration) {
            const wasStoppedByUser = this.consumeStoppedByUser(sessionId, runGeneration)
            console.log(`[Agent 编排] 会话 ${sessionId} 已被用户中止`)
            this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
            // 持久化中断状态到会话 meta
            try { updateAgentSessionMeta(sessionId, { stoppedByUser: wasStoppedByUser }) } catch { /* 会话可能已删除 */ }
            completeRun({ stoppedByUser: wasStoppedByUser, startedAt: streamStartedAt })
            return
          }

          // 从 stderr 提取 API 错误
          const stderrOutput = stderrChunks.join('').trim()
          const apiError = extractApiError(stderrOutput)
          const rawErrorMessage = error instanceof Error ? error.message : ''
          const catchLooksPromptTooLong = isPromptTooLongError(
            apiError?.message ?? '',
            rawErrorMessage,
            stderrOutput,
          )

          // Session 不存在错误：清除 sdkSessionId，切换到上下文回填模式重试
          if (isSessionNotFoundError(rawErrorMessage, stderrOutput) && existingSdkSessionId && canAutoRetry(attempt)) {
            invisibleRecoveryAttempts += 1
            skipNextRetryDelay = true
            existingSdkSessionId = undefined
            capturedSdkSessionId = undefined
            lastRetryableError = this.prepareSessionNotFoundRecovery(sessionId, queryOptions, contextualMessage, agentCwd, workspaceSlug, accumulatedMessages, queryStartedAt)
            stderrChunks.length = 0
            continue  // 进入下一次 retry 循环
          }

          // 上下文过长：清除超限 resume 指针，用 Domi 历史回填自动恢复一次。
          if (catchLooksPromptTooLong && canTryPromptTooLongRecovery(attempt)) {
            promptTooLongRecoveryAttempted = true
            invisibleRecoveryAttempts += 1
            existingSdkSessionId = undefined
            capturedSdkSessionId = undefined
            skipNextRetryDelay = true
            lastRetryableError = this.prepareResumeFallbackRecovery(
              sessionId,
              queryOptions,
              contextualMessage,
              agentCwd,
              workspaceSlug,
              accumulatedMessages,
              queryStartedAt,
              '检测到上下文过长，清除 sdkSessionId 并切换到上下文回填模式',
              '上下文过长，切换到上下文回填模式',
              true,
            )
            stderrChunks.length = 0
            continue  // 进入下一次 retry 循环
          }

          // Thinking signature 不兼容：先自动清除 SDK resume 关系并用上下文回填重跑一次。
          if (
            isThinkingSignatureError(apiError?.message ?? '', rawErrorMessage, stderrOutput) &&
            canTryThinkingSignatureRecovery(attempt)
          ) {
            thinkingSignatureRecoveryAttempted = true
            invisibleRecoveryAttempts += 1
            existingSdkSessionId = undefined
            capturedSdkSessionId = undefined
            skipNextRetryDelay = true
            lastRetryableError = this.prepareResumeFallbackRecovery(
              sessionId,
              queryOptions,
              contextualMessage,
              agentCwd,
              workspaceSlug,
              accumulatedMessages,
              queryStartedAt,
              '检测到 thinking signature 不兼容，清除 sdkSessionId 并切换到上下文回填模式',
              '思考签名不兼容，切换到上下文回填模式',
              true,  // 跨模型签名不兼容是唯一确定永久无效的场景，清除磁盘 sdkSessionId
            )
            stderrChunks.length = 0
            continue  // 进入下一次 retry 循环
          }

          // 判断是否可重试
          if (isAutoRetryableCatchError(apiError, rawErrorMessage, stderrOutput) && canReplayPromptForRetry(attempt)) {
            lastRetryableError = apiError
              ? `API Error ${apiError.statusCode}: ${apiError.message}`
              : (error instanceof Error ? error.message : '未知错误')
            console.log(`[Agent 编排] 可重试错误 (catch, attempt ${attempt}/${MAX_AUTO_RETRIES}): ${lastRetryableError}`)
            // 保存部分内容
            this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
            accumulatedMessages.length = 0
            stderrChunks.length = 0
            continue  // 进入下一次 retry 循环
          }

          // 不可重试 — 走原有终止逻辑
          const errorMessage = error instanceof Error ? error.message : '未知错误'
          console.error(`[Agent 编排] 执行失败:`, error)

          // 保存已累积的部分内容
          if (accumulatedMessages.length > 0) {
            try {
              this.persistSDKMessages(sessionId, accumulatedMessages, Date.now() - queryStartedAt)
              console.log(`[Agent 编排] 已保存部分执行结果 (${accumulatedMessages.length} 条消息)`)
            } catch (saveError) {
              console.error('[Agent 编排] 保存部分内容失败:', saveError)
            }
          }

          let userFacingError: string
          if (apiError) {
            userFacingError = friendlyErrorMessage(`API 错误 (${apiError.statusCode}):\n${apiError.message}`)
          } else {
            userFacingError = friendlyErrorMessage(errorMessage)
          }

          // 保存错误消息到 JSONL
          try {
            // 检测是否为 prompt too long 错误
            const isPromptTooLong = isPromptTooLongError(
              userFacingError,
              error instanceof Error ? (error.stack ?? error.message) : String(error),
              stderrOutput,
            )
            const isThinkingSignature = isThinkingSignatureError(
              apiError?.message ?? '',
              userFacingError,
              rawErrorMessage,
              error instanceof Error ? (error.stack ?? error.message) : String(error),
              stderrOutput,
            )
            const errorCode = isPromptTooLong
              ? 'prompt_too_long'
              : isThinkingSignature
                ? THINKING_SIGNATURE_ERROR_CODE
                : 'unknown_error'
            const errorTitle = isPromptTooLong
              ? '上下文过长'
              : isThinkingSignature
                ? THINKING_SIGNATURE_ERROR_TITLE
                : '执行错误'
            const errorContent = isPromptTooLong
              ? '上下文过长：当前对话的上下文已超出模型限制，请压缩上下文或开启新会话'
              : isThinkingSignature
                ? `${THINKING_SIGNATURE_ERROR_TITLE}：${THINKING_SIGNATURE_ERROR_MESSAGE}`
                : userFacingError
            const errorActions = isThinkingSignature
              ? [
                  { key: 'n', label: '在新对话继续', action: 'retry_in_new_session' },
                  { key: 'r', label: '重试', action: 'retry' },
                ]
              : undefined
            userFacingError = errorContent
            if (isPromptTooLong) {
              try { updateAgentSessionMeta(sessionId, { sdkSessionId: undefined }) } catch { /* 忽略 */ }
            }

            const errMsg: SDKMessage = {
              type: 'assistant',
              message: {
                content: [{ type: 'text', text: errorContent }],
              },
              parent_tool_use_id: null,
              uuid: randomUUID(),
              error: { message: errorContent, errorType: errorCode },
              _createdAt: Date.now(),
              _errorCode: errorCode,
              _errorTitle: errorTitle,
              _errorActions: errorActions,
            } as unknown as SDKMessage
            appendSDKMessages(sessionId, [errMsg])
            console.log(`[Agent 编排] 已保存错误消息到 JSONL`)
          } catch (saveError) {
            console.error('[Agent 编排] 保存错误消息失败:', saveError)
          }

          // 如果之前有可见重试记录，发送 retry_failed
          if (retryAttemptsScheduled > RETRY_VISIBILITY_THRESHOLD && lastRetryableError) {
            this.eventBus.emit(sessionId, {
              kind: 'domi_event',
              event: { type: 'retry', status: 'failed', attemptData: { attempt: retryAttemptsScheduled, timestamp: Date.now(), reason: lastRetryableError, errorMessage: userFacingError, delaySeconds: 0 } },
            })
          }

          failRun(userFacingError, { startedAt: streamStartedAt })

          // 保留 sdkSessionId，确保下一轮能继续 resume（修复 #903）。
          // 此终止分支只会被「非 session-not-found」的错误命中（session 失效已在上文
          // isSessionNotFoundError 分支单独处理并切到恢复模式）。网络断连、服务端 5xx、
          // 未知错误都不代表 SDK 会话本身失效——其完整历史 JSONL 仍保存在
          // ~/.domi/sdk-config/projects/.../{sdkSessionId}.jsonl 中，依旧可 resume。
          // 此前这里对 `!apiError`（如普通断连解析不出状态码）一律清除指针，导致下一轮
          // 退化为「仅回填最近 N 条」的冷启动，上下文从满载骤降（#903）。
          if (existingSdkSessionId) {
            console.log(`[Agent 编排] 保留 sdkSessionId 以便下一轮 resume（错误未表明会话失效）`)
          }

          return
        }
      }

      // 重试循环结束（达到最大次数仍失败）
      if (!retrySucceeded && lastRetryableError) {
        const retryFailureMessage = retryDelayElapsedMs >= MAX_AUTO_RETRY_WAIT_MS
          ? '重试等待已达到 5 分钟后仍然失败'
          : `重试 ${retryAttemptsScheduled || MAX_AUTO_RETRIES} 次后仍然失败`

        // 仅当重试曾经对用户可见时才发送 retry_failed 事件
        if (retryAttemptsScheduled > RETRY_VISIBILITY_THRESHOLD) {
          this.eventBus.emit(sessionId, {
            kind: 'domi_event',
            event: { type: 'retry', status: 'failed', attemptData: { attempt: retryAttemptsScheduled || MAX_AUTO_RETRIES, timestamp: Date.now(), reason: lastRetryableError, errorMessage: retryFailureMessage, delaySeconds: 0 } },
          })
        }

        // 保存错误消息
        const retryErrorContent = `${retryFailureMessage}: ${lastRetryableError}`
        const retryErrorSDKMsg: SDKMessage = {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: retryErrorContent }],
          },
          parent_tool_use_id: null,
          uuid: randomUUID(),
          error: { message: retryErrorContent, errorType: 'unknown_error' },
          _createdAt: Date.now(),
          _errorCode: 'unknown_error',
          _errorTitle: '重试失败',
        } as unknown as SDKMessage
        appendSDKMessages(sessionId, [retryErrorSDKMsg])

        failRun(`${retryFailureMessage}: ${lastRetryableError}`, { startedAt: streamStartedAt })
      }

    } finally {
      const dependencyPreparation = this.dependencyPreparationControllers.get(sessionId)
      if (dependencyPreparation?.generation === runGeneration) {
        dependencyPreparation.controller.abort()
        this.dependencyPreparationControllers.delete(sessionId)
      }
      // 只在 generation 匹配时才清理，防止旧流的 finally 误删新流的注册
      releaseActiveRun()
      permissionService.clearSessionPending(sessionId)
      // askUserService 不在 turn 结束时清理——AskUserQuestion 的生命周期由用户交互决定，
      // 仅在会话真正删除时（DELETE_SESSION IPC）才清理。
      exitPlanService.clearSessionPending(sessionId, runGeneration)
    }
  }

  /**
   * 中止指定会话的 Agent 执行
   *
   * 先从 activeSessions 移除（供 sendMessage catch 块检测用户中止），
   * 再调用 adapter.abort() 中止底层 SDK 进程。
   */
  stop(sessionId: string, source: AgentStopSource = 'unknown'): void {
    worktreeContinuationAuthorizationRegistry.noteSessionActivity(sessionId)
    if (this.rewindSessions.has(sessionId)) {
      console.warn(`[Agent 编排] 会话正在执行不可中断的文件回退，忽略 stop: sessionId=${sessionId}, source=${source}`)
      this.recordStopAudit('ignored', { sessionId, source, reason: 'rewind_in_progress' })
      return
    }
    const runGeneration = this.activeSessions.get(sessionId)
    if (runGeneration === undefined) {
      console.warn(`[Agent 编排] 忽略无活动 run 的 stop: sessionId=${sessionId}, source=${source}`)
      this.recordStopAudit('ignored', { sessionId, source, reason: 'no_active_run' })
      return
    }
    this.revokeTemporaryExecution(sessionId, runGeneration)
    this.activeSessions.delete(sessionId)
    this.activeChromeDevtoolsSessions.delete(sessionId)
    this.activeImageToolNames.delete(sessionId)
    this.sessionPermissionModes.delete(sessionId)
    this.sessionExecutionPolicies.delete(sessionId)
    this.sessionWorkflows.delete(sessionId)
    this.stopTracker.request(sessionId, runGeneration, source)
    this.queuedMessageUuids.delete(sessionId)
    this.nativeQueuedMessages.delete(sessionId)
    this.activeFileCheckpointContexts.delete(sessionId)
    this.dependencyPreparationControllers.get(sessionId)?.controller.abort()
    this.dependencyPreparationControllers.delete(sessionId)
    this.adapter.abort(sessionId)
    console.log(`[Agent 编排] 已中止会话: sessionId=${sessionId}, generation=${runGeneration}, source=${source}`)
    this.recordStopAudit('requested', { sessionId, generation: runGeneration, source })
  }

  /** 跳过当前 retry backoff，立即执行已安排的同一次恢复。 */
  async retryNow(sessionId: string): Promise<boolean> {
    if (!this.activeSessions.has(sessionId) || this.rewindSessions.has(sessionId)) return false
    if (!this.adapter.retryNow) return false
    return this.adapter.retryNow(sessionId)
  }

  /** 检查指定会话是否正在处理中 */
  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId) || this.rewindSessions.has(sessionId)
  }

  /** rewind 是不可排队绕过的 session mutation slot。 */
  isRewinding(sessionId: string): boolean {
    return this.rewindSessions.has(sessionId)
  }

  /** stop 后旧 runtime 尚未结算时，不允许 deferred queue 静默启动新 run。 */
  isStopping(sessionId: string): boolean {
    return this.stopTracker.has(sessionId)
  }

  /** 是否存在任意运行中 Agent 或宿主会话变更。 */
  hasActiveSessions(): boolean {
    return this.activeSessions.size > 0 || this.rewindSessions.size > 0
  }

  /**
   * 运行中动态切换会话的权限模式
   *
   * 同时更新 Domi 侧（canUseTool 闭包读取的 Map）和 SDK 侧（query.setPermissionMode）。
   * 典型场景：用户在 Agent 运行中通过 PermissionModeSelector 切换模式。
   */
  async updateSessionPermissionMode(sessionId: string, mode: DomiPermissionMode): Promise<void> {
    const runGeneration = this.activeSessions.get(sessionId)
    if (runGeneration === undefined) return
    const workflow: AgentWorkflow = mode === 'plan' ? 'read-only' : 'direct'
    this.revokeTemporaryExecution(sessionId, runGeneration)
    this.sessionPermissionModes.set(sessionId, 'bypassPermissions')
    this.sessionWorkflows.set(sessionId, workflow)
    this.sessionExecutionPolicies.set(sessionId, 'full-access')
    this.eventBus.emit(sessionId, {
      kind: 'domi_event',
      event: { type: 'plan_mode_changed', sessionId, active: false, source: 'permission', workflow },
    })
    console.log(`[Agent 编排] 运行中 Pi 权限模式已切换: sessionId=${sessionId}, mode=${mode}`)
  }

  async updateSessionExecutionControls(
    sessionId: string,
    controls: AgentExecutionControlsUpdate,
  ): Promise<void> {
    const runGeneration = this.activeSessions.get(sessionId)
    if (runGeneration === undefined) return
    if (controls.executionPolicy) {
      this.sessionExecutionPolicies.set(sessionId, 'full-access')
    }
    if (controls.workflow) {
      this.revokeTemporaryExecution(sessionId, runGeneration)
      const workflow = controls.workflow === 'plan-first' ? 'read-only' : controls.workflow
      this.sessionWorkflows.set(sessionId, workflow)
      this.eventBus.emit(sessionId, {
        kind: 'domi_event',
        event: {
          type: 'plan_mode_changed',
          sessionId,
          active: false,
          source: 'permission',
          workflow,
        },
      })
    }
  }

  // ===== Session Tree =====

  getSessionTree(sessionId: string): SessionTreeResult {
    const meta = getAgentSessionMeta(sessionId)
    if (!meta) throw new Error('Agent 会话不存在')
    if (!meta.piSessionFile || !existsSync(meta.piSessionFile)) {
      return { nodes: [], activeLeafId: null, branchCount: 0 }
    }
    const entries = readPiSessionEntries(meta.piSessionFile)
    const rawMessages = getAgentSessionSDKMessagesRaw(sessionId)
    const tree = buildSessionTree(entries, meta.piTreeActiveLeafId)
    const visibleMessages = filterMessagesToActivePiBranch(
      rawMessages,
      entries,
      meta.piEntryBindings,
      meta.piTreeActiveLeafId,
    )
    return prependHistoricalTranscript(tree, visibleMessages)
  }

  async navigateSessionTree(sessionId: string, entryId: string): Promise<NavigateSessionTreeResult> {
    if (worktreeContinuationAuthorizationRegistry.isConfirmationInProgress(sessionId)) {
      throw new Error('Worktree 续跑确认正在处理中，请等待完成后再切换分支')
    }
    worktreeContinuationAuthorizationRegistry.noteSessionActivity(sessionId)
    if (this.rewindSessions.has(sessionId)) throw new Error('会话正在变更，请等待完成后再切换分支')
    if (!this.adapter.navigateSessionTree) throw new Error('当前 Pi runtime 不支持 Session Tree 导航')
    const abortedRun = this.activeSessions.has(sessionId)
    if (abortedRun) this.stop(sessionId, 'session-tree-navigation')
    this.rewindSessions.add(sessionId)
    try {
      const { getSessionCheckoutModule } = await import('./session-checkout/production.ts')
      return await getSessionCheckoutModule().runExclusiveSessionMutation(sessionId, async (lockedTargetView) => {
        await this.recoverInterruptedRewind(sessionId, lockedTargetView)
        const meta = getAgentSessionMeta(sessionId)
        if (!meta) throw new Error('Agent 会话不存在')
        if (!meta.piSessionFile || !existsSync(meta.piSessionFile)) throw new Error('未找到 Pi session artifact')
        getAgentFileCheckpointStore().finalizeRewindUndo(sessionId)

        const workspace = meta.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
        const target = await resolveProductionAgentSessionTarget({
          sessionId,
          workspace,
          agentCwdMode: meta.agentCwdMode,
        })
        const result = await this.adapter.navigateSessionTree!(sessionId, {
          entryId,
          sessionFile: meta.piSessionFile,
          cwd: target.cwd,
        })
        const current = getAgentSessionMeta(sessionId)
        if (!current || current.piSessionFile !== meta.piSessionFile || current.sdkSessionId !== meta.sdkSessionId) {
          throw new Error('会话分支在导航期间已变化，已丢弃旧导航结果')
        }
        updateAgentSessionMeta(sessionId, { piTreeActiveLeafId: result.activeLeafId })

        if (result.editorText !== undefined) {
          // 活跃 Pi session.navigateTree 可能返回带动态上下文的原始 prompt；统一复用 artifact
          // 解析结果，只回填用户真正输入的内容（保留附件引用，移除恢复历史/时间/工作区块）。
          const editorText = resolveNavigationTarget(readPiSessionEntries(meta.piSessionFile), entryId).editorText
          if (editorText !== undefined) return { ...result, abortedRun: result.abortedRun || abortedRun, editorText }
        }
        return { ...result, abortedRun: result.abortedRun || abortedRun }
      })
    } finally {
      this.rewindSessions.delete(sessionId)
    }
  }

  // ===== 快照回退 =====

  private async recoverInterruptedRewind(
    sessionId: string,
    lockedTargetView?: SessionTargetView,
  ): Promise<void> {
    const checkpointStore = getAgentFileCheckpointStore()
    const recoveryState = checkpointStore.getRewindRecoveryState(sessionId)
    if (!recoveryState.needed) return

    const recover = async (targetView: SessionTargetView): Promise<void> => {
      const meta = getAgentSessionMeta(sessionId)
      if (!meta) throw new Error('Agent 会话不存在')
      const workspace = meta.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
      const target = await resolveProductionAgentSessionTarget({
        sessionId,
        workspace,
        agentCwdMode: meta.agentCwdMode,
      })
      if (recoveryState.filesChanged.length > 0) {
        const eligible = targetView.checkout.kind === 'isolated'
          && targetView.ownership === 'owner'
          && targetView.delivery?.state === 'working'
          && !target.followupOnly
        if (!eligible) throw new Error('未完成的文件回退事务已失去 working owner Isolated Checkout，无法自动恢复')
      }

      const prepared = checkpointStore.prepareRewindRecovery({ sessionId, targetRoot: target.cwd })
      if (!prepared.result.recovered) {
        const suffix = prepared.result.rollbackIncomplete ? '；自动补偿未完整完成，恢复事务已保留' : ''
        throw new Error(`未完成的回退事务恢复失败${suffix}`)
      }
      const targetTranscript = prepared.target === 'source'
        ? prepared.hostState.sourceTranscriptContent
        : prepared.hostState.rewoundTranscriptContent
      const targetPi = prepared.target === 'source'
        ? prepared.hostState.sourcePi
        : prepared.hostState.rewoundPi
      const transcriptRecovery = prepareSDKMessageRestore(sessionId, targetTranscript)
      const piRecovery = preparePiAgentSessionRecovery(
        sessionId,
        targetPi,
        prepared.hostState.sourcePi,
        prepared.hostState.rewoundPi,
      )
      try {
        piRecovery.commit()
        transcriptRecovery.commit()
        prepared.commit()
      } catch (error) {
        const rollbackErrors: string[] = []
        try { transcriptRecovery.rollback() } catch (rollbackError) {
          rollbackErrors.push(`对话恢复补偿失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
        }
        try { piRecovery.rollback() } catch (rollbackError) {
          rollbackErrors.push(`Pi 恢复补偿失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
        }
        const fileRollback = prepared.rollback()
        if (!fileRollback.complete) {
          rollbackErrors.push(`文件恢复补偿未完整完成：${fileRollback.failedFiles.map((item) => item.path).join('、')}；事务备份已保留`)
        }
        const primary = error instanceof Error ? error.message : String(error)
        throw new Error(rollbackErrors.length > 0 ? `${primary}；${rollbackErrors.join('；')}` : primary)
      }
    }

    if (lockedTargetView) {
      await recover(lockedTargetView)
      return
    }
    const { getSessionCheckoutModule } = await import('./session-checkout/production.ts')
    await getSessionCheckoutModule().runExclusiveSessionMutation(sessionId, recover)
  }

  private async resolveFileRewindPreview(
    sessionId: string,
    assistantMessageUuid: string,
    lockedTargetView?: SessionTargetView,
  ): Promise<{
    targetRoot: string
    laterUserMessageUuids: string[]
    missingUserMessageUuid: boolean
    preview: RewindSessionPreview['fileRewind']
  }> {
    const sessionMeta = getAgentSessionMeta(sessionId)
    if (!sessionMeta?.sdkSessionId) throw new Error('会话没有 Pi session ID，无法回退')
    const workspace = sessionMeta.workspaceId ? getAgentWorkspace(sessionMeta.workspaceId) : undefined
    const target = await resolveProductionAgentSessionTarget({
      sessionId,
      workspace,
      agentCwdMode: sessionMeta.agentCwdMode,
    })
    const boundaries = resolveLaterCheckpointUserIds(
      getAgentSessionSDKMessagesRaw(sessionId),
      assistantMessageUuid,
    )
    const targetView = lockedTargetView ?? await (async () => {
      const { getSessionCheckoutModule } = await import('./session-checkout/production.ts')
      return getSessionCheckoutModule().inspect(sessionId)
    })()
    const fileRewindEligible = targetView.checkout.kind === 'isolated'
      && targetView.ownership === 'owner'
      && targetView.delivery?.state === 'working'
      && !target.followupOnly
    const preview = fileRewindEligible
      ? getAgentFileCheckpointStore().previewRewind({
          sessionId,
          targetRoot: target.cwd,
          laterUserMessageUuids: boundaries.laterUserMessageUuids,
          missingUserMessageUuid: boundaries.missingUserMessageUuid,
        })
      : {
          available: false,
          changes: [],
          conflicts: [],
          unsupported: [],
          error: '初版文件回退仅支持仍在 working 状态的 owner Isolated Checkout；当前只能回退对话。',
        }
    return {
      targetRoot: target.cwd,
      laterUserMessageUuids: boundaries.laterUserMessageUuids,
      missingUserMessageUuid: boundaries.missingUserMessageUuid,
      preview,
    }
  }

  /** 只读预览：文件影响由 Domi 宿主检查点计算，不读取 Pi 内部 file-history artifact。 */
  async previewRewindSession(
    sessionId: string,
    assistantMessageUuid: string,
  ): Promise<RewindSessionPreview> {
    if (this.isActive(sessionId)) throw new Error('会话正在运行或回退中，请稍后再试')
    const prepared = await this.resolveFileRewindPreview(sessionId, assistantMessageUuid)
    return { fileRewind: prepared.preview }
  }

  /**
   * 回退到指定 assistant message（inclusive）。主进程先独占 session mutation slot，
   * 再准备 Pi branch、transcript 与文件事务；任一步提交失败都会尝试恢复三者。
   */
  async rewindSession(
    sessionId: string,
    assistantMessageUuid: string,
  ): Promise<RewindSessionResult> {
    if (worktreeContinuationAuthorizationRegistry.isConfirmationInProgress(sessionId)) {
      throw new Error('Worktree 续跑确认正在处理中，请等待完成后再回退')
    }
    worktreeContinuationAuthorizationRegistry.noteSessionActivity(sessionId)
    if (this.isActive(sessionId)) throw new Error('会话正在运行或回退中，请稍后再试')
    this.rewindSessions.add(sessionId)
    let piRewind: Awaited<ReturnType<typeof preparePiAgentSessionRewind>> | undefined
    let transcriptRewind: ReturnType<typeof prepareSDKMessageTruncation> | undefined
    let fileApplied: ReturnType<ReturnType<typeof getAgentFileCheckpointStore>['applyRewind']> | undefined
    let undoTransaction: {
      commitUndoable: (hostState: AgentRewindUndoHostState) => void
      rollback: () => AgentFileRollbackResult
    } | undefined
    try {
      const { getSessionCheckoutModule } = await import('./session-checkout/production.ts')
      return await getSessionCheckoutModule().runExclusiveSessionMutation(sessionId, async (lockedTargetView) => {
        await this.recoverInterruptedRewind(sessionId, lockedTargetView)
        const prepared = await this.resolveFileRewindPreview(sessionId, assistantMessageUuid, lockedTargetView)
        if (prepared.preview.conflicts.length > 0) {
          throw new Error(`文件在 Agent 写入后又被修改，已拒绝静默覆盖：${prepared.preview.conflicts.join('、')}`)
        }

        const checkpointStore = getAgentFileCheckpointStore()
        checkpointStore.finalizeRewindUndo(sessionId)
        transcriptRewind = prepareSDKMessageTruncation(sessionId, assistantMessageUuid)
        piRewind = await preparePiAgentSessionRewind(sessionId, assistantMessageUuid)
        const undoHostState: AgentRewindUndoHostState = {
          sourcePi: piRewind.sourceState,
          rewoundPi: piRewind.rewoundState,
          sourceTranscriptContent: transcriptRewind.originalContent,
          rewoundTranscriptContent: transcriptRewind.rewoundContent,
        }
        if (prepared.preview.available) {
          fileApplied = checkpointStore.applyRewind({
            sessionId,
            targetRoot: prepared.targetRoot,
            laterUserMessageUuids: prepared.laterUserMessageUuids,
            missingUserMessageUuid: prepared.missingUserMessageUuid,
            undoHostState,
          })
          undoTransaction = fileApplied
          if (!fileApplied.result.canRewind) {
            const detail = fileApplied.result.rollbackIncomplete
              ? `${fileApplied.result.error ?? '文件恢复失败'} 请停止继续修改并保留当前会话以便恢复。`
              : fileApplied.result.error ?? '文件恢复失败'
            throw new Error(detail)
          }
        } else {
          undoTransaction = checkpointStore.prepareConversationOnlyRewind({
            sessionId,
            targetRoot: prepared.targetRoot,
            undoHostState,
          })
        }

        piRewind.commit()
        transcriptRewind.commit()
        undoTransaction.commitUndoable(undoHostState)
        const filesChanged = fileApplied?.result.filesChanged ?? []
        return {
          remainingMessages: transcriptRewind.kept.length,
          fileRewind: fileApplied?.result ?? {
            canRewind: false,
            error: prepared.preview.error ?? '该历史区间没有完整的 Domi 文件检查点，当前仅回退对话。',
          },
          undoAvailable: true,
          ...(filesChanged.length > 0 ? { verificationInvalidated: true } : {}),
        }
      })
    } catch (error) {
      const rollbackErrors: string[] = []
      try { transcriptRewind?.rollback() } catch (rollbackError) {
        rollbackErrors.push(`对话历史恢复失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
      }
      try { piRewind?.rollback() } catch (rollbackError) {
        rollbackErrors.push(`Pi branch 恢复失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
      }
      if (undoTransaction) {
        const fileRollback = undoTransaction.rollback()
        if (!fileRollback.complete) {
          rollbackErrors.push(`文件恢复事务未完整回滚：${fileRollback.failedFiles.map((item) => item.path).join('、')}；事务备份已保留`)
        }
      }
      const primary = error instanceof Error ? error.message : String(error)
      throw new Error(rollbackErrors.length > 0 ? `${primary}；${rollbackErrors.join('；')}` : primary)
    } finally {
      this.rewindSessions.delete(sessionId)
    }
  }

  async getRewindUndoState(sessionId: string): Promise<RewindUndoState> {
    if (this.isActive(sessionId)) {
      return { exists: false, available: false, filesChanged: [], conflicts: [], error: '会话正在运行或回退中' }
    }
    let recoveryPerformed = false
    if (getAgentFileCheckpointStore().getRewindRecoveryState(sessionId).needed) {
      this.rewindSessions.add(sessionId)
      try {
        await this.recoverInterruptedRewind(sessionId)
        recoveryPerformed = true
      } finally {
        this.rewindSessions.delete(sessionId)
      }
    }
    const meta = getAgentSessionMeta(sessionId)
    if (!meta) return { exists: false, available: false, filesChanged: [], conflicts: [], error: 'Agent 会话不存在' }
    const workspace = meta.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
    const target = await resolveProductionAgentSessionTarget({
      sessionId,
      workspace,
      agentCwdMode: meta.agentCwdMode,
    })
    const state = getAgentFileCheckpointStore().getRewindUndoState({ sessionId, targetRoot: target.cwd })
    if (!state.available || state.filesChanged.length === 0) return recoveryPerformed ? { ...state, recoveryPerformed: true } : state
    const { getSessionCheckoutModule } = await import('./session-checkout/production.ts')
    const targetView = await getSessionCheckoutModule().inspect(sessionId)
    const eligible = targetView.checkout.kind === 'isolated'
      && targetView.ownership === 'owner'
      && targetView.delivery?.state === 'working'
      && !target.followupOnly
    const resolved = eligible
      ? state
      : { ...state, available: false, error: '原文件回退环境已不再是 working owner Isolated Checkout，无法安全撤销' }
    return recoveryPerformed ? { ...resolved, recoveryPerformed: true } : resolved
  }

  async undoRewindSession(sessionId: string): Promise<UndoRewindSessionResult> {
    if (worktreeContinuationAuthorizationRegistry.isConfirmationInProgress(sessionId)) {
      throw new Error('Worktree 续跑确认正在处理中，请等待完成后再撤销回退')
    }
    worktreeContinuationAuthorizationRegistry.noteSessionActivity(sessionId)
    if (this.isActive(sessionId)) throw new Error('会话正在运行或回退中，请稍后再试')
    this.rewindSessions.add(sessionId)
    let fileUndo: ReturnType<ReturnType<typeof getAgentFileCheckpointStore>['prepareUndoRewind']> | undefined
    let transcriptRestore: ReturnType<typeof prepareSDKMessageRestore> | undefined
    let piRestore: ReturnType<typeof preparePiAgentSessionRestore> | undefined
    try {
      const { getSessionCheckoutModule } = await import('./session-checkout/production.ts')
      return await getSessionCheckoutModule().runExclusiveSessionMutation(sessionId, async (lockedTargetView) => {
        await this.recoverInterruptedRewind(sessionId, lockedTargetView)
        const meta = getAgentSessionMeta(sessionId)
        if (!meta) throw new Error('Agent 会话不存在')
        const workspace = meta.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
        const target = await resolveProductionAgentSessionTarget({
          sessionId,
          workspace,
          agentCwdMode: meta.agentCwdMode,
        })
        const checkpointStore = getAgentFileCheckpointStore()
        const state = checkpointStore.getRewindUndoState({ sessionId, targetRoot: target.cwd })
        if (!state.available) {
          if (state.conflicts.length > 0) throw new Error(`文件在回退后又被修改，已拒绝静默覆盖：${state.conflicts.join('、')}`)
          throw new Error(state.error ?? '没有可撤销的回退')
        }
        if (state.filesChanged.length > 0) {
          const eligible = lockedTargetView.checkout.kind === 'isolated'
            && lockedTargetView.ownership === 'owner'
            && lockedTargetView.delivery?.state === 'working'
            && !target.followupOnly
          if (!eligible) throw new Error('原文件回退环境已不再是 working owner Isolated Checkout，无法安全撤销')
        }

        fileUndo = checkpointStore.prepareUndoRewind({ sessionId, targetRoot: target.cwd })
        if (!fileUndo.result.canUndo) {
          const suffix = fileUndo.result.rollbackIncomplete ? '；自动补偿未完整完成，恢复事务已保留' : ''
          throw new Error(`文件撤销回退失败${suffix}`)
        }
        transcriptRestore = prepareSDKMessageRestore(sessionId, fileUndo.hostState.sourceTranscriptContent)
        piRestore = preparePiAgentSessionRestore(
          sessionId,
          fileUndo.hostState.sourcePi,
          fileUndo.hostState.rewoundPi,
        )

        piRestore.commit()
        transcriptRestore.commit()
        fileUndo.commit()
        piRestore.finalize()
        const filesChanged = fileUndo.result.filesChanged
        return {
          restoredMessages: getAgentSessionSDKMessagesRaw(sessionId).length,
          filesChanged,
          ...(filesChanged.length > 0 ? { verificationInvalidated: true } : {}),
        }
      })
    } catch (error) {
      const rollbackErrors: string[] = []
      try { transcriptRestore?.rollback() } catch (rollbackError) {
        rollbackErrors.push(`对话历史补偿失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
      }
      try { piRestore?.rollback() } catch (rollbackError) {
        rollbackErrors.push(`Pi branch 补偿失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
      }
      if (fileUndo) {
        const fileRollback = fileUndo.rollback()
        if (!fileRollback.complete) {
          rollbackErrors.push(`文件撤销补偿未完整完成：${fileRollback.failedFiles.map((item) => item.path).join('、')}；事务备份已保留`)
        }
      }
      const primary = error instanceof Error ? error.message : String(error)
      throw new Error(rollbackErrors.length > 0 ? `${primary}；${rollbackErrors.join('；')}` : primary)
    } finally {
      this.rewindSessions.delete(sessionId)
    }
  }

  /** 中止所有活跃的 Agent 会话（应用退出时调用） */
  stopAll(): void {
    if (this.activeSessions.size > 0) {
      console.log(`[Agent 编排] 正在中止所有活跃会话 (${this.activeSessions.size} 个)...`)
    }
    // 即便 activeSessions 为空，也要调 dispose 清理可能残留的 pidMap / 子进程
    this.adapter.dispose()
    this.activeSessions.clear()
    this.rewindSessions.clear()
    this.activeChromeDevtoolsSessions.clear()
    this.activeImageToolNames.clear()
    this.sessionPermissionModes.clear()
    this.sessionExecutionPolicies.clear()
    this.sessionWorkflows.clear()
    this.stopTracker.clear()
    this.runExecutionLeases.clear()
    worktreeContinuationAuthorizationRegistry.clear()
    this.queuedMessageUuids.clear()
    this.nativeQueuedMessages.clear()
    this.activeFileCheckpointContexts.clear()
  }

  // ===== 队列消息管理 =====

  /**
   * 流式追加消息。
   *
   * 带 kind 的普通追加：立即进入 Pi 原生 steering/follow-up 队列，直到 queue_update
   * 确认送达后才持久化并向 renderer 发用户消息；Pi 是送达时序的唯一事实源。
   * interrupt：保持立即持久化语义。
   */
  async queueMessage(
    sessionId: string,
    text: string,
    rawText?: string,
    _priority?: string,
    presetUuid?: string,
    opts?: { interrupt?: boolean; kind?: AgentQueueMessageKind },
    mentionedSkills?: string[],
    mentionedMcpServers?: string[],
    mentionedSessionIds?: string[],
    mentionedTodoIds?: string[],
    mentionedCalendarEventIds?: string[],
    nextTurnAsides?: AgentNextTurnAside[],
  ): Promise<string> {
    if (worktreeContinuationAuthorizationRegistry.isConfirmationInProgress(sessionId)) {
      throw new Error('Worktree 续跑确认正在处理中，请等待完成后再追加消息')
    }
    assertAgentPlanCommandMayBeQueued(text)
    worktreeContinuationAuthorizationRegistry.noteSessionActivity(sessionId)
    if (this.rewindSessions.has(sessionId)) {
      throw new Error(`[Agent 编排] 会话正在回退，无法追加消息: ${sessionId}`)
    }
    const runGeneration = this.activeSessions.get(sessionId)
    if (runGeneration === undefined) {
      const error = new Error(`[Agent 编排] 会话未运行，无法追加消息: ${sessionId}`) as Error & { code?: string }
      error.code = 'agent.query.not_active'
      throw error
    }
    const ownsRun = (): boolean => this.activeSessions.get(sessionId) === runGeneration
    if (!this.adapter.sendQueuedMessage) {
      throw new Error('[Agent 编排] 当前适配器不支持流式追加消息')
    }

    const meta = getAgentSessionMeta(sessionId)
    const workspaceSlug = meta?.workspaceId
      ? getAgentWorkspace(meta.workspaceId)?.slug
      : undefined
    const chromeDevtoolsMcpName = getBuiltinMcpName('chrome-devtools')
    const chromeDevtoolsMentioned = mentionedMcpServers?.some((name) => (
      name === 'chrome-devtools' || name === chromeDevtoolsMcpName
    )) ?? false
    if (shouldRequireChromeDevtoolsRestartForQueuedMessage(
      isBuiltinMcpUserEnabled('chrome-devtools'),
      text,
      chromeDevtoolsMentioned,
      this.activeChromeDevtoolsSessions.has(sessionId),
    )) {
      throw new Error('当前运行未加载 Chrome 浏览器工具。请等待本轮结束后重新发送，或先停止当前运行再发送。')
    }

    const normalizedNextTurnAsides = normalizeAgentNextTurnAsides(nextTurnAsides)
    let enrichedText = text
    const asideContext = buildQueuedAgentAsideContext(normalizedNextTurnAsides)
    if (asideContext) enrichedText = `${asideContext}\n\n${enrichedText}`
    const referencedSessionsBlock = buildReferencedSessionsPrompt(sessionId, mentionedSessionIds, workspaceSlug)
    if (referencedSessionsBlock) enrichedText = `${referencedSessionsBlock}\n\n${enrichedText}`
    if (mentionedSkills?.length || mentionedMcpServers?.length) {
      const toolLines: string[] = ['用户在消息中明确引用了以下工具，请在本次回复中主动调用：']
      for (const slug of mentionedSkills ?? []) {
        const qualifiedName = workspaceSlug ? `domi-workspace-${workspaceSlug}:${slug}` : slug
        toolLines.push(`- Skill: ${qualifiedName}（请立即调用此 Skill）`)
      }
      for (const name of mentionedMcpServers ?? []) {
        toolLines.push(`- MCP 服务器: ${name}（请使用此 MCP 服务器的工具来完成任务）`)
      }
      enrichedText = `<mentioned_tools>\n${toolLines.join('\n')}\n</mentioned_tools>\n\n${enrichedText}`
    }
    const referencedPlanningBlock = buildReferencedPlanningPrompt(
      mentionedTodoIds,
      mentionedCalendarEventIds,
      { requireToolRead: true },
    )
    if (referencedPlanningBlock) enrichedText = `${referencedPlanningBlock}\n\n${enrichedText}`

    const displayText = rawText ?? text
    const imageCommand = parseAgentImageCommand(displayText)
    if (imageCommand.matched) {
      const availableImageToolNames = this.activeImageToolNames.get(sessionId)
      enrichedText = buildAgentImageCommandPrompt({
        command: imageCommand,
        enrichedMessage: enrichedText,
        availableToolNames: availableImageToolNames,
      })
      console.log(`[Agent 编排] 队列识别生图快捷命令: /${imageCommand.command}, 可用工具 ${availableImageToolNames?.length ?? '初始化中'}`)
    }

    const uuid = presetUuid || randomUUID()
    const uuids = this.queuedMessageUuids.get(sessionId) ?? new Set<string>()
    uuids.add(uuid)
    this.queuedMessageUuids.set(sessionId, uuids)

    const nativeKind = !opts?.interrupt ? opts?.kind : undefined
    const sdkMessage = {
      type: 'user' as const,
      message: { role: 'user' as const, content: enrichedText },
      parent_tool_use_id: null,
      priority: nativeKind === 'followUp' ? 'later' as const : 'now' as const,
      uuid,
      session_id: sessionId,
    }
    const createDeliveredMessage = (queuedDelivery = false): SDKMessage => {
      return {
        type: 'user',
        uuid,
        message: { content: [{ type: 'text', text: displayText }] },
        parent_tool_use_id: null,
        _createdAt: Date.now(),
        ...(normalizedNextTurnAsides.length > 0 && { _asides: normalizedNextTurnAsides }),
        ...(queuedDelivery && { _queuedDelivery: true }),
      } as unknown as SDKMessage
    }

    let nativeRecord: NativeQueuedMessageRecord | undefined
    if (nativeKind) {
      nativeRecord = { uuid, kind: nativeKind, rawText: displayText }
      const records = this.nativeQueuedMessages.get(sessionId) ?? []
      records.push(nativeRecord)
      this.nativeQueuedMessages.set(sessionId, records)
    }

    try {
      // Interrupt 开始的是一个新的用户任务，不能继承上一任务的临时执行 lease。
      if (!ownsRun()) throw new Error(`[Agent 编排] 运行状态已变化，取消追加消息: ${sessionId}`)
      if (opts?.interrupt) this.revokeTemporaryExecution(sessionId, runGeneration)
      if (opts?.interrupt && this.adapter.interruptQuery) {
        try {
          await this.adapter.interruptQuery(sessionId)
        } catch (error) {
          console.warn('[Agent 编排] 软中断失败（将继续追加消息）:', error)
        }
        if (!ownsRun()) throw new Error(`[Agent 编排] 软中断后运行状态已变化，取消追加消息: ${sessionId}`)
      }

      if (!ownsRun()) throw new Error(`[Agent 编排] 运行状态已变化，取消队列注入: ${sessionId}`)
      await this.adapter.sendQueuedMessage(sessionId, sdkMessage, nativeKind ? {
        queueKind: nativeKind,
        queueMessageId: uuid,
        onDelivered: () => {
          const records = this.nativeQueuedMessages.get(sessionId) ?? []
          const index = nativeRecord ? records.indexOf(nativeRecord) : -1
          if (!ownsRun()) {
            // 旧 run 的迟到回调只能移除自己捕获的镜像记录，不得触碰新 run 权限。
            if (index >= 0) records.splice(index, 1)
            return
          }
          if (index < 0) return // clearQueue/replay 已替换该回调，不得把已取回消息误判为送达。
          // Pi 已把 steering/follow-up 从队列取出，即将开始新的用户 turn；确认送达后
          // 才恢复持久研究模式，避免被已撤回消息的迟到回调错误降权。
          this.revokeTemporaryExecution(sessionId, runGeneration)
          records.splice(index, 1)
          if (records.length === 0) this.nativeQueuedMessages.delete(sessionId)
          uuids.delete(uuid)
          const checkpointContext = this.activeFileCheckpointContexts.get(sessionId)
          if (checkpointContext) {
            try {
              getAgentFileCheckpointStore().beginCheckpoint({
                sessionId,
                userMessageUuid: uuid,
                targetRoot: checkpointContext.targetRoot,
              })
              checkpointContext.userMessageUuid = uuid
            } catch (error) {
              this.activeFileCheckpointContexts.delete(sessionId)
              console.warn('[file-checkpoint] queued checkpoint failed; later controlled writes are untracked:', error)
            }
          }
          this.eventBus.emit(sessionId, {
            kind: 'domi_event',
            event: { type: 'agent_queue_message_delivered', uuid, kind: nativeKind },
          })
          return createDeliveredMessage(true)
        },
      } : undefined)
      if (!ownsRun()) throw new Error(`[Agent 编排] 队列注入后运行状态已变化: ${sessionId}`)
      console.log(`[Agent 编排] 追加消息已注入: sessionId=${sessionId}, uuid=${uuid}, kind=${nativeKind ?? 'legacy'}, interrupt=${!!opts?.interrupt}`)

      if (!nativeKind) {
        const deliveredMessage = createDeliveredMessage()
        appendSDKMessages(sessionId, [deliveredMessage])
        // Interrupt/legacy injection 没有 Pi 的真实 turn-delivery 边界；停止继续归入旧 checkpoint，
        // 让该历史区间明确退化为 conversation-only，而不是虚假声称文件可恢复。
        this.activeFileCheckpointContexts.delete(sessionId)
        this.eventBus.emit(sessionId, { kind: 'sdk_message', message: deliveredMessage })
      }
    } catch (error) {
      uuids.delete(uuid)
      if (nativeRecord) {
        const records = this.nativeQueuedMessages.get(sessionId) ?? []
        const index = records.indexOf(nativeRecord)
        if (index >= 0) records.splice(index, 1)
        if (records.length === 0) this.nativeQueuedMessages.delete(sessionId)
      }
      if (isMissingActiveQueueChannelError(error) && ownsRun()) {
        console.warn(`[Agent 编排] 队列注入失败且消息通道已失效，释放陈旧运行状态: sessionId=${sessionId}`)
        this.revokeTemporaryExecution(sessionId, runGeneration)
        this.activeSessions.delete(sessionId)
        this.activeChromeDevtoolsSessions.delete(sessionId)
        this.activeImageToolNames.delete(sessionId)
        this.sessionPermissionModes.delete(sessionId)
        this.sessionExecutionPolicies.delete(sessionId)
        this.sessionWorkflows.delete(sessionId)
        this.queuedMessageUuids.delete(sessionId)
        this.nativeQueuedMessages.delete(sessionId)
      }
      throw error
    }

    return uuid
  }

  async replaceMessageQueue(sessionId: string, messages: AgentQueueReplayMessageInput[]): Promise<string[]> {
    if (!this.adapter.clearQueuedMessages || !this.adapter.withQueuedMessageDeliverySuppressed) {
      throw new Error('[Agent 编排] 当前适配器不支持原生消息队列事务')
    }

    let replayed: AgentQueueReplayMessageInput[] = []
    await this.adapter.withQueuedMessageDeliverySuppressed(sessionId, async () => {
      replayed = await clearAndReplayNativeQueue(
        messages,
        async () => {
          const cleared = await this.adapter.clearQueuedMessages!(sessionId)
          // adapter 已用实际 SDK 文本队列与 pending callback 对账，并返回稳定 UUID；
          // 不再依赖可能因并发送达而错位的长度/位置裁剪。
          const pendingIds = new Set([
            ...cleared.steeringMessageIds,
            ...cleared.followUpMessageIds,
          ])
          const queuedUuids = this.queuedMessageUuids.get(sessionId)
          for (const uuid of pendingIds) queuedUuids?.delete(uuid)
          this.nativeQueuedMessages.delete(sessionId)
          return messages.filter((message) => pendingIds.has(message.uuid))
        },
        async (message) => {
          await this.queueMessage(
            sessionId,
            message.userMessage,
            message.rawUserMessage,
            undefined,
            message.uuid,
            { kind: message.kind },
            message.mentionedSkills,
            message.mentionedMcpServers,
            message.mentionedSessionIds,
            message.mentionedTodoIds,
            message.mentionedCalendarEventIds,
            message.nextTurnAsides,
          )
        },
      )
    })

    // transaction 退出时 adapter 会按 SDK 最终队列一次性结算 replay 期间的真实送达；
    // 只把仍存在于主进程镜像的 UUID 返回 renderer，防止已送达项被结果回写重新加回。
    const pendingIds = new Set((this.nativeQueuedMessages.get(sessionId) ?? []).map((record) => record.uuid))
    return replayed.filter((message) => pendingIds.has(message.uuid)).map((message) => message.uuid)
  }

  async clearMessageQueue(
    sessionId: string,
    options?: { abort?: boolean },
  ): Promise<AgentClearMessageQueueResult> {
    if (!this.adapter.clearQueuedMessages) throw new Error('[Agent 编排] 当前适配器不支持原生消息队列')
    if (options?.abort) {
      const runGeneration = this.activeSessions.get(sessionId)
      if (this.stopTracker.request(sessionId, runGeneration, 'renderer-queue-abort')) {
        console.log(`[Agent 编排] 已请求中止并清空队列: sessionId=${sessionId}, generation=${runGeneration}, source=renderer-queue-abort`)
        this.recordStopAudit('requested', { sessionId, generation: runGeneration, source: 'renderer-queue-abort' })
      } else {
        console.warn(`[Agent 编排] 忽略无活动 run 的队列中止: sessionId=${sessionId}, source=renderer-queue-abort`)
        this.recordStopAudit('ignored', { sessionId, source: 'renderer-queue-abort', reason: 'no_active_run' })
      }
    }
    const cleared = await this.adapter.clearQueuedMessages(sessionId, options)
    const clearedIds = new Set([
      ...cleared.steeringMessageIds,
      ...cleared.followUpMessageIds,
    ])
    // adapter 返回与 SDK 实际 clearQueue 内容匹配后的稳定 UUID，避免按长度 slice 误取。
    const currentRecords = this.nativeQueuedMessages.get(sessionId) ?? []
    const records = currentRecords.filter((record) => clearedIds.has(record.uuid))
    this.nativeQueuedMessages.delete(sessionId)
    const uuids = this.queuedMessageUuids.get(sessionId)
    for (const record of records) uuids?.delete(record.uuid)
    return {
      steering: records
        .filter((record) => record.kind === 'steering')
        .map((record) => ({ uuid: record.uuid, kind: record.kind, rawUserMessage: record.rawText })),
      followUp: records
        .filter((record) => record.kind === 'followUp')
        .map((record) => ({ uuid: record.uuid, kind: record.kind, rawUserMessage: record.rawText })),
    }
  }
}

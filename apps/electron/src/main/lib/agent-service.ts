/**
 * Agent 服务层（IPC 薄层）
 *
 * 职责：
 * - 创建 AgentOrchestrator / EventBus / Adapter 实例
 * - 注册 EventBus IPC 转发中间件（webContents.send）
 * - 导出 IPC handler 调用的薄包装函数
 * - 文件操作（saveFilesToAgentSession）
 *
 * 所有业务逻辑已委托给 AgentOrchestrator。
 */

import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { BrowserWindow } from 'electron'
import type { WebContents } from 'electron'
import { AGENT_IPC_CHANNELS, MAX_ATTACHMENT_SIZE } from '@domi/shared'
import type {
  AgentSendInput,
  AgentGenerateTitleInput,
  AgentSaveFilesInput,
  AgentSaveWorkspaceFilesInput,
  AgentSavedFile,
  AgentStreamEvent,
  AgentStreamPayload,
  AgentQueueMessageInput,
  AgentSubmitOrEnqueueInput,
  AgentSubmitOrEnqueueResult,
  AgentQueuedMessageControlInput,
  AgentMoveQueuedMessageInput,
  AgentReplaceMessageQueueInput,
  AgentReplaceMessageQueueResult,
  AgentClearMessageQueueInput,
  AgentClearMessageQueueResult,
  DomiPermissionMode,
  AgentExternalRunSource,
  AgentExecutionControlsUpdate,
  AgentSessionMeta,
  ExitPlanModeResponse,
  NavigateSessionTreeResult,
  SessionTreeResult,
} from '@domi/shared'
import { PiAgentAdapter, cleanupPiRuntimeResources } from './adapters/pi-agent-adapter'
import { AgentEventBus } from './agent-event-bus'
import { AgentOrchestrator } from './agent-orchestrator'
import { getAgentSessionWorkspacePath } from './config-paths'
import { getAgentWorkspaceBySlug } from './agent-workspace-manager'
import { getAgentSessionMeta, updateAgentSessionMeta } from './agent-session-manager'
import { resolveSessionTargetRoot } from './agent-session-target.ts'
import { saveWorkspaceFiles } from './workspace-file-save-service.ts'
import { setAgentActiveChecker, setAgentStopper, setHeadlessAgentRunner } from './agent-headless-runner-registry'
import type { AgentStopSource } from './agent-stop-source.ts'
import { getHeadlessAgentRunTarget } from './agent-headless-run-target'
import { sendAgentStreamComplete } from './agent-completion-payload'
import { AgentExecutionControlsService } from './agent-execution-controls-service.ts'
import { gitPushSessionTrustService } from './execution-policy/git-push-session-trust.ts'
import { askUserService } from './agent-ask-user-service.ts'
import { exitPlanService } from './agent-exit-plan-service.ts'
import { updateSettings } from './settings-service.ts'
import { createAgentStreamIpcForwarder } from './agent-stream-ipc-forwarder'
import { AgentDeferredMessageQueue } from './agent-deferred-message-queue'
import {
  AgentSubmissionDeduplicator,
  assertAgentSubmissionMayProceed,
  buildDeferredAgentRunInput,
  isStaleActiveQueueError,
  routeAgentSubmission,
} from './agent-submit-routing'
import { permissionService } from './agent-permission-service'
import { broadcastWorkActivityChanged, reportWorkActivityPresence } from './work-activity-events.ts'
import { AgentInteractionResponseService } from './agent-interaction-response-service.ts'
import { peekBrowserSessionService } from './browser/browser-module.ts'

// ===== 实例创建 =====

const eventBus = new AgentEventBus()
const adapter = new PiAgentAdapter()
const orchestrator = new AgentOrchestrator(adapter, eventBus)
const streamIpcForwarder = createAgentStreamIpcForwarder()
const interactionResponseService = new AgentInteractionResponseService({
  askUser: askUserService,
  exitPlan: exitPlanService,
  eventBus,
  onChanged: broadcastWorkActivityChanged,
})
gitPushSessionTrustService.subscribe((payload) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(AGENT_IPC_CHANNELS.SESSION_CAPABILITY_GRANTS_CHANGED, payload)
    }
  }
})

const executionControlsService = new AgentExecutionControlsService({
  getSession: getAgentSessionMeta,
  persist: (sessionId, controls) => updateAgentSessionMeta(sessionId, controls),
  isActive: (sessionId) => orchestrator.isActive(sessionId),
  hasPendingExitPlan: (sessionId) => exitPlanService.hasPendingRequest(sessionId),
  rememberExecutionPolicy: (agentExecutionPolicy) => {
    updateSettings({ agentExecutionPolicy })
  },
  rememberWorkflow: (agentWorkflow) => {
    updateSettings({ agentWorkflow })
  },
  updateRuntime: (sessionId, controls) => orchestrator.updateSessionExecutionControls(sessionId, controls),
  clearSessionCapabilities: (sessionId) => gitPushSessionTrustService.clear(sessionId),
})

/** 导出 EventBus 供飞书 Bridge 等外部服务订阅事件 */
export { eventBus as agentEventBus }

// 注册协作子会话 EventBus 阻塞事件监听
import('./agent-collaboration-tools').then(({ registerCollaborationEventBus }) => {
  registerCollaborationEventBus(eventBus)
}).catch(() => { /* collaboration 模块可能未加载 */ })

/**
 * 会话 → webContents 映射
 *
 * EventBus IPC 转发中间件通过此映射找到目标 webContents。
 * runAgent 开始时注册，结束时清理。
 */
const sessionWebContents = new Map<string, WebContents>()

/**
 * 已挂载 destroyed 回收钩子的 webContents 集合。
 *
 * 同一个主窗口 webContents 可能被多次注册（飞书 Bridge 每条消息触发一次 runAgentHeadless），
 * 用 WeakSet 去重避免 once listener 在同一 wc 上累积，触发 MaxListenersExceededWarning。
 */
const wcWithCleanupHook = new WeakSet<WebContents>()

/**
 * 注册 sessionId → webContents 映射，并在 webContents 销毁时自动清理所有相关条目。
 *
 * 仅依赖 finally 块清理无法覆盖窗口关闭、渲染进程崩溃、headless 路径主窗口被替换等
 * webContents 提前销毁的场景——destroyed 事件兜底。
 */
function registerWebContents(sessionId: string, wc: WebContents): void {
  // 同一 sessionId 切换 webContents 时丢弃旧 renderer 的待发送 delta，避免旧窗口定时器迟到。
  const previous = sessionWebContents.get(sessionId)
  if (previous && previous !== wc) streamIpcForwarder.release(sessionId)
  sessionWebContents.set(sessionId, wc)
  if (wcWithCleanupHook.has(wc)) return
  wcWithCleanupHook.add(wc)
  wc.once('destroyed', () => {
    // 单个 wc 可能映射到多个 sessionId（同窗口多 tab），需要清理所有指向它的条目
    for (const [sid, mappedWc] of sessionWebContents) {
      if (mappedWc !== wc) continue
      sessionWebContents.delete(sid)
      streamIpcForwarder.release(sid)
    }
  })
}

function isMainRendererWindow(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false
  const url = win.webContents.getURL()
  if (!url) return false
  if (url.startsWith('data:')) return false
  return !url.includes('window=quick-task')
    && !url.includes('window=voice-dictation')
    && !url.includes('window=detached-preview')
    && !url.includes('window=agent-island')
}

function getMainRendererWebContents(): WebContents | null {
  const win = BrowserWindow.getAllWindows().find(isMainRendererWindow)
  return win && !win.webContents.isDestroyed() ? win.webContents : null
}

/** SEND_MESSAGE 在外部镜像初始化期间也占用 main 启动槽，防止 deferred run 抢跑。 */
const startingAgentSessions = new Set<string>()
const cancelledStartingAgentSessions = new Set<string>()

export function reserveAgentSessionStart(sessionId: string): () => void {
  if (startingAgentSessions.has(sessionId) || isAgentSessionActive(sessionId)) {
    throw new Error('会话正在启动或运行中，请等待当前请求结束后再发送')
  }
  cancelledStartingAgentSessions.delete(sessionId)
  startingAgentSessions.add(sessionId)
  return () => startingAgentSessions.delete(sessionId)
}

export function consumeCancelledAgentSessionStart(sessionId: string): boolean {
  return cancelledStartingAgentSessions.delete(sessionId)
}

const submissionDeduplicator = new AgentSubmissionDeduplicator()
const deferredMessageQueue = new AgentDeferredMessageQueue({
  isActive: (sessionId) => startingAgentSessions.has(sessionId) || orchestrator.isActive(sessionId),
  startRun: async (input) => {
    const webContents = sessionWebContents.get(input.sessionId) ?? getMainRendererWebContents()
    if (!webContents || webContents.isDestroyed()) {
      throw new Error('消息已进入队列，但当前没有可接收运行状态的 renderer')
    }
    await runAgent(buildDeferredAgentRunInput(input as AgentSubmitOrEnqueueInput), webContents)
  },
  onStarted: (input, startedAt) => {
    const webContents = sessionWebContents.get(input.sessionId) ?? getMainRendererWebContents()
    if (webContents && !webContents.isDestroyed()) registerWebContents(input.sessionId, webContents)
    const session = getAgentSessionMeta(input.sessionId)
    eventBus.emit(input.sessionId, {
      kind: 'domi_event',
      event: {
        type: 'agent_queue_message_delivered',
        uuid: input.queueMessageId,
        kind: input.queueKind ?? 'steering',
      },
    })
    eventBus.emit(input.sessionId, {
      kind: 'sdk_message',
      message: {
        type: 'user',
        uuid: input.queueMessageId,
        message: { content: [{ type: 'text', text: input.rawUserMessage ?? input.userMessage }] },
        parent_tool_use_id: null,
        _createdAt: startedAt,
        ...(input.nextTurnAsides?.length ? { _asides: input.nextTurnAsides } : {}),
      } as unknown as import('@domi/shared').SDKMessage,
    })
    eventBus.emit(input.sessionId, {
      kind: 'domi_event',
      event: {
        type: 'external_run_started',
        source: 'deferred_queue',
        sessionId: input.sessionId,
        title: session?.title,
        workspaceId: session?.workspaceId ?? input.workspaceId,
        modelId: input.modelId,
        startedAt,
        ...(session ? { session } : {}),
      },
    })
  },
  onError: (input, error) => {
    console.error(`[Agent deferred queue] 启动失败: sessionId=${input.sessionId}, messageId=${input.queueMessageId}`, error)
  },
})

// ===== EventBus IPC 转发中间件 =====

function sendAgentStreamEvent(wc: WebContents, sessionId: string, payload: AgentStreamPayload): void {
  if (wc.isDestroyed() || sessionWebContents.get(sessionId) !== wc) return
  try {
    wc.send(AGENT_IPC_CHANNELS.STREAM_EVENT, { sessionId, payload } as AgentStreamEvent)
  } catch (err) {
    console.error(`[EventBus] wc.send 失败: sessionId=${sessionId}, payload.kind=${(payload as Record<string, unknown>)?.kind}`, err)
  }
}

function flushAgentStreamDelta(sessionId: string): void {
  streamIpcForwarder.flush(sessionId)
}

function sendAgentStreamError(webContents: WebContents, sessionId: string, error: string): void {
  flushAgentStreamDelta(sessionId)
  webContents.send(AGENT_IPC_CHANNELS.STREAM_ERROR, { sessionId, error })
}

function sendAgentStreamCompleteAfterDelta(
  webContents: WebContents,
  input: Readonly<Pick<AgentSendInput, 'sessionId' | 'triggeredBy'>>,
  details: Parameters<typeof sendAgentStreamComplete>[2] = {},
): void {
  flushAgentStreamDelta(input.sessionId)
  sendAgentStreamComplete(webContents, input, details)
}

function recordWorkActivityRunStarted(sessionId: string, startedAt: number): void {
  try {
    updateAgentSessionMeta(sessionId, {
      workActivityRun: { status: 'running', startedAt },
      workActivityTasks: [],
      workActivityRemovedOutcomeAt: undefined,
      workActivityAcknowledgedOutcomeAt: undefined,
    })
    broadcastWorkActivityChanged()
  } catch { /* 会话可能已删除 */ }
}

function recordWorkActivityRunFinished(
  sessionId: string,
  opts: { startedAt?: number; stoppedByUser?: boolean; backgroundTasksPending?: boolean },
  error?: string,
): void {
  if (opts.backgroundTasksPending) {
    broadcastWorkActivityChanged()
    return
  }
  try {
    const current = getAgentSessionMeta(sessionId)
    const startedAt = opts.startedAt ?? current?.workActivityRun?.startedAt ?? Date.now()
    const status = opts.stoppedByUser ? 'stopped' : error ? 'failed' : 'success'
    updateAgentSessionMeta(sessionId, {
      workActivityRun: {
        status,
        startedAt,
        finishedAt: Date.now(),
        ...(error ? { error } : {}),
      },
    })
    broadcastWorkActivityChanged()
  } catch { /* 会话可能已删除 */ }
}

/** renderer 上报当前可见 Agent 上下文；流式调度只认对话 Tab，通知抑制同时认可其预览 Tab。 */
export function setAgentStreamForegroundSession(
  webContents: WebContents,
  streamSessionId: string | null,
  notificationPresenceSessionId: string | null = streamSessionId,
): void {
  const window = BrowserWindow.fromWebContents(webContents)
  if (!window || !isMainRendererWindow(window)) return
  streamIpcForwarder.setForegroundSession(streamSessionId)
  reportWorkActivityPresence(notificationPresenceSessionId)
}

eventBus.use((sessionId, payload, next) => {
  const wc = sessionWebContents.get(sessionId)
  if (wc && !wc.isDestroyed()) {
    if (payload.kind === 'sdk_delta') {
      streamIpcForwarder.enqueue(sessionId, payload.delta, (delta) => {
        sendAgentStreamEvent(wc, sessionId, { kind: 'sdk_delta', delta })
      })
    } else {
      // assistant final、retry、权限等控制事件必须排在此前 delta 后面到达 renderer。
      flushAgentStreamDelta(sessionId)
      sendAgentStreamEvent(wc, sessionId, payload)
    }
  }
  next()
})

// ===== IPC 薄包装函数 =====

/**
 * 统一响应 AskUser 请求。桌面端与 IM 都走这里，确保首个有效回答胜出，
 * 并通过 EventBus 同步清理其他入口的待回答状态。
 */
export function respondAgentAskUser(
  requestId: string,
  answers: Record<string, string>,
): boolean {
  return interactionResponseService.respondAskUser(requestId, answers)
}

/** 统一响应计划审批，并把 resolved 事件广播给桌面端及所有 Bridge。 */
export function respondAgentExitPlan(response: ExitPlanModeResponse): boolean {
  return interactionResponseService.respondExitPlan(response)
}

/** 把桌面完成的权限确认同步给所有会话入口；IM 仍不具备批准权限。 */
export function notifyAgentPermissionResolved(
  sessionId: string,
  requestId: string,
  behavior: 'allow' | 'deny',
): void {
  eventBus.emit(sessionId, {
    kind: 'domi_event',
    event: { type: 'permission_resolved', requestId, behavior },
  })
}

/**
 * 运行 Agent 并流式推送事件到渲染进程
 *
 * 注册 webContents 到 EventBus 映射，委托给 Orchestrator。
 */
export async function runAgent(
  input: AgentSendInput,
  webContents: WebContents,
): Promise<void> {
  // 更新 webContents 映射（允许覆盖 — 由 orchestrator.activeSessions 处理真正的并发保护）
  registerWebContents(input.sessionId, webContents)
  // 开始新一轮执行时清除完成提醒，并显式恢复归档会话。
  // 不只依赖 metadata 的隐式 autoUnarchive，确保重新对话后持久化状态立即回到活跃列表。
  try {
    updateAgentSessionMeta(input.sessionId, {
      completedButUnconfirmed: false,
      archived: false,
    })
  } catch { /* 新会话可能尚未写入索引 */ }
  // 自动任务会话"毕业"：用户手动发消息（非定时触发）即视为接管，标记后该会话回到普通项目列表，
  // 调度器也不再复用它注入新的定时运行。
  if (input.triggeredBy !== 'automation') {
    try {
      const meta = getAgentSessionMeta(input.sessionId)
      if (meta?.sourceAutomationId && !meta.automationGraduated) {
        updateAgentSessionMeta(input.sessionId, { automationGraduated: true })
        // 向渲染进程发送毕业事件，触发 toast 提示
        eventBus.emit(input.sessionId, {
          kind: 'domi_event',
          event: { type: 'automation_graduated' },
        })
      }
    } catch { /* 新会话可能尚未写入索引 */ }
  }
  let terminalError: string | undefined
  let workActivityRunStartedAt: number | undefined
  let workActivityCompletionHandled = false
  try {
    await orchestrator.sendMessage(input, {
      onError: (error) => {
        terminalError = error
        if (!webContents.isDestroyed()) {
          sendAgentStreamError(webContents, input.sessionId, error)
        }
      },
      onComplete: (opts) => {
        recordWorkActivityRunFinished(input.sessionId, {
          startedAt: opts?.startedAt,
          stoppedByUser: opts?.stoppedByUser,
          backgroundTasksPending: opts?.backgroundTasksPending,
        }, terminalError)
        workActivityCompletionHandled = true
        if (!webContents.isDestroyed()) {
          sendAgentStreamCompleteAfterDelta(webContents, input, {
            stoppedByUser: opts?.stoppedByUser ?? false,
            startedAt: opts?.startedAt,
            resultSubtype: opts?.resultSubtype,
            resultErrors: opts?.resultErrors,
            backgroundTasksPending: opts?.backgroundTasksPending,
          })
        }
        deferredMessageQueue.onRunComplete(
          input.sessionId,
          opts?.stoppedByUser === true,
          opts?.backgroundTasksPending === true,
        )
      },
      onRunStarted: ({ startedAt }) => {
        workActivityRunStartedAt = startedAt
        recordWorkActivityRunStarted(input.sessionId, startedAt)
      },
      onWorkActivityChanged: broadcastWorkActivityChanged,
      onTitleUpdated: (title) => {
        eventBus.emit(input.sessionId, {
          kind: 'domi_event',
          event: { type: 'title_updated', title },
        })
        if (!webContents.isDestroyed()) {
          webContents.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: input.sessionId,
            title,
          })
        }
      },
    })
  } catch (err) {
    console.error('[Agent 服务] runAgent 未处理异常:', err)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    if (workActivityRunStartedAt != null && !workActivityCompletionHandled) {
      recordWorkActivityRunFinished(input.sessionId, { startedAt: workActivityRunStartedAt }, errorMessage)
    }
    if (!webContents.isDestroyed()) {
      sendAgentStreamError(webContents, input.sessionId, errorMessage)
      sendAgentStreamCompleteAfterDelta(webContents, input, {
        stoppedByUser: false,
      })
    }
    if (!workActivityCompletionHandled) {
      deferredMessageQueue.onRunComplete(input.sessionId, false, false)
    }
  } finally {
    if (!orchestrator.isActive(input.sessionId)) {
      void peekBrowserSessionService()?.closeTemporaryOwner(input.sessionId)
    }
    // 仅在 orchestrator 已完成此会话时清理映射
    // 避免被拒绝的请求误删仍在运行的会话映射
    if (!orchestrator.isActive(input.sessionId)) {
      sessionWebContents.delete(input.sessionId)
      streamIpcForwarder.release(input.sessionId)
    }
  }
}

/**
 * 无渲染进程的 Agent 运行（供飞书 Bridge 等外部调用方使用）
 *
 * 如果桌面窗口存在，同时注册 webContents 以便事件同步到桌面端 UI。
 * 事件同时通过 EventBus listeners 分发给飞书 Bridge。
 */
export interface AgentHeadlessCompletion {
  stoppedByUser?: boolean
  startedAt?: number
  resultSubtype?: string
  resultErrors?: string[]
  backgroundTasksPending?: boolean
}

export async function runAgentHeadless(
  input: AgentSendInput,
  callbacks: {
    onError: (error: string) => void
    onComplete: (opts?: AgentHeadlessCompletion) => void
    onTitleUpdated: (title: string) => void
    source?: AgentExternalRunSource
    originSessionId?: string
    activationToken?: string
  },
): Promise<void> {
  // 委派子会话优先回到父会话所在 renderer，外部无界面运行才回退任意主窗口。
  const wc = getHeadlessAgentRunTarget(
    sessionWebContents,
    callbacks.originSessionId,
    getMainRendererWebContents,
  )
  const runInput: AgentSendInput = input.startedAt != null ? input : { ...input, startedAt: Date.now() }
  const startedAt = runInput.startedAt!
  if (wc) {
    registerWebContents(runInput.sessionId, wc)
  }

  let terminalError: string | undefined
  let workActivityRunStartedAt: number | undefined
  let workActivityCompletionHandled = false
  try {
    await orchestrator.sendMessage(runInput, {
      onError: (error) => {
        terminalError = error
        callbacks.onError(error)
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          sendAgentStreamError(wc, runInput.sessionId, error)
        }
      },
      onComplete: (opts) => {
        recordWorkActivityRunFinished(runInput.sessionId, {
          startedAt: opts?.startedAt,
          stoppedByUser: opts?.stoppedByUser,
          backgroundTasksPending: opts?.backgroundTasksPending,
        }, terminalError)
        workActivityCompletionHandled = true
        callbacks.onComplete(opts)
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          sendAgentStreamCompleteAfterDelta(wc, runInput, {
            stoppedByUser: opts?.stoppedByUser ?? false,
            startedAt: opts?.startedAt,
            resultSubtype: opts?.resultSubtype,
            resultErrors: opts?.resultErrors,
            backgroundTasksPending: opts?.backgroundTasksPending,
          })
        }
        deferredMessageQueue.onRunComplete(
          runInput.sessionId,
          opts?.stoppedByUser === true,
          opts?.backgroundTasksPending === true,
        )
      },
      onTitleUpdated: (title) => {
        callbacks.onTitleUpdated(title)
        eventBus.emit(runInput.sessionId, {
          kind: 'domi_event',
          event: { type: 'title_updated', title },
        })
        // 同步到渲染进程
        if (wc && !wc.isDestroyed()) {
          wc.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: runInput.sessionId,
            title,
          })
        }
      },
      onRunStarted: ({ startedAt: persistedStartedAt }) => {
        workActivityRunStartedAt = persistedStartedAt
        recordWorkActivityRunStarted(runInput.sessionId, persistedStartedAt)
        const session = getAgentSessionMeta(runInput.sessionId)
        eventBus.emit(runInput.sessionId, {
          kind: 'domi_event',
          event: {
            type: 'external_run_started',
            source: callbacks.source ?? 'bridge',
            sessionId: runInput.sessionId,
            title: session?.title,
            workspaceId: runInput.workspaceId ?? session?.workspaceId,
            modelId: runInput.modelId,
            startedAt: persistedStartedAt,
            ...(callbacks.originSessionId ? { originSessionId: callbacks.originSessionId } : {}),
            ...(callbacks.activationToken ? { activationToken: callbacks.activationToken } : {}),
            ...(session ? { session } : {}),
          },
        })
      },
      onWorkActivityChanged: broadcastWorkActivityChanged,
    })
  } catch (err) {
    console.error('[Agent 服务] runAgentHeadless 未处理异常:', err)
    const errorMessage = err instanceof Error ? err.message : '未知错误'
    if (workActivityRunStartedAt != null && !workActivityCompletionHandled) {
      recordWorkActivityRunFinished(runInput.sessionId, { startedAt: workActivityRunStartedAt }, errorMessage)
    }
    callbacks.onError(errorMessage)
    callbacks.onComplete()
    if (wc && !wc.isDestroyed()) {
      sendAgentStreamError(wc, runInput.sessionId, errorMessage)
      sendAgentStreamCompleteAfterDelta(wc, runInput, {
        stoppedByUser: false,
        startedAt,
      })
    }
    if (!workActivityCompletionHandled) {
      deferredMessageQueue.onRunComplete(runInput.sessionId, false, false)
    }
  } finally {
    if (!orchestrator.isActive(runInput.sessionId)) {
      void peekBrowserSessionService()?.closeTemporaryOwner(runInput.sessionId)
      sessionWebContents.delete(runInput.sessionId)
      streamIpcForwarder.release(runInput.sessionId)
    }
  }
}

/**
 * 生成 Agent 会话标题
 */
export async function generateAgentTitle(input: AgentGenerateTitleInput): Promise<string | null> {
  return orchestrator.generateTitle(input)
}

/**
 * 中止指定会话的 Agent 执行
 */
export function stopAgent(sessionId: string, source: AgentStopSource = 'unknown'): void {
  flushAgentStreamDelta(sessionId)
  if (startingAgentSessions.has(sessionId)) cancelledStartingAgentSessions.add(sessionId)
  const deferred = deferredMessageQueue.clear(sessionId)
  for (const message of deferred) {
    submissionDeduplicator.forget(sessionId, message.queueMessageId)
  }
  orchestrator.stop(sessionId, source)
}

/** 跳过当前自动重试等待，立即执行已经安排的恢复。 */
export function retryAgentNow(sessionId: string): Promise<boolean> {
  return orchestrator.retryNow(sessionId)
}

setHeadlessAgentRunner(runAgentHeadless)
setAgentStopper(stopAgent)
setAgentActiveChecker(isAgentSessionActive)

/** 只读预览回退将影响的受控文件。 */
export async function previewAgentSessionRewind(
  sessionId: string,
  assistantMessageUuid: string,
): Promise<import('@domi/shared').RewindSessionPreview> {
  return orchestrator.previewRewindSession(sessionId, assistantMessageUuid)
}

/**
 * 快照回退：回退到指定消息点，恢复文件 + 截断对话
 */
export async function rewindAgentSession(
  sessionId: string,
  assistantMessageUuid: string,
): Promise<import('@domi/shared').RewindSessionResult> {
  return orchestrator.rewindSession(sessionId, assistantMessageUuid)
}

export async function getAgentRewindUndoState(
  sessionId: string,
): Promise<import('@domi/shared').RewindUndoState> {
  return orchestrator.getRewindUndoState(sessionId)
}

export async function undoAgentSessionRewind(
  sessionId: string,
): Promise<import('@domi/shared').UndoRewindSessionResult> {
  return orchestrator.undoRewindSession(sessionId)
}

export function getAgentSessionTree(sessionId: string): SessionTreeResult {
  return orchestrator.getSessionTree(sessionId)
}

export async function navigateAgentSessionTree(
  sessionId: string,
  entryId: string,
): Promise<NavigateSessionTreeResult> {
  return orchestrator.navigateSessionTree(sessionId, entryId)
}

/**
 * 检查指定会话是否正在运行
 */
export function isAgentSessionActive(sessionId: string): boolean {
  return startingAgentSessions.has(sessionId)
    || orchestrator.isActive(sessionId)
    || deferredMessageQueue.hasPending(sessionId)
    || deferredMessageQueue.isDispatching(sessionId)
}

/** 是否存在任意运行中或已被 main 接管等待续跑的 Agent。 */
export function hasActiveAgentSessions(): boolean {
  return startingAgentSessions.size > 0
    || orchestrator.hasActiveSessions()
    || deferredMessageQueue.hasAnyWork()
}

/** 中止所有活跃的 Agent 会话（应用退出时调用） */
export function stopAllAgents(): void {
  for (const message of deferredMessageQueue.clearAll()) {
    submissionDeduplicator.forget(message.sessionId, message.queueMessageId)
  }
  startingAgentSessions.clear()
  cancelledStartingAgentSessions.clear()
  orchestrator.stopAll()
}

/** 退出前释放 Pi runtime 资源。 */
export function cleanupAgentRuntimeResources(): void {
  cleanupPiRuntimeResources()
}

/**
 * 运行中动态切换会话的权限模式
 *
 * 同时更新 Domi 侧（canUseTool 动态读取）和 SDK 侧（query.setPermissionMode）。
 */
export async function updateAgentPermissionMode(sessionId: string, mode: DomiPermissionMode): Promise<void> {
  await orchestrator.updateSessionPermissionMode(sessionId, mode)
}

export async function updateSessionExecutionControls(
  sessionId: string,
  controls: AgentExecutionControlsUpdate,
): Promise<AgentSessionMeta> {
  return executionControlsService.updateSessionExecutionControls(sessionId, controls)
}

// ===== 流式追加消息 =====

/**
 * 在 Agent 流式中追加发送消息
 *
 * 使用 'now' 优先级立即注入 SDK 并持久化。
 */
export async function queueAgentMessage(
  input: AgentQueueMessageInput,
  _webContents: WebContents,
): Promise<string> {
  return orchestrator.queueMessage(
    input.sessionId,
    input.userMessage,
    input.rawUserMessage,
    undefined,
    input.uuid,
    { interrupt: input.interrupt, kind: input.kind },
    input.mentionedSkills,
    input.mentionedMcpServers,
    input.mentionedSessionIds,
    input.mentionedTodoIds,
    input.mentionedCalendarEventIds,
    input.nextTurnAsides,
  )
}

/** main 基于实时 run 状态原子决定注入当前 Pi query 或接管为 deferred queue。 */
export async function submitOrEnqueueAgentMessage(
  input: AgentSubmitOrEnqueueInput,
  webContents: WebContents,
): Promise<AgentSubmitOrEnqueueResult> {
  registerWebContents(input.sessionId, webContents)
  return submissionDeduplicator.submit(input, async () => {
    const meta = getAgentSessionMeta(input.sessionId)
    assertAgentSubmissionMayProceed({
      rewinding: orchestrator.isRewinding(input.sessionId),
      stopped: orchestrator.isStopping(input.sessionId)
        || cancelledStartingAgentSessions.has(input.sessionId)
        || meta?.stoppedByUser === true,
      blockingPermission: permissionService.hasBlockingRequest(input.sessionId),
      delegationCheckoutReleased: meta?.delegationCheckoutReleasedAt !== undefined,
      sessionWorkspaceId: meta?.workspaceId,
      requestedWorkspaceId: input.workspaceId,
    })

    const result = await routeAgentSubmission(input, {
      isActive: (sessionId) => orchestrator.isActive(sessionId),
      inject: async (submission) => {
        await queueAgentMessage({
          sessionId: submission.sessionId,
          userMessage: submission.userMessage,
          rawUserMessage: submission.rawUserMessage,
          uuid: submission.queueMessageId,
          interrupt: submission.interrupt,
          kind: submission.queueKind,
          nextTurnAsides: submission.nextTurnAsides,
          mentionedSkills: submission.mentionedSkills,
          mentionedMcpServers: submission.mentionedMcpServers,
          mentionedSessionIds: submission.mentionedSessionIds,
          mentionedTodoIds: submission.mentionedTodoIds,
          mentionedCalendarEventIds: submission.mentionedCalendarEventIds,
        }, webContents)
      },
      beforeEnqueue: () => {
        const latestMeta = getAgentSessionMeta(input.sessionId)
        assertAgentSubmissionMayProceed({
          rewinding: orchestrator.isRewinding(input.sessionId),
          stopped: orchestrator.isStopping(input.sessionId)
            || cancelledStartingAgentSessions.has(input.sessionId)
            || latestMeta?.stoppedByUser === true,
          blockingPermission: permissionService.hasBlockingRequest(input.sessionId),
          delegationCheckoutReleased: latestMeta?.delegationCheckoutReleasedAt !== undefined,
          sessionWorkspaceId: latestMeta?.workspaceId,
          requestedWorkspaceId: input.workspaceId,
        })
      },
      enqueue: (submission) => deferredMessageQueue.enqueue(submission),
    })
    if (result.disposition === 'queued') {
      return {
        ...result,
        queueState: deferredMessageQueue.isDispatching(input.sessionId, input.queueMessageId)
          ? 'started' as const
          : 'waiting' as const,
      }
    }
    return result
  })
}

export function cancelDeferredAgentMessage(input: AgentQueuedMessageControlInput): boolean {
  const cancelled = deferredMessageQueue.cancel(input)
  if (cancelled) submissionDeduplicator.forget(input.sessionId, input.messageId)
  return cancelled
}

export function moveDeferredAgentMessage(input: AgentMoveQueuedMessageInput): boolean {
  return deferredMessageQueue.move(input)
}

export async function replaceAgentMessageQueue(
  input: AgentReplaceMessageQueueInput,
): Promise<AgentReplaceMessageQueueResult> {
  return { messageUuids: await orchestrator.replaceMessageQueue(input.sessionId, input.messages) }
}

export async function clearAgentMessageQueue(
  input: AgentClearMessageQueueInput,
): Promise<AgentClearMessageQueueResult> {
  const deferred = deferredMessageQueue.clear(input.sessionId)
  for (const message of deferred) {
    submissionDeduplicator.forget(input.sessionId, message.queueMessageId)
  }
  let native: AgentClearMessageQueueResult = { steering: [], followUp: [] }
  try {
    native = await orchestrator.clearMessageQueue(input.sessionId, { abort: input.abort })
  } catch (error) {
    if (deferred.length === 0 || !isStaleActiveQueueError(error)) throw error
  }
  for (const message of deferred) {
    const kind = message.queueKind ?? 'steering'
    native[kind].push({
      uuid: message.queueMessageId,
      kind,
      rawUserMessage: message.rawUserMessage ?? message.userMessage,
    })
  }
  return native
}

// ===== 文件操作 =====

/**
 * 保存文件到 Agent session 工作目录
 *
 * 将 base64 编码的文件写入当前会话的私有工作目录，供 Agent 通过授权的附加目录读取。
 */
export function saveFilesToAgentSession(input: AgentSaveFilesInput): AgentSavedFile[] {
  const sessionDir = getAgentSessionWorkspacePath(input.workspaceSlug, input.sessionId)
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const file of input.files) {
    let targetPath = join(sessionDir, file.filename)

    // 防止同名文件覆盖
    if (usedPaths.has(targetPath) || existsSync(targetPath)) {
      const dotIdx = file.filename.lastIndexOf('.')
      const baseName = dotIdx > 0 ? file.filename.slice(0, dotIdx) : file.filename
      const ext = dotIdx > 0 ? file.filename.slice(dotIdx) : ''
      let counter = 1
      let candidate = join(sessionDir, `${baseName}-${counter}${ext}`)
      while (usedPaths.has(candidate) || existsSync(candidate)) {
        counter++
        candidate = join(sessionDir, `${baseName}-${counter}${ext}`)
      }
      targetPath = candidate
    }
    usedPaths.add(targetPath)

    mkdirSync(dirname(targetPath), { recursive: true })

    // 防御性检查：base64 字符串长度估算是否超 100MB 限制
    // base64 编码膨胀率约 4/3，data.length * 0.75 ≈ 原始字节数
    if (file.data.length * 0.75 > MAX_ATTACHMENT_SIZE) {
      console.warn(`[Agent 服务] 文件超过 100MB 限制，跳过: ${file.filename} (预估 ${(file.data.length * 0.75 / 1024 / 1024).toFixed(1)}MB)`)
      continue
    }

    const buffer = Buffer.from(file.data, 'base64')
    writeFileSync(targetPath, buffer)

    const actualFilename = targetPath.slice(sessionDir.length + 1)
    results.push({ filename: actualFilename, targetPath })
    console.log(`[Agent 服务] 文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}

/** 保存文件到会话当前 Session Target 根目录。 */
export async function saveFilesToWorkspaceFiles(
  input: AgentSaveWorkspaceFilesInput,
): Promise<AgentSavedFile[]> {
  return saveWorkspaceFiles(input, {
    getSession: getAgentSessionMeta,
    getWorkspaceBySlug: getAgentWorkspaceBySlug,
    resolveTargetRoot: resolveSessionTargetRoot,
  })
}

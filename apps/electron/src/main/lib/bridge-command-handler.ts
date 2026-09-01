/**
 * 通用 Bridge 命令处理器
 *
 * 为微信、钉钉等平台提供统一的斜杠命令和 Agent 消息路由。
 * 各平台通过 BridgePlatformAdapter 接入，共用文本、阶段反馈和可选图片发送能力。
 *
 * 飞书 Bridge 使用独立的卡片消息格式，暂不接入此模块。
 */

import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { AgentStreamPayload } from '@domi/shared'
import { AGENT_IPC_CHANNELS } from '@domi/shared'
import { createAgentSession, listAgentSessions, getAgentSessionMeta } from './agent-session-manager'
import {
  listAgentWorkspacesByUpdatedAt,
  getAgentWorkspace,
  getProjectFilesPath,
  getWorkspaceCapabilities,
} from './agent-workspace-manager'
import {
  runAgentHeadless,
  agentEventBus,
  stopAgent,
  isAgentSessionActive,
  respondAgentAskUser,
  respondAgentExitPlan,
} from './agent-service'
import { getSettings, resolveAgentRemoteDefaultWorkspaceId } from './settings-service'
import { bindProductionBridgeSessionTargetForLaunch } from './bridge-session-target.ts'
import { buildAttachedFilesBlock, buildSessionFileTree, buildFileTree } from './bridge-attachment-utils'
import {
  listSwitchableChannels,
  getEnabledModels,
  resolveChannelByIndex,
  resolveModelByIndex,
} from './bridge-model-utils'
import {
  appendBridgeRunMetadata,
  applyResolvedBridgeModel,
  formatBridgeProcessingMessage,
  formatBridgeRuntimeStatusLines,
  type BridgeRunMetadata,
} from './bridge-run-metadata'
import { resolveBridgeRunMetadata } from './bridge-run-metadata-service'
import type { BridgeChatBindingStore } from './bridge-binding-store'
import { filterExistingBridgeBindings } from './bridge-binding-store'
import {
  collectGeneratedImageToolUseIds,
  extractFinalAssistantText,
  extractGeneratedImagesFromToolResults,
  type BridgeGeneratedImage,
} from './bridge-agent-message-utils'
import { redactSensitiveLogText, redactSensitiveLogValue } from './bridge-log-redaction'
import { BridgeProgressFeedback } from './bridge-progress-feedback'
import { formatBridgeHelpMessage } from './bridge-help-message'
import {
  BridgeInteractionCoordinator,
  formatBridgeInteractionText,
  type BridgeInteractionResult,
  type BridgeInteractionView,
} from './bridge-interaction-coordinator'

// ===== 接口定义 =====

/** 平台适配器 — 各 Bridge 只需实现此接口 */
export interface BridgeDeliveryAttempt {
  /** 同一逻辑消息跨重试保持稳定，平台可据此提供幂等发送 ID。 */
  deliveryId: string
  attempt: number
}

export interface BridgePlatformAdapter {
  /** 发送纯文本回复。meta 是平台专属的上下文数据（如微信的 contextToken） */
  sendText(chatId: string, text: string, meta?: unknown, delivery?: BridgeDeliveryAttempt): Promise<void>
  /** 发送 Agent 生成的图片；未实现的平台仍可保持纯文本回复。 */
  sendImage?(chatId: string, image: BridgeGeneratedImage, meta?: unknown, delivery?: BridgeDeliveryAttempt): Promise<void>
  /** 平台可将鉴权、参数等确定性错误标记为不可重试。 */
  isRetryableDeliveryError?(error: unknown): boolean
}

/** 已保存到磁盘的附件引用，由各 Bridge 预处理后传入 handler */
export interface BridgeAttachment {
  /** 附件绝对路径 */
  absolutePath: string
  /** 在 <attached_files> 中显示的标签 */
  label: string
  /** 附件类型，用于未来扩展路由（当前仅信息） */
  kind: 'image' | 'file'
}

/** 命令处理器配置 */
export interface BridgeCommandHandlerConfig {
  /** 平台名称，用于日志（如 '微信', '钉钉'） */
  platformName: string
  /** 平台适配器 */
  adapter: BridgePlatformAdapter
  /** 获取默认工作区 ID */
  getDefaultWorkspaceId?: () => string | undefined
  /** 工作区切换后的回调 */
  onWorkspaceSwitched?: (workspaceId: string) => void
  /** 成功切换会话上下文后的回调，用于清理仍属于旧会话的暂存附件 */
  onSessionContextChanged?: (chatId: string) => void
  /** 可选持久化存储：用于跨应用重启恢复 chatId → sessionId 绑定 */
  bindingStore?: BridgeChatBindingStore
  /** 最终交付单次失败后的重试等待；测试可注入 0ms。 */
  deliveryRetryDelaysMs?: readonly number[]
  /** 最终交付失败后的内存补发间隔；仅在 Bridge 仍存活或重新订阅后生效。 */
  deliveryRecoveryDelayMs?: number
  /** 未交付结果在内存中的最长保留时间。 */
  pendingDeliveryTtlMs?: number
}

/** 通用聊天绑定 */
export interface BridgeChatBinding {
  chatId: string
  sessionId: string
  workspaceId: string
  channelId: string
  modelId?: string
}

/** Agent 回复缓冲 */
interface SessionBuffer {
  generation: number
  text: string
  images: BridgeGeneratedImage[]
  imageIdentities: Set<string>
  generatedImageToolUseIds: Set<string>
  progress: BridgeProgressFeedback
  runMetadata: BridgeRunMetadata
  chatId: string
  contextData: unknown
  startedAt: number
}

const DEFAULT_DELIVERY_RETRY_DELAYS_MS = [500, 1_500] as const
const DEFAULT_DELIVERY_RECOVERY_DELAY_MS = 10_000
const DEFAULT_PENDING_DELIVERY_TTL_MS = 5 * 60_000

interface PendingFinalDelivery {
  id: string
  sessionId: string
  generation: number
  chatId: string
  contextData: unknown
  text: string
  images: BridgeGeneratedImage[]
  textDelivered: boolean
  textTerminalFailure: boolean
  uploadNoticeDelivered: boolean
  uploadNoticeTerminalFailure: boolean
  imageDelivered: boolean[]
  imageTerminalFailure: boolean[]
  failureReportDelivered: boolean
  expiresAt: number
  recoveryTimer: ReturnType<typeof setTimeout> | null
  delivering: boolean
}

// ===== 命令处理器实现 =====

export class BridgeCommandHandler {
  private readonly config: BridgeCommandHandlerConfig
  private readonly log: (msg: string) => void

  /** chatId → 聊天绑定 */
  private chatBindings = new Map<string, BridgeChatBinding>()
  /** sessionId → chatId（反向索引） */
  private sessionToChat = new Map<string, string>()
  /** sessionId → 回复缓冲 */
  private sessionBuffers = new Map<string, SessionBuffer>()
  /** sessionId → 当前运行 generation；每轮递增，隔离迟到完成信号。 */
  private runGenerations = new Map<string, number>()
  /** 尚未完全投递的终态结果，Bridge 短暂断开后可在 TTL 内补发。 */
  private pendingFinalDeliveries = new Map<string, PendingFinalDelivery>()
  /** EventBus 取消订阅 */
  private eventBusUnsubscribe: (() => void) | null = null
  private bridgeAvailable = false
  private readonly interactions: BridgeInteractionCoordinator

  constructor(config: BridgeCommandHandlerConfig) {
    this.config = config
    this.log = (msg: string) => console.log(`[${config.platformName} Bridge] ${redactSensitiveLogText(msg)}`)
    this.interactions = new BridgeInteractionCoordinator({
      respondAskUser: respondAgentAskUser,
      respondExitPlan: respondAgentExitPlan,
      onTimeout: (sessionId, chatId) => {
        const contextData = this.sessionBuffers.get(sessionId)?.contextData
        void this.send(chatId, '⌛ 等待确认已超时，本轮任务已停止。', contextData).catch((error) => {
          console.error(`[${this.config.platformName} Bridge] 发送确认超时提示失败:`, redactSensitiveLogValue(error))
        })
        this.clearSessionBuffer(sessionId)
        void stopAgent(sessionId, 'bridge-command')
      },
    })
    this.loadPersistedBindings()
  }

  // ===== 公开 API =====

  /** 处理收到的消息（自动区分命令 vs 普通消息） */
  async handleIncomingMessage(
    chatId: string,
    text: string,
    contextData?: unknown,
    attachments?: BridgeAttachment[],
  ): Promise<void> {
    const command = text.trimStart().split(/\s+/, 1)[0]?.toLowerCase()
    const isSlashCommand = command?.startsWith('/') === true
    const isControlCommand = ['/stop', '/s', '/now', '/help', '/h'].includes(command ?? '')
    if (isSlashCommand && !isControlCommand && command !== '/answer') {
      const pendingView = this.interactions.getPendingView(chatId)
      if (pendingView) {
        await this.send(
          chatId,
          `当前任务正在等待确认，请先回答、使用 /now 重看问题，或用 /stop 停止。\n\n${formatBridgeInteractionText(pendingView)}`,
          contextData,
        )
        return
      }
    }
    if (!isControlCommand) {
      const interactionResult = this.interactions.handleText(chatId, text)
      if (interactionResult.handled) {
        await this.sendInteractionResult(chatId, contextData, interactionResult)
        return
      }
    }

    if (text.trimStart().startsWith('/')) {
      // 命令消息不携带附件（附件由 Bridge 缓冲，等普通消息触发）
      await this.handleCommand(chatId, text, contextData)
    } else {
      await this.handleUserMessage(chatId, text, contextData, attachments)
    }
  }

  /**
   * 获取或自动创建 chatId 对应的 binding
   * 用于 Bridge 在保存图片/文件前预先拿到 sessionId 和 workspaceId
   * 如果未配置 Agent 渠道，返回 null
   */
  ensureBinding(chatId: string): BridgeChatBinding | null {
    const existing = this.getValidBinding(chatId)
    if (existing) return existing

    const settings = getSettings()
    const channelId = settings.agentChannelId
    if (!channelId) return null

    const workspaceId = this.resolveValidWorkspaceId(resolveAgentRemoteDefaultWorkspaceId(settings))

    const session = createAgentSession(
      `${this.config.platformName}会话`,
      channelId,
      workspaceId || undefined,
      undefined,
    )

    const binding: BridgeChatBinding = {
      chatId,
      sessionId: session.id,
      workspaceId,
      channelId,
      modelId: settings.agentModelId ?? undefined,
    }
    this.chatBindings.set(chatId, binding)
    this.sessionToChat.set(session.id, chatId)
    this.saveBindings()
    this.log(`为 ${chatId.slice(0, 8)}... 创建会话: ${session.id.slice(0, 8)}`)
    this.notifySessionCreated(session.id, session.title)
    return binding
  }

  /** 检查指定 chatId 的 session 是否正在运行 */
  isSessionActive(chatId: string): boolean {
    const binding = this.getValidBinding(chatId)
    if (!binding) return false
    return isAgentSessionActive(binding.sessionId)
  }

  /** 订阅 Agent EventBus（Bridge 连接建立后调用） */
  subscribe(): void {
    this.bridgeAvailable = true
    this.eventBusUnsubscribe?.()
    this.eventBusUnsubscribe = agentEventBus.on((sessionId, payload) => {
      this.handleAgentPayload(sessionId, payload)
    })
    this.resumePendingFinalDeliveries()
  }

  /** Bridge 断开时暂停交付；活动运行在 TTL 内保留最小事件订阅以收集终态。 */
  unsubscribe(): void {
    this.bridgeAvailable = false
    for (const buffer of this.sessionBuffers.values()) {
      buffer.progress.stop()
    }
    this.interactions.clearAll()
    // 活动运行仍需继续收集最终 assistant/tool_result/result；onComplete 也会走同一终态。
    // 没有活动运行时立即释放订阅，避免 Bridge 关闭后留下常驻监听器。
    this.releaseDisconnectedEventSubscriptionIfIdle()
  }

  /** 获取聊天绑定；已失效的会话或工作区绑定会被同步清除。 */
  getBinding(chatId: string): BridgeChatBinding | undefined {
    return this.getValidBinding(chatId)
  }

  /**
   * 在删除工作区前清理所有指向该工作区或其即将删除会话的绑定。
   * 返回实际删除的绑定数，调用方无需分别处理内存和持久化存储。
   */
  removeBindingsForDeletedWorkspace(workspaceId: string, affectedSessionIds: Iterable<string>): number {
    const sessionIds = new Set(affectedSessionIds)
    let removedCount = 0

    for (const [chatId, binding] of this.chatBindings) {
      if (binding.workspaceId !== workspaceId && !sessionIds.has(binding.sessionId)) continue
      this.removeBinding(chatId, binding)
      removedCount += 1
    }

    if (removedCount > 0) this.saveBindings()
    return removedCount
  }

  /** 明确登出或永久关闭时丢弃运行与补发状态，但保留聊天绑定。 */
  discardTransientState(): void {
    for (const sessionId of Array.from(this.sessionBuffers.keys())) {
      this.clearSessionBuffer(sessionId)
    }
    for (const delivery of this.pendingFinalDeliveries.values()) {
      if (delivery.recoveryTimer) clearTimeout(delivery.recoveryTimer)
    }
    this.pendingFinalDeliveries.clear()
    this.interactions.clearAll()
    this.releaseDisconnectedEventSubscriptionIfIdle()
  }

  /** 清理所有状态 */
  clear(): void {
    this.chatBindings.clear()
    this.sessionToChat.clear()
    this.discardTransientState()
    this.runGenerations.clear()
    this.saveBindings()
  }

  private loadPersistedBindings(): void {
    const bindings = this.config.bindingStore?.load()
    if (!bindings || bindings.length === 0) return

    const existingBindings = filterExistingBridgeBindings(bindings, (sessionId) => Boolean(getAgentSessionMeta(sessionId)))
      .filter((binding) => this.isBindingValid(binding))
    for (const binding of existingBindings) {
      this.chatBindings.set(binding.chatId, binding)
      this.sessionToChat.set(binding.sessionId, binding.chatId)
    }

    if (existingBindings.length !== bindings.length) {
      this.config.bindingStore?.save(existingBindings)
    }
    if (existingBindings.length > 0) {
      this.log(`已恢复 ${existingBindings.length} 个聊天绑定`)
    }
  }

  private saveBindings(): void {
    this.config.bindingStore?.save(Array.from(this.chatBindings.values()))
  }

  private resolveValidWorkspaceId(fallbackWorkspaceId?: string): string {
    const platformWorkspaceId = this.config.getDefaultWorkspaceId?.()
    if (platformWorkspaceId && getAgentWorkspace(platformWorkspaceId)) return platformWorkspaceId
    if (fallbackWorkspaceId && getAgentWorkspace(fallbackWorkspaceId)) return fallbackWorkspaceId
    return listAgentWorkspacesByUpdatedAt()[0]?.id ?? ''
  }

  private isBindingValid(binding: BridgeChatBinding): boolean {
    const session = getAgentSessionMeta(binding.sessionId)
    if (!session) return false

    const sessionWorkspaceId = session.workspaceId ?? ''
    if (sessionWorkspaceId !== binding.workspaceId) return false
    return !binding.workspaceId || Boolean(getAgentWorkspace(binding.workspaceId))
  }

  private removeBinding(chatId: string, binding: BridgeChatBinding): void {
    this.chatBindings.delete(chatId)
    if (this.sessionToChat.get(binding.sessionId) === chatId) {
      this.sessionToChat.delete(binding.sessionId)
    }
    this.clearSessionBuffer(binding.sessionId)
  }

  private getValidBinding(chatId: string): BridgeChatBinding | undefined {
    const binding = this.chatBindings.get(chatId)
    if (!binding) return undefined
    if (this.isBindingValid(binding)) return binding

    this.removeBinding(chatId, binding)
    this.saveBindings()
    this.log(`移除已失效绑定: ${chatId.slice(0, 8)}...`)
    return undefined
  }

  // ===== 命令路由 =====

  private async handleCommand(chatId: string, text: string, contextData?: unknown): Promise<void> {
    const [command, ...args] = text.split(/\s+/)
    const arg = args.join(' ').trim()

    switch (command?.toLowerCase()) {
      case '/help':
      case '/h':
        await this.sendHelp(chatId, contextData)
        break

      case '/new':
      case '/n':
        await this.createNewSession(chatId, arg || undefined, contextData)
        break

      case '/list':
      case '/ls':
        await this.handleListCommand(chatId, contextData)
        break

      case '/stop':
      case '/s':
        await this.handleStopCommand(chatId, contextData)
        break

      case '/switch':
      case '/sw':
        if (!arg) {
          await this.send(chatId, '用法: /switch <序号>（先用 /list 查看）', contextData)
          return
        }
        await this.handleSwitchCommand(chatId, arg, contextData)
        break

      case '/workspace':
      case '/ws':
        await this.handleWorkspaceCommand(chatId, arg || undefined, contextData)
        break

      case '/now':
        await this.handleNowCommand(chatId, contextData)
        break

      case '/answer':
        await this.send(chatId, '当前没有等待回答的确认。', contextData)
        break

      case '/model':
      case '/m':
        await this.handleModelCommand(chatId, arg, contextData)
        break

      default:
        await this.send(chatId, `未知命令: ${command}。输入 /help 查看帮助。`, contextData)
    }
  }

  // ===== 命令实现 =====

  private async sendHelp(chatId: string, contextData?: unknown): Promise<void> {
    await this.send(chatId, formatBridgeHelpMessage(), contextData)
  }

  private async createNewSession(chatId: string, title?: string, contextData?: unknown): Promise<void> {
    const settings = getSettings()
    const channelId = settings.agentChannelId
    if (!channelId) {
      await this.send(chatId, '请先在 Domi 设置中选择 Agent 渠道。', contextData)
      return
    }

    // 确定工作区；若设置仍指向已删除项目，回退到现存项目而不是创建孤儿会话。
    const workspaceId = this.resolveValidWorkspaceId(resolveAgentRemoteDefaultWorkspaceId(settings))

    const session = createAgentSession(
      title || '新会话',
      channelId,
      workspaceId || undefined,
      undefined,
    )

    // 清理旧绑定
    const oldBinding = this.chatBindings.get(chatId)
    if (oldBinding) {
      this.sessionToChat.delete(oldBinding.sessionId)
      this.clearSessionBuffer(oldBinding.sessionId)
    }

    const binding: BridgeChatBinding = {
      chatId,
      sessionId: session.id,
      workspaceId,
      channelId,
      modelId: settings.agentModelId ?? undefined,
    }
    this.chatBindings.set(chatId, binding)
    this.sessionToChat.set(session.id, chatId)
    this.saveBindings()
    this.config.onSessionContextChanged?.(chatId)

    // 通知渲染进程刷新会话列表
    this.notifySessionCreated(session.id, session.title)

    await this.send(chatId, `✅ 已创建 Agent 会话: ${session.title} (${session.id.slice(0, 8)})`, contextData)
  }

  private async handleListCommand(chatId: string, contextData?: unknown): Promise<void> {
    const sessions = listAgentSessions()
    const workspaces = listAgentWorkspacesByUpdatedAt()
    const binding = this.chatBindings.get(chatId)

    if (sessions.length === 0) {
      await this.send(chatId, '暂无会话。发送消息将自动创建，或使用 /new 创建。', contextData)
      return
    }

    const MAX_PER_WS = 5
    const lines: string[] = ['📋 会话列表:']

    // 按工作区分组
    for (const ws of workspaces) {
      const wsSessions = sessions
        .filter((s) => s.workspaceId === ws.id)
        .slice(0, MAX_PER_WS)

      if (wsSessions.length === 0) continue

      lines.push('')
      lines.push(`【${ws.name}】`)
      for (const s of wsSessions) {
        const globalIdx = sessions.indexOf(s) + 1
        const marker = binding?.sessionId === s.id ? ' ← 当前' : ''
        lines.push(`  ${globalIdx}. ${s.title} (${s.id.slice(0, 8)})${marker}`)
      }
    }

    // 未归属工作区的会话
    const orphans = sessions
      .filter((s) => !s.workspaceId || !workspaces.some((w) => w.id === s.workspaceId))
      .slice(0, MAX_PER_WS)

    if (orphans.length > 0) {
      lines.push('')
      lines.push('【未分配项目】')
      for (const s of orphans) {
        const globalIdx = sessions.indexOf(s) + 1
        const marker = binding?.sessionId === s.id ? ' ← 当前' : ''
        lines.push(`  ${globalIdx}. ${s.title} (${s.id.slice(0, 8)})${marker}`)
      }
    }

    lines.push('')
    lines.push('使用 /switch <序号> 切换会话')

    await this.send(chatId, lines.join('\n'), contextData)
  }

  private async handleStopCommand(chatId: string, contextData?: unknown): Promise<void> {
    const binding = this.chatBindings.get(chatId)
    if (!binding) {
      await this.send(chatId, '当前没有绑定的会话。', contextData)
      return
    }
    stopAgent(binding.sessionId, 'bridge-command')
    this.clearSessionBuffer(binding.sessionId)
    await this.send(chatId, '✅ 已停止 Agent', contextData)
  }

  private async handleSwitchCommand(chatId: string, arg: string, contextData?: unknown): Promise<void> {
    const sessions = listAgentSessions()
    const settings = getSettings()

    // 支持序号和 ID 前缀两种匹配
    const index = Number(arg)
    const match = Number.isInteger(index) && index >= 1 && index <= sessions.length
      ? sessions[index - 1]
      : sessions.find((s) => s.id.startsWith(arg))

    if (!match) {
      await this.send(chatId, `未找到会话。使用 /list 查看可用会话。`, contextData)
      return
    }

    // 清理旧绑定
    const oldBinding = this.chatBindings.get(chatId)
    if (oldBinding) {
      this.sessionToChat.delete(oldBinding.sessionId)
      this.clearSessionBuffer(oldBinding.sessionId)
    }

    const binding: BridgeChatBinding = {
      chatId,
      sessionId: match.id,
      workspaceId: match.workspaceId ?? this.config.getDefaultWorkspaceId?.() ?? resolveAgentRemoteDefaultWorkspaceId(settings) ?? '',
      channelId: match.channelId ?? settings.agentChannelId ?? '',
      modelId: settings.agentModelId ?? undefined,
    }
    this.chatBindings.set(chatId, binding)
    this.sessionToChat.set(match.id, chatId)
    this.saveBindings()
    this.config.onSessionContextChanged?.(chatId)

    await this.send(chatId, `✅ 已切换到会话: ${match.title} (${match.id.slice(0, 8)})`, contextData)
  }

  private async handleWorkspaceCommand(chatId: string, arg?: string, contextData?: unknown): Promise<void> {
    const workspaces = listAgentWorkspacesByUpdatedAt()
    const binding = this.chatBindings.get(chatId)
    const settings = getSettings()
    const currentWorkspaceId = binding?.workspaceId
      ?? this.resolveValidWorkspaceId(resolveAgentRemoteDefaultWorkspaceId(settings))

    // 无参数 → 列出
    if (!arg) {
      if (workspaces.length === 0) {
        await this.send(chatId, '暂无项目。', contextData)
        return
      }
      const lines = ['📋 项目列表:']
      workspaces.forEach((w, i) => {
        const marker = w.id === currentWorkspaceId ? ' ← 当前' : ''
        lines.push(`  ${i + 1}. ${w.name}${marker}`)
      })
      lines.push('')
      lines.push('使用 /workspace <序号或名称> 切换项目')
      await this.send(chatId, lines.join('\n'), contextData)
      return
    }

    // 支持序号和名称匹配
    const index = Number(arg)
    const match = Number.isInteger(index) && index >= 1 && index <= workspaces.length
      ? workspaces[index - 1]
      : workspaces.find(
          (w) => w.name.toLowerCase() === arg.toLowerCase() || w.slug === arg.toLowerCase(),
        )

    if (!match) {
      const available = workspaces.map((w, i) => `${i + 1}. ${w.name}`).join(', ')
      await this.send(chatId, `未找到项目 "${arg}"。可用: ${available}`, contextData)
      return
    }

    // 清理旧绑定（切换工作区后需要新建会话）
    if (binding) {
      this.sessionToChat.delete(binding.sessionId)
      this.chatBindings.delete(chatId)
      this.saveBindings()
    }
    this.config.onSessionContextChanged?.(chatId)

    // 通知平台持久化
    this.config.onWorkspaceSwitched?.(match.id)

    // 列出该工作区下最近会话
    const sessions = listAgentSessions()
    const recentSessions = sessions
      .filter((s) => s.workspaceId === match.id)
      .slice(0, 5)

    const lines = [`✅ 已切换到项目: ${match.name}`]
    if (recentSessions.length > 0) {
      lines.push('')
      lines.push('最近会话:')
      recentSessions.forEach((s) => {
        const globalIdx = sessions.indexOf(s) + 1
        lines.push(`  ${globalIdx}. ${s.title} (${s.id.slice(0, 8)})`)
      })
      lines.push('')
      lines.push('使用 /switch <序号> 切换，或发送消息自动创建新会话')
    } else {
      lines.push('该项目暂无会话，发送消息将自动创建。')
    }

    await this.send(chatId, lines.join('\n'), contextData)
  }

  private async handleNowCommand(chatId: string, contextData?: unknown): Promise<void> {
    const binding = this.chatBindings.get(chatId)
    const lines: string[] = ['📊 当前状态:']
    const nowSettings = getSettings()
    const session = binding ? getAgentSessionMeta(binding.sessionId) : undefined

    // 会话信息
    if (binding) {
      lines.push(`会话: ${session?.title ?? '未知'} (${binding.sessionId.slice(0, 8)})`)
    } else {
      lines.push('会话: 未绑定（发送消息将自动创建）')
    }

    // 与发送路径同序解析：binding > 应用设置。未绑定时展示下一轮的默认运行配置。
    const runMetadata = await resolveBridgeRunMetadata({
      channelId: binding?.channelId || nowSettings.agentChannelId,
      modelId: binding?.modelId ?? nowSettings.agentModelId,
      sessionMeta: session,
      settings: nowSettings,
    })
    lines.push(...formatBridgeRuntimeStatusLines(runMetadata))

    // 项目信息：未绑定会话时也显示下一条消息将使用的默认项目。
    const workspaceId = binding?.workspaceId
      ?? this.resolveValidWorkspaceId(resolveAgentRemoteDefaultWorkspaceId(nowSettings))
    const workspace = workspaceId ? getAgentWorkspace(workspaceId) : undefined
    if (workspace) {
      lines.push(`项目: ${workspace.name} (${workspace.slug})`)

      // MCP Servers
      const capabilities = getWorkspaceCapabilities(workspace.slug)
      if (capabilities.mcpServers.length > 0) {
        lines.push('')
        lines.push('MCP Servers:')
        for (const mcp of capabilities.mcpServers) {
          const status = mcp.enabled !== false ? '✅' : '⏸️'
          lines.push(`  ${status} ${mcp.name}`)
        }
      }

      // Skills
      if (capabilities.skills.length > 0) {
        lines.push('')
        lines.push('Skills:')
        for (const skill of capabilities.skills) {
          const status = skill.enabled !== false ? '✅' : '⏸️'
          lines.push(`  ${status} ${skill.name}`)
        }
      }

      // 项目根目录文件（递归，体现文件夹-文件层级）
      try {
        const projectRoot = getProjectFilesPath(workspace.slug)
        const treeLines = buildFileTree(projectRoot)
        if (treeLines.length > 0) {
          lines.push('')
          lines.push(`项目文件（项目根目录: ${projectRoot}）:`)
          for (const l of treeLines) {
            lines.push(`  ${l}`)
          }
        }
      } catch {
        // 忽略
      }

      // 会话文件（体现文件夹-文件层级）
      if (binding) {
        try {
          const treeLines = buildSessionFileTree(workspace.slug, binding.sessionId)
          if (treeLines.length > 0) {
            lines.push('')
            lines.push('会话文件:')
            for (const l of treeLines) {
              lines.push(`  ${l}`)
            }
          }
        } catch {
          // 忽略
        }
      }
    } else {
      lines.push('项目: 未设置')
    }

    const pendingInteraction = this.interactions.getPendingView(chatId)
    if (pendingInteraction) {
      lines.push('', '当前任务正在等待你的确认：', formatBridgeInteractionText(pendingInteraction))
    }

    await this.send(chatId, lines.join('\n'), contextData)
  }

  /**
   * /model 命令：罗列渠道 / 罗列模型 / 切换模型（per-chat）
   * - /model            列出可用渠道
   * - /model <渠道序号>  列出该渠道下的模型
   * - /model <渠道> <模型> 切换到该渠道的该模型
   */
  private async handleModelCommand(chatId: string, arg: string, contextData?: unknown): Promise<void> {
    const channels = listSwitchableChannels()
    if (channels.length === 0) {
      await this.send(
        chatId,
        '暂无可用渠道。请先在 Domi 设置中配置并启用渠道（需填入 API Key 且至少启用一个模型）。',
        contextData,
      )
      return
    }

    const parts = arg.split(/\s+/).filter(Boolean)

    // /model — 列出渠道
    if (parts.length === 0) {
      const binding = this.chatBindings.get(chatId)
      const lines = ['📡 可用渠道:']
      channels.forEach((c, i) => {
        const marker = binding?.channelId === c.id ? ' ← 当前' : ''
        lines.push(`  ${i + 1}. ${c.name}（${getEnabledModels(c).length} 个模型）${marker}`)
      })
      lines.push('')
      lines.push('使用 /model <渠道序号> 查看模型')
      await this.send(chatId, lines.join('\n'), contextData)
      return
    }

    // 解析渠道
    const channelIdx = Number(parts[0])
    const channel = resolveChannelByIndex(channelIdx)
    if (!channel) {
      await this.send(chatId, `未找到渠道 "${parts[0]}"。使用 /model 查看可用渠道。`, contextData)
      return
    }

    const models = getEnabledModels(channel)

    // /model <渠道> — 列出该渠道模型
    if (parts.length === 1) {
      const binding = this.chatBindings.get(chatId)
      const lines = [`🤖 ${channel.name} 的可用模型:`]
      models.forEach((m, i) => {
        const isCurrent = binding?.channelId === channel.id && binding?.modelId === m.id
        lines.push(`  ${i + 1}. ${m.name}${isCurrent ? ' ← 当前' : ''}`)
      })
      lines.push('')
      lines.push(`使用 /model ${channelIdx} <模型序号> 切换`)
      await this.send(chatId, lines.join('\n'), contextData)
      return
    }

    // /model <渠道> <模型> — 切换
    const modelIdx = Number(parts[1])
    const model = resolveModelByIndex(channel, modelIdx)
    if (!model) {
      await this.send(
        chatId,
        `未找到模型 "${parts[1]}"。使用 /model ${channelIdx} 查看该渠道的模型。`,
        contextData,
      )
      return
    }

    // 切换需要一个 binding 承载；没有则自动创建
    let binding = this.chatBindings.get(chatId)
    if (!binding) {
      binding = this.ensureBinding(chatId) ?? undefined
      if (!binding) {
        await this.send(chatId, '请先发送一条消息创建会话，或在 Domi 设置中选择 Agent 渠道。', contextData)
        return
      }
    }

    binding.channelId = channel.id
    binding.modelId = model.id
    this.saveBindings()

    await this.send(
      chatId,
      `✅ 已切换模型: ${channel.name} / ${model.name}\n（注：重启应用后会恢复默认渠道设置）`,
      contextData,
    )
  }

  // ===== Agent 消息路由 =====

  private async handleUserMessage(
    chatId: string,
    text: string,
    contextData?: unknown,
    attachments?: BridgeAttachment[],
  ): Promise<void> {
    const settings = getSettings()
    const channelId = settings.agentChannelId
    if (!channelId) {
      await this.send(chatId, '请先在 Domi 设置中选择 Agent 渠道。', contextData)
      return
    }

    let binding = this.ensureBinding(chatId)
    if (!binding) {
      await this.send(chatId, '请先在 Domi 设置中选择 Agent 渠道。', contextData)
      return
    }

    const boundSessionId = binding.sessionId
    const pendingDelivery = Array.from(this.pendingFinalDeliveries.values()).find(
      (delivery) => delivery.sessionId === boundSessionId && delivery.chatId === chatId,
    )
    if (pendingDelivery) {
      // 用户的新消息携带平台最新上下文（微信 contextToken 等），优先用于补发上一轮结果，
      // 并消费本条消息，避免“弄好了发我”之类催发文本被误当成下一轮 Agent 任务。
      pendingDelivery.contextData = contextData
      await this.deliverPendingFinalDelivery(pendingDelivery)
      if (this.pendingFinalDeliveries.has(pendingDelivery.id)) {
        await this.send(chatId, '⏳ 上一轮结果正在补发，请稍候。', contextData)
      }
      return
    }

    // 并发保护：如果该会话的 Agent 仍在运行，直接拒绝，不要触碰 buffer
    if (isAgentSessionActive(binding.sessionId)) {
      await this.send(chatId, '❌ 上一条消息仍在处理中，请稍候再试', contextData)
      return
    }

    // 锁定本轮展示与运行共用的渠道、模型和有效推理档位。
    const launchSettings = getSettings()
    const launchChannelId = binding.channelId || launchSettings.agentChannelId || ''
    const launchModelId = binding.modelId ?? launchSettings.agentModelId
    const workspace = binding.workspaceId ? getAgentWorkspace(binding.workspaceId) : undefined
    const session = getAgentSessionMeta(binding.sessionId)
    const runMetadata = await resolveBridgeRunMetadata({
      channelId: launchChannelId,
      modelId: launchModelId,
      sessionMeta: session,
      settings: launchSettings,
    })

    // 即时确认：[workspace_name] → [session_title] + 本轮模型/推理强度。
    const wsName = workspace?.name ?? '默认'
    const chatName = session?.title ?? '新会话'
    await this.send(
      chatId,
      formatBridgeProcessingMessage(wsName, chatName, runMetadata),
      contextData,
    )

    // 发送确认消息期间项目可能刚被删除。再次 ensure 后才允许进入无头 Agent，
    // 确保不会把失效 session/workspace 传给 runAgentHeadless。
    binding = this.ensureBinding(chatId)
    if (!binding) {
      await this.send(chatId, '当前项目已不可用，请在 Domi 中重新选择项目后再试。', contextData)
      return
    }

    const launchSession = getAgentSessionMeta(binding.sessionId)
    await bindProductionBridgeSessionTargetForLaunch({
      sessionId: binding.sessionId,
    })

    // 初始化回复缓冲和低频阶段反馈。初始“Agent 处理中”已在上方发送。
    const progress = new BridgeProgressFeedback(
      (message) => this.send(chatId, message, contextData),
      {
        onSendError: (error) => console.error(
          `[${this.config.platformName} Bridge] 发送阶段反馈失败:`,
          redactSensitiveLogValue(error),
        ),
      },
    )
    progress.start()
    const generation = (this.runGenerations.get(binding.sessionId) ?? 0) + 1
    this.runGenerations.set(binding.sessionId, generation)
    this.interactions.beginRun(binding.sessionId, chatId)
    this.sessionBuffers.set(binding.sessionId, {
      generation,
      text: '',
      images: [],
      imageIdentities: new Set(),
      generatedImageToolUseIds: new Set(),
      progress,
      runMetadata,
      chatId,
      contextData,
      startedAt: Date.now(),
    })

    // 如果有附件，拼接 <attached_files> 块到用户消息前
    const fileReferences = attachments?.length
      ? buildAttachedFilesBlock(attachments.map(a => ({ label: a.label, path: a.absolutePath })))
      : ''
    const effectiveText = text.trim() || (attachments?.length ? '请查看上面附加的文件。' : '')
    const userMessage = fileReferences + effectiveText

    const input = {
      sessionId: binding.sessionId,
      userMessage,
      channelId: launchChannelId,
      modelId: launchModelId,
      workspaceId: binding.workspaceId,
      permissionModeOverride: 'bypassPermissions' as const,
      triggeredBy: 'bridge' as const,
    }

    runAgentHeadless(input, {
      onError: (error) => {
        this.log(`Agent 错误: ${error}`)
        this.clearSessionBuffer(binding!.sessionId)
        this.send(chatId, `❌ Agent 错误: ${error}`, contextData).catch((sendError) => console.error(`[${this.config.platformName} Bridge] 发送错误消息失败:`, redactSensitiveLogValue(sendError)))
      },
      onComplete: (opts) => {
        // 后台任务等待态只是“本轮可继续输入”，并非最终结果；真正终态或 SDK result 漏发时才兜底交付。
        if (opts?.backgroundTasksPending || opts?.stoppedByUser) return
        this.handleSessionComplete(binding!.sessionId, generation)
      },
      onTitleUpdated: () => {},
    }).catch((error) => {
      this.clearSessionBuffer(binding!.sessionId)
      this.log(`Agent 运行异常: ${error}`)
    })
  }

  // ===== EventBus 事件处理 =====

  private handleAgentPayload(sessionId: string, payload: AgentStreamPayload): void {
    const buffer = this.sessionBuffers.get(sessionId)
    if (!buffer) return

    if (payload.kind === 'domi_event') {
      if (payload.event.type === 'ask_user_request') {
        const view = this.interactions.registerAskUser(payload.event.request)
        if (view) {
          buffer.progress.pauseForInteraction()
          void this.sendInteractionView(buffer.chatId, buffer.contextData, view)
        }
        return
      }
      if (payload.event.type === 'exit_plan_mode_request') {
        const view = this.interactions.registerExitPlan(payload.event.request)
        if (view) {
          buffer.progress.pauseForInteraction()
          void this.sendInteractionView(buffer.chatId, buffer.contextData, view)
        }
        return
      }
      if (payload.event.type === 'permission_request') {
        const view = this.interactions.registerPermission(payload.event.request)
        if (view) {
          buffer.progress.pauseForInteraction()
          void this.sendInteractionView(buffer.chatId, buffer.contextData, view)
        }
        return
      }
      if (payload.event.type === 'ask_user_resolved' || payload.event.type === 'exit_plan_mode_resolved') {
        const resolved = this.interactions.resolveRequest(payload.event.requestId)
        if (resolved) {
          buffer.progress.resumeAfterInteraction()
          if (!resolved.submittedByThisCoordinator) {
            void this.send(
              buffer.chatId,
              '✅ 该确认已在 Domi 或其他入口完成，Agent 将继续处理。',
              buffer.contextData,
            )
          }
        }
        return
      }
      if (payload.event.type === 'permission_resolved') {
        const resolved = this.interactions.resolveRequest(payload.event.requestId)
        if (resolved) {
          buffer.progress.resumeAfterInteraction()
          void this.send(
            buffer.chatId,
            '✅ 桌面权限确认已完成，Agent 将继续处理。',
            buffer.contextData,
          )
        }
        return
      }
      if (payload.event.type === 'model_resolved') {
        buffer.runMetadata = applyResolvedBridgeModel(buffer.runMetadata, payload.event.model)
        return
      }
    }

    if (payload.kind === 'sdk_message') {
      const msg = payload.message

      // 从 assistant 终态消息中提取文本。运行时 sdk_delta 由上层分支显式忽略，
      // 避免在钉钉/微信最终回复里形成多段重复内容。
      if (msg.type === 'assistant') {
        buffer.text += extractFinalAssistantText(msg)
        const generatedToolUseIds = collectGeneratedImageToolUseIds(msg)
        for (const toolUseId of generatedToolUseIds) {
          buffer.generatedImageToolUseIds.add(toolUseId)
        }
        if (generatedToolUseIds.length > 0) {
          void buffer.progress.announceImageGeneration()
        }
      } else if (msg.type === 'user') {
        for (const image of extractGeneratedImagesFromToolResults(msg, buffer.generatedImageToolUseIds)) {
          const identity = image.localPath
            ? `path:${image.localPath}`
            : `inline:${image.mediaType}:${image.data ?? ''}`
          if (buffer.imageIdentities.has(identity)) continue
          buffer.imageIdentities.add(identity)
          buffer.images.push(image)
        }
      }

      // result 与 runAgentHeadless.onComplete 共用同一幂等终态。
      if (msg.type === 'result') {
        this.handleSessionComplete(sessionId, buffer.generation)
      }
    }
  }

  private handleSessionComplete(sessionId: string, expectedGeneration?: number): void {
    const buffer = this.sessionBuffers.get(sessionId)
    if (!buffer || (expectedGeneration !== undefined && buffer.generation !== expectedGeneration)) return

    // 先从活动缓冲移除；result 与 onComplete 即使同步竞争，也只有首个入口能取得本轮快照。
    this.sessionBuffers.delete(sessionId)
    this.interactions.endRun(sessionId)
    buffer.progress.prepareForFinalDelivery()
    buffer.progress.stop()

    const duration = ((Date.now() - buffer.startedAt) / 1000).toFixed(1)
    const responseText = buffer.text.trim() || '✅ Agent 已完成（无文本输出）'
    const replyText = appendBridgeRunMetadata(responseText, buffer.runMetadata)
    const now = Date.now()
    const delivery: PendingFinalDelivery = {
      id: randomUUID(),
      sessionId,
      generation: buffer.generation,
      chatId: buffer.chatId,
      contextData: buffer.contextData,
      text: replyText,
      images: buffer.images,
      textDelivered: false,
      textTerminalFailure: false,
      uploadNoticeDelivered: buffer.images.length === 0,
      uploadNoticeTerminalFailure: false,
      imageDelivered: buffer.images.map(() => false),
      imageTerminalFailure: buffer.images.map(() => false),
      failureReportDelivered: false,
      expiresAt: now + (this.config.pendingDeliveryTtlMs ?? DEFAULT_PENDING_DELIVERY_TTL_MS),
      recoveryTimer: null,
      delivering: false,
    }

    this.log(`Agent 回复 (${duration}s, ${buffer.images.length} 张图): ${replyText.slice(0, 100)}${replyText.length > 100 ? '...' : ''}`)
    this.pendingFinalDeliveries.set(delivery.id, delivery)
    this.releaseDisconnectedEventSubscriptionIfIdle()
    void this.deliverPendingFinalDelivery(delivery)
  }

  private async deliverPendingFinalDelivery(delivery: PendingFinalDelivery): Promise<void> {
    if (delivery.delivering || !this.pendingFinalDeliveries.has(delivery.id)) return
    const binding = this.chatBindings.get(delivery.chatId)
    const currentGeneration = this.runGenerations.get(delivery.sessionId)
    if (
      !binding
      || binding.sessionId !== delivery.sessionId
      || (currentGeneration !== undefined && currentGeneration !== delivery.generation)
    ) {
      this.pendingFinalDeliveries.delete(delivery.id)
      return
    }
    if (!this.bridgeAvailable) {
      if (Date.now() >= delivery.expiresAt) {
        this.pendingFinalDeliveries.delete(delivery.id)
      } else {
        this.schedulePendingFinalDelivery(delivery)
      }
      return
    }
    delivery.delivering = true
    if (delivery.recoveryTimer) {
      clearTimeout(delivery.recoveryTimer)
      delivery.recoveryTimer = null
    }

    try {
      const expired = Date.now() >= delivery.expiresAt

      if (!delivery.textDelivered && !delivery.textTerminalFailure) {
        const result = await this.deliverWithRetry(
          `${delivery.id}:text`,
          (attempt) => this.config.adapter.sendText(
            delivery.chatId,
            delivery.text,
            delivery.contextData,
            { deliveryId: `${delivery.id}:text`, attempt },
          ),
        )
        delivery.textDelivered = result === 'delivered'
        delivery.textTerminalFailure = result === 'terminal-failure' || expired
      }

      if (delivery.images.length > 0 && !delivery.uploadNoticeDelivered && !delivery.uploadNoticeTerminalFailure) {
        const result = await this.deliverWithRetry(
          `${delivery.id}:upload`,
          (attempt) => this.config.adapter.sendText(
            delivery.chatId,
            '📤 正在上传结果...',
            delivery.contextData,
            { deliveryId: `${delivery.id}:upload`, attempt },
          ),
        )
        delivery.uploadNoticeDelivered = result === 'delivered'
        delivery.uploadNoticeTerminalFailure = result === 'terminal-failure' || expired
      }

      for (let index = 0; index < delivery.images.length; index++) {
        if (delivery.imageDelivered[index] || delivery.imageTerminalFailure[index]) continue
        const sendImage = this.config.adapter.sendImage
        if (!sendImage) {
          delivery.imageTerminalFailure[index] = true
          continue
        }
        const result = await this.deliverWithRetry(
          `${delivery.id}:image:${index}`,
          (attempt) => sendImage(
            delivery.chatId,
            delivery.images[index]!,
            delivery.contextData,
            { deliveryId: `${delivery.id}:image:${index}`, attempt },
          ),
        )
        delivery.imageDelivered[index] = result === 'delivered'
        delivery.imageTerminalFailure[index] = result === 'terminal-failure' || expired
      }

      const retryablePartsRemain = this.hasRetryableDeliveryParts(delivery)
      if (!retryablePartsRemain) {
        const failedImages = delivery.imageTerminalFailure.filter(Boolean).length
        if ((delivery.textTerminalFailure || failedImages > 0) && !delivery.failureReportDelivered) {
          const succeededImages = delivery.imageDelivered.filter(Boolean).length
          const reportParts = [
            ...(delivery.textTerminalFailure ? ['最终文本发送失败，请在 Domi 中查看完整内容'] : []),
            ...(failedImages > 0 ? [`图片成功 ${succeededImages} 张、失败 ${failedImages} 张`] : []),
          ]
          const result = await this.deliverWithRetry(
            `${delivery.id}:report`,
            (attempt) => this.config.adapter.sendText(
              delivery.chatId,
              `⚠️ ${reportParts.join('；')}。`,
              delivery.contextData,
              { deliveryId: `${delivery.id}:report`, attempt },
            ),
          )
          delivery.failureReportDelivered = result === 'delivered' || result === 'terminal-failure'
          if (result === 'retryable-failure' && !expired) {
            this.schedulePendingFinalDelivery(delivery)
            return
          }
        }
        this.pendingFinalDeliveries.delete(delivery.id)
        return
      }

      if (expired) {
        this.log(`最终结果补发已超过保留期限: ${delivery.sessionId.slice(0, 8)}...`)
        this.pendingFinalDeliveries.delete(delivery.id)
        return
      }
      this.schedulePendingFinalDelivery(delivery)
    } finally {
      delivery.delivering = false
    }
  }

  private async deliverWithRetry(
    label: string,
    deliver: (attempt: number) => Promise<void>,
  ): Promise<'delivered' | 'retryable-failure' | 'terminal-failure'> {
    const delays = this.config.deliveryRetryDelaysMs ?? DEFAULT_DELIVERY_RETRY_DELAYS_MS
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        await deliver(attempt + 1)
        return 'delivered'
      } catch (error) {
        const retryable = this.config.adapter.isRetryableDeliveryError?.(error) ?? true
        console.error(
          `[${this.config.platformName} Bridge] 最终交付失败 (${label}, attempt=${attempt + 1}, retryable=${retryable}):`,
          redactSensitiveLogValue(error),
        )
        if (!retryable) return 'terminal-failure'
        if (attempt >= delays.length) return 'retryable-failure'
        await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]!))
      }
    }
    return 'retryable-failure'
  }

  private hasRetryableDeliveryParts(delivery: PendingFinalDelivery): boolean {
    if (!delivery.textDelivered && !delivery.textTerminalFailure) return true
    if (!delivery.uploadNoticeDelivered && !delivery.uploadNoticeTerminalFailure) return true
    return delivery.images.some((_, index) => !delivery.imageDelivered[index] && !delivery.imageTerminalFailure[index])
  }

  private schedulePendingFinalDelivery(delivery: PendingFinalDelivery): void {
    if (delivery.recoveryTimer || !this.pendingFinalDeliveries.has(delivery.id)) return
    delivery.recoveryTimer = setTimeout(() => {
      delivery.recoveryTimer = null
      void this.deliverPendingFinalDelivery(delivery)
    }, this.config.deliveryRecoveryDelayMs ?? DEFAULT_DELIVERY_RECOVERY_DELAY_MS)
  }

  private resumePendingFinalDeliveries(): void {
    for (const delivery of this.pendingFinalDeliveries.values()) {
      void this.deliverPendingFinalDelivery(delivery)
    }
  }

  private clearSessionBuffer(sessionId: string): SessionBuffer | undefined {
    const buffer = this.sessionBuffers.get(sessionId)
    this.interactions.endRun(sessionId)
    if (buffer) {
      buffer.progress.stop()
      this.sessionBuffers.delete(sessionId)
    }
    this.discardPendingDeliveriesForSession(sessionId)
    const currentGeneration = Math.max(this.runGenerations.get(sessionId) ?? 0, buffer?.generation ?? 0)
    this.runGenerations.set(sessionId, currentGeneration + 1)
    this.releaseDisconnectedEventSubscriptionIfIdle()
    return buffer
  }

  private discardPendingDeliveriesForSession(sessionId: string): void {
    for (const [deliveryId, delivery] of this.pendingFinalDeliveries) {
      if (delivery.sessionId !== sessionId) continue
      if (delivery.recoveryTimer) clearTimeout(delivery.recoveryTimer)
      this.pendingFinalDeliveries.delete(deliveryId)
    }
  }

  private releaseDisconnectedEventSubscriptionIfIdle(): void {
    if (this.bridgeAvailable || this.sessionBuffers.size > 0) return
    this.eventBusUnsubscribe?.()
    this.eventBusUnsubscribe = null
  }

  // ===== 工具方法 =====

  private async sendInteractionView(
    chatId: string,
    contextData: unknown,
    view: BridgeInteractionView,
  ): Promise<void> {
    await this.send(chatId, formatBridgeInteractionText(view), contextData)
  }

  private async sendInteractionResult(
    chatId: string,
    contextData: unknown,
    result: BridgeInteractionResult,
  ): Promise<void> {
    if (result.message) await this.send(chatId, result.message, contextData)
    if (result.view && result.status !== 'accepted' && result.status !== 'expired') {
      await this.sendInteractionView(chatId, contextData, result.view)
    }
  }

  private async send(chatId: string, text: string, contextData?: unknown): Promise<void> {
    await this.config.adapter.sendText(chatId, text, contextData)
  }

  private notifySessionCreated(sessionId: string, title: string): void {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed()) {
      win.webContents.send(AGENT_IPC_CHANNELS.TITLE_UPDATED, { sessionId, title })
    }
  }
}

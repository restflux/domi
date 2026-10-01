import type { AgentSendInput, AgentSessionMeta, SDKMessage, SideChatAPI, SideChatSendInput, SideChatView } from '@domi/shared'
import type { HeadlessAgentRunCallbacks } from '../agent-headless-runner-registry'
import { registerSideChatLaunch } from './policy'
import { validateSideChatImages, type ValidatedSideChatImage } from './images'
import { buildAttachedFilesBlock } from '../bridge-attachment-utils'

export interface SideChatPorts {
  getSession(id: string): AgentSessionMeta | null | undefined
  listSessions(): AgentSessionMeta[]
  createChild(parent: AgentSessionMeta): AgentSessionMeta
  /** fork 父会话 transcript 到子会话（ZCode 式上下文继承）；失败时由宿主降级为空白子会话。 */
  seedChild(childId: string): Promise<boolean>
  updateModel(id: string, channelId: string, modelId?: string): void
  messages(id: string): SDKMessage[]
  bindTarget(childId: string, parentId: string): Promise<void>
  validateModel(channelId: string, modelId?: string): string | undefined
  validateImageModel(channelId: string, modelId?: string): Promise<void>
  saveImages(childId: string, images: ValidatedSideChatImage[]): Array<{ label: string; path: string }>
  deleteChild(childId: string): Promise<void>
  run(input: AgentSendInput, callbacks: HeadlessAgentRunCallbacks): Promise<void>
  stop(childId: string): void
  isActive(childId: string): boolean
  recordError(childId: string, message: string): void
}

export function validateSideChatSend(input: SideChatSendInput): ValidatedSideChatImage[] {
  const images = validateSideChatImages(input?.images)
  if (!input || typeof input.parentSessionId !== 'string' || !input.parentSessionId.trim() || input.parentSessionId.length > 512) throw new Error('父会话标识无效')
  if (input.childSessionId !== undefined && (typeof input.childSessionId !== 'string' || !input.childSessionId.trim() || input.childSessionId.length > 512)) throw new Error('侧聊子会话标识无效')
  // 引用块在渲染层序列化进 message，到达主进程时必须非空；仅图片轮次允许空文字。
  if (typeof input.message !== 'string' || (!input.message.trim() && !images.length) || input.message.length > 100_000) throw new Error('侧聊消息需要文字或图片，文字过长')
  for (const field of ['channelId', 'modelId', 'quotedText'] as const) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field]!.length > (field === 'quotedText' ? 16_000 : 512))) throw new Error(`侧聊 ${field} 无效`)
  }
  return images
}

/**
 * ZCode 式侧聊：一个父会话可持有多个独立子会话（编号多开），
 * 创建时 fork 父 transcript 继承完整上下文；运行锁仅在进程内，重启绝不自动续跑请求。
 */
export class SideChatService implements SideChatAPI {
  private readonly running = new Map<string, { cancelled: boolean; launched: boolean }>()
  /** 父会话当前活动的子会话；划选入口复用它，斜杠命令强制新开。 */
  private readonly activeChild = new Map<string, string>()
  /** 同一父会话的并发创建去重（ZCode pendingCreations 语义）。 */
  private readonly pendingCreation = new Map<string, Promise<AgentSessionMeta>>()
  /** 子会话创建/验证阶段到达的停止请求；首个运行锁登记时消费。 */
  private readonly stopRequested = new Set<string>()
  constructor(private readonly ports: SideChatPorts) {}

  private parent(id: string): AgentSessionMeta {
    if (typeof id !== 'string' || !id.trim()) throw new Error('父会话标识无效')
    const parent = this.ports.getSession(id)
    if (!parent || parent.sideChatParentSessionId || parent.independentReviewId || parent.sourceDelegationId) throw new Error('此会话不能作为侧聊主会话')
    return parent
  }
  /** 按创建顺序返回父会话的全部子会话，并校验归属一致性。 */
  private children(parent: AgentSessionMeta): AgentSessionMeta[] {
    const children = this.ports.listSessions()
      .filter(item => item.sideChatParentSessionId === parent.id)
      .sort((a, b) => a.createdAt - b.createdAt)
    for (const child of children) {
      if (child.parentSessionId !== parent.id || child.workspaceId !== parent.workspaceId || child.independentReviewId) throw new Error('侧聊归属与主会话不一致')
    }
    return children
  }
  private view(parent: AgentSessionMeta, child: AgentSessionMeta): SideChatView {
    // 子会话未显式选模型时回落显示父会话模型：旧子会话与首帧也能预填继承值。
    return {
      parentSessionId: parent.id,
      sessionId: child.id,
      messages: this.ports.messages(child.id),
      isRunning: this.running.has(child.id) || this.ports.isActive(child.id),
      channelId: child.channelId ?? parent.channelId,
      modelId: child.modelId ?? parent.modelId,
    }
  }
  /** 解析目标子会话：显式 childSessionId 必须归属该父会话；缺省时回落到活动子会话。 */
  private resolveChild(parent: AgentSessionMeta, childSessionId?: string): AgentSessionMeta | undefined {
    const children = this.children(parent)
    if (childSessionId) {
      const target = children.find(child => child.id === childSessionId)
      if (!target) throw new Error('侧聊子会话不存在或不属于当前主会话')
      return target
    }
    const activeId = this.activeChild.get(parent.id)
    return children.find(child => child.id === activeId) ?? children[children.length - 1]
  }
  /** 创建子会话并尽力 fork 父上下文；fork 失败降级为空白子会话，不阻断入口。 */
  private async createSeededChild(parent: AgentSessionMeta): Promise<AgentSessionMeta> {
    const pending = this.pendingCreation.get(parent.id)
    if (pending) return pending
    const creating = (async () => {
      const child = this.ports.createChild(parent)
      try {
        await this.ports.seedChild(child.id)
      } catch (error) {
        console.warn('[侧聊] 继承父会话上下文失败，按空白侧聊继续:', error)
      }
      this.activeChild.set(parent.id, child.id)
      return this.ports.getSession(child.id) ?? child
    })().finally(() => {
      if (this.pendingCreation.get(parent.id) === creating) this.pendingCreation.delete(parent.id)
    })
    this.pendingCreation.set(parent.id, creating)
    return creating
  }

  async openSideChat(input: { parentSessionId: string; forceNew?: boolean }): Promise<SideChatView> {
    const parent = this.parent(input?.parentSessionId)
    if (!input?.forceNew) {
      const existing = this.resolveChild(parent)
      if (existing) {
        this.activeChild.set(parent.id, existing.id)
        return this.view(parent, existing)
      }
    }
    return this.view(parent, await this.createSeededChild(parent))
  }
  async listSideChats(parentSessionId: string): Promise<SideChatView[]> {
    const parent = this.parent(parentSessionId)
    return this.children(parent).map(child => this.view(parent, child))
  }
  async closeSideChat(input: { parentSessionId: string; childSessionId: string }): Promise<SideChatView[]> {
    const parent = this.parent(input?.parentSessionId)
    const child = this.resolveChild(parent, input?.childSessionId)
    if (!child) throw new Error('侧聊子会话不存在或不属于当前主会话')
    if (this.running.has(child.id) || this.ports.isActive(child.id)) throw new Error('侧聊正在回复，请先停止再关闭')
    await this.ports.deleteChild(child.id)
    if (this.activeChild.get(parent.id) === child.id) {
      const remaining = this.children(parent)
      if (remaining.length > 0) this.activeChild.set(parent.id, remaining[remaining.length - 1]!.id)
      else this.activeChild.delete(parent.id)
    }
    return this.children(parent).map(item => this.view(parent, item))
  }
  async sendSideChat(input: SideChatSendInput): Promise<void> {
    const images = validateSideChatSend(input)
    // await 前捕获用户意图，后续启动许可与同一批已验证字节绑定。
    const { message, quotedText } = input
    const parent = this.parent(input.parentSessionId)
    const workspaceId = parent.workspaceId
    const child = this.resolveChild(parent, input.childSessionId) ?? await this.createSeededChild(parent)
    this.activeChild.set(parent.id, child.id)
    const parentId = parent.id
    const childId = child.id
    const assertOwnership = (): void => {
      const currentParent = this.parent(parentId)
      if (currentParent.workspaceId !== workspaceId || !this.children(currentParent).some(item => item.id === childId)) throw new Error('侧聊关联已变化')
    }
    if (this.running.has(childId) || this.ports.isActive(childId)) throw new Error('侧聊正在回复，请等待或停止后再发送')
    const channelId = input.channelId?.trim() || child.channelId || parent.channelId
    const requestedModelId = input.modelId?.trim() || (input.channelId && input.channelId !== child.channelId ? undefined : child.modelId) || (!child.channelId && (!input.channelId || input.channelId === parent.channelId) ? parent.modelId : undefined)
    if (!channelId) throw new Error('请先选择侧聊渠道和模型')
    const modelId = this.ports.validateModel(channelId, requestedModelId) ?? requestedModelId
    // 创建/fork 等异步窗口内到达的停止请求在这里消费，防止取消丢失后继续付费启动。
    const state = { cancelled: this.stopRequested.delete(childId), launched: false }
    this.running.set(childId, state)
    try {
      if (images.length) await this.ports.validateImageModel(channelId, modelId)
      if (state.cancelled) throw new Error('侧聊发送已取消')
      assertOwnership()
      await this.ports.bindTarget(childId, parentId)
      if (state.cancelled) throw new Error('侧聊发送已取消')
      // 异步目标绑定后重新验证父子关系，模型变更绝不写入主会话。
      assertOwnership()
      this.ports.validateModel(channelId, modelId)
      this.ports.updateModel(childId, channelId, modelId)
      // 子会话已 fork 继承父 transcript，无需每轮重注背景摘录；引用文本由渲染层序列化进 message。
      const refs = images.length ? this.ports.saveImages(childId, images) : []
      assertOwnership()
      const text = quotedText ? `${message}\n\n引用：\n${quotedText}` : message
      const visibleMessage = buildAttachedFilesBlock(refs) + text
      const imageGuidance = refs.length ? '本轮图片以文件引用提供，尚未读取。请先用 Read 读取 <attached_files> 中的图片，再依据实际返回的图像回答；不能只凭文件名推测内容。\n\n' : ''
      const prompt = `${imageGuidance}${visibleMessage}`
      // 侧聊已对齐完整会话：不覆盖工作方式，随子会话持久设置与全局默认；边界由提示词承担。
      const runInput: AgentSendInput = { sessionId: childId, userMessage: prompt, rawUserMessage: visibleMessage, channelId, modelId, workspaceId, triggeredBy: 'delegation', startedAt: Date.now() }
      const release = registerSideChatLaunch(childId, parentId, runInput)
      state.launched = true
      // 不 await 整轮：IPC 只等待受控启动准备，模型事件沿 child sessionId 发布。
      void Promise.resolve().then(() => {
        if (state.cancelled) return
        assertOwnership()
        return this.ports.run(runInput, {
          source: 'side_chat', originSessionId: parentId,
          onError: error => { if (!state.cancelled) this.ports.recordError(childId, error) },
          onComplete: () => {}, onTitleUpdated: () => {},
        })
      }).catch(error => { if (!state.cancelled) this.ports.recordError(childId, error instanceof Error ? error.message : '侧聊运行失败') })
        .finally(() => { release(); if (this.running.get(childId) === state) this.running.delete(childId) })
    } catch (error) { this.running.delete(childId); throw error }
  }
  async stopSideChat(input: { parentSessionId: string; childSessionId?: string }): Promise<void> {
    const parent = this.parent(input.parentSessionId)
    const child = this.resolveChild(parent, input.childSessionId)
    if (!child) return
    const state = this.running.get(child.id)
    if (state) state.cancelled = true
    else this.stopRequested.add(child.id)
    if (state?.launched || this.ports.isActive(child.id)) this.ports.stop(child.id)
    // 保留锁直到 runner 真正退出；停止不清除历史、不触及主会话。
  }
}

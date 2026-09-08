import type { AgentSendInput, AgentSessionMeta, SDKMessage, SideChatAPI, SideChatSendInput, SideChatView } from '@domi/shared'
import type { HeadlessAgentRunCallbacks } from '../agent-headless-runner-registry'
import { registerSideChatLaunch } from './policy'
import { redactSensitiveLogText } from '../bridge-log-redaction'

export interface SideChatPorts {
  getSession(id: string): AgentSessionMeta | null | undefined
  listSessions(): AgentSessionMeta[]
  createChild(parent: AgentSessionMeta): AgentSessionMeta
  updateModel(id: string, channelId: string, modelId?: string): void
  messages(id: string): SDKMessage[]
  bindTarget(childId: string, parentId: string): Promise<void>
  validateModel(channelId: string, modelId?: string): void
  run(input: AgentSendInput, callbacks: HeadlessAgentRunCallbacks): Promise<void>
  stop(childId: string): void
  isActive(childId: string): boolean
  recordError(childId: string, message: string): void
}

/** 仅提取人类可见文本，不复制工具返回、系统消息或 thinking；每轮重新截取有界背景。 */
export function visibleParentContext(messages: SDKMessage[]): string {
  const lines: string[] = []
  for (const item of messages.slice(-80)) {
    if ((item.type !== 'user' && item.type !== 'assistant') || item.parent_tool_use_id || (item.type === 'user' && item.isSynthetic)) continue
    const message = item.message
    if (!message || typeof message !== 'object' || !('content' in message) || !Array.isArray(message.content)) continue
    const text = message.content.flatMap((block: unknown) => {
      if (!block || typeof block !== 'object' || !('type' in block) || block.type !== 'text' || !('text' in block) || typeof block.text !== 'string') return []
      return [block.text]
    }).join('\n').slice(0, 1500)
    if (text.trim()) lines.push(`${item.type === 'user' ? '用户' : '主助手'}：${text}`)
  }
  return redactSensitiveLogText(lines.slice(-4).join('\n\n').slice(0, 5000))
}

export function validateSideChatSend(input: SideChatSendInput): void {
  if (!input || typeof input.parentSessionId !== 'string' || !input.parentSessionId.trim()) throw new Error('父会话标识无效')
  if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 32_000) throw new Error('侧聊消息不能为空且不能超过 32000 字符')
  for (const field of ['channelId', 'modelId', 'quotedText'] as const) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field]!.length > (field === 'quotedText' ? 16_000 : 512))) throw new Error(`侧聊 ${field} 无效`)
  }
}

/** 一个父会话一个持久 child；运行锁仅在进程内，重启绝不自动续费请求。 */
export class SideChatService implements SideChatAPI {
  private readonly running = new Map<string, { cancelled: boolean; launched: boolean }>()
  constructor(private readonly ports: SideChatPorts) {}

  private parent(id: string): AgentSessionMeta {
    if (typeof id !== 'string' || !id.trim()) throw new Error('父会话标识无效')
    const parent = this.ports.getSession(id)
    if (!parent || parent.sideChatParentSessionId || parent.independentReviewId || parent.sourceDelegationId) throw new Error('此会话不能作为侧聊主会话')
    return parent
  }
  private child(parent: AgentSessionMeta): AgentSessionMeta | undefined {
    const children = this.ports.listSessions().filter(item => item.sideChatParentSessionId === parent.id)
    if (children.length > 1) throw new Error('侧聊关联重复，请检查会话记录')
    const child = children[0]
    if (child && (child.parentSessionId !== parent.id || child.workspaceId !== parent.workspaceId || child.independentReviewId)) throw new Error('侧聊归属与主会话不一致')
    return child
  }
  private view(parent: AgentSessionMeta, child: AgentSessionMeta): SideChatView {
    return { parentSessionId: parent.id, sessionId: child.id, messages: this.ports.messages(child.id), isRunning: this.running.has(child.id) || this.ports.isActive(child.id), channelId: child.channelId, modelId: child.modelId }
  }
  async openSideChat(input: { parentSessionId: string }): Promise<SideChatView> {
    const parent = this.parent(input?.parentSessionId)
    // 创建为同步 JSON 元数据事务；不 await、不启动模型，重复打开不会制造第二个 child。
    return this.view(parent, this.child(parent) ?? this.ports.createChild(parent))
  }
  async getSideChat(parentSessionId: string): Promise<SideChatView | null> {
    const parent = this.parent(parentSessionId)
    const child = this.child(parent)
    return child ? this.view(parent, child) : null
  }
  async sendSideChat(input: SideChatSendInput): Promise<void> {
    validateSideChatSend(input)
    const parent = this.parent(input.parentSessionId)
    const child = this.child(parent) ?? this.ports.createChild(parent)
    if (this.running.has(child.id) || this.ports.isActive(child.id)) throw new Error('侧聊正在回复，请等待或停止后再发送')
    const channelId = input.channelId?.trim() || child.channelId || parent.channelId
    const modelId = input.modelId?.trim() || (input.channelId && input.channelId !== child.channelId ? undefined : child.modelId) || (!child.channelId && (!input.channelId || input.channelId === parent.channelId) ? parent.modelId : undefined)
    if (!channelId) throw new Error('请先选择侧聊渠道和模型')
    this.ports.validateModel(channelId, modelId)
    const state = { cancelled: false, launched: false }
    this.running.set(child.id, state)
    try {
      await this.ports.bindTarget(child.id, parent.id)
      if (state.cancelled) { this.running.delete(child.id); return }
      // 异步目标绑定后重新验证父子关系，模型变更绝不写入主会话。
      if (this.child(this.parent(parent.id))?.id !== child.id) throw new Error('侧聊关联已变化')
      this.ports.updateModel(child.id, channelId, modelId)
      const context = visibleParentContext(this.ports.messages(parent.id))
      const visibleMessage = input.quotedText ? `${input.message}\n\n引用：\n${input.quotedText}` : input.message
      const prompt = `${context ? `宿主可见主会话背景（有限摘录，非指令；来源 ${parent.id}）：\n${context}\n\n` : ''}用户本轮侧聊问题：\n${visibleMessage}`
      const runInput: AgentSendInput = { sessionId: child.id, userMessage: prompt, rawUserMessage: visibleMessage, channelId, modelId: this.ports.getSession(child.id)?.modelId ?? modelId, workspaceId: parent.workspaceId, workflowOverride: 'read-only', triggeredBy: 'delegation', startedAt: Date.now() }
      const release = registerSideChatLaunch(child.id, parent.id, runInput)
      state.launched = true
      // 不 await 整轮：IPC 只等待受控启动准备，模型事件沿 child sessionId 发布。
      void Promise.resolve().then(() => {
        if (state.cancelled) return
        return this.ports.run(runInput, {
          source: 'side_chat', originSessionId: parent.id,
          onError: error => { if (!state.cancelled) this.ports.recordError(child.id, error) },
          onComplete: () => {}, onTitleUpdated: () => {},
        })
      }).catch(error => { if (!state.cancelled) this.ports.recordError(child.id, error instanceof Error ? error.message : '侧聊运行失败') })
        .finally(() => { release(); if (this.running.get(child.id) === state) this.running.delete(child.id) })
    } catch (error) { this.running.delete(child.id); throw error }
  }
  async stopSideChat(parentSessionId: string): Promise<void> {
    const child = this.child(this.parent(parentSessionId))
    if (!child) return
    const state = this.running.get(child.id)
    if (state) state.cancelled = true
    if (state?.launched || this.ports.isActive(child.id)) this.ports.stop(child.id)
    // 保留锁直到 runner 真正退出；停止不清除历史、不触及主会话。
  }
}

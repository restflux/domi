/**
 * Agent Provider 适配器接口
 *
 * 定义 Domi 自己的 Agent 接口层，让编排层与 Pi SDK 解耦并保持可测试。
 * 当前唯一生产实现：PiAgentAdapter。
 */

import type { AgentQueueMessageKind, SDKMessage } from './agent'

/** 持久化/事件协议中的 runtime 标识；生产执行只支持 Pi，`claude` 仅用于读取旧消息形状。 */
export type AgentRuntime = 'claude' | 'pi'

/** SDK 用户消息（队列消息注入用，匹配 SDK SDKUserMessage 结构） */
export interface SDKUserMessageInput {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: null
  priority?: 'now' | 'next' | 'later'
  uuid?: string
  session_id: string
}

/** 队列消息注入选项 */
export interface SendQueuedMessageOptions {
  /** 先取消当前 turn，再把消息作为新一轮用户输入发送 */
  interrupt?: boolean
  /** Pi 原生队列类型；未提供时兼容 priority 字段。 */
  queueKind?: AgentQueueMessageKind
  /** 当前用户输入显式引用的 Skill name（兼容历史 slug 已在编排层归一化） */
  skillMentions?: string[]
  /** runtime/adapter 已接收消息后回调；用于调用方区分失败时是否可回滚本地历史 */
  onAccepted?: () => void
  /** renderer/main 生成的稳定队列 UUID，用于 clearQueue 与 SDK 文本队列做精确关联。 */
  queueMessageId?: string
  /** Pi SDK queue_update 确认消息已从待发送队列取出时回调；可返回需进入事件流的用户消息。 */
  onDelivered?: () => SDKMessage | void
}

export interface ClearedProviderMessageQueue {
  steering: string[]
  followUp: string[]
  steeringMessageIds: string[]
  followUpMessageIds: string[]
}

export interface SessionTreeNavigationAdapterInput {
  entryId: string
  sessionFile: string
  cwd: string
}

export interface SessionTreeNavigationAdapterResult {
  editorText?: string
  activeLeafId: string | null
  abortedRun: boolean
}

/**
 * Agent 查询输入（Provider 无关）
 *
 * 包含所有 Provider 都需要的通用字段。
 * SDK 特定配置通过 Adapter 的扩展输入类型传入。
 */
export interface AgentQueryInput {
  /** 会话 ID */
  sessionId: string
  /** 用户 prompt（已包含上下文注入） */
  prompt: string
  /** 模型 ID */
  model?: string
  /** Agent 工作目录 */
  cwd?: string
  /** 中止信号 */
  abortSignal?: AbortSignal
}

/**
 * Agent Provider 适配器接口
 *
 * 职责：接收查询输入，返回 SDKMessage 异步迭代流。
 * SDK 返回完整 JSON 对象（includePartialMessages: false），外部直接透传。
 */
export interface AgentProviderAdapter {
  /** 发起查询，返回 SDKMessage 异步迭代流 */
  query(input: AgentQueryInput): AsyncIterable<SDKMessage>
  /** 中止指定会话的执行 */
  abort(sessionId: string): void
  /** 跳过当前已安排 retry 的 backoff，立即继续同一 transcript。 */
  retryNow?(sessionId: string): Promise<boolean>
  /**
   * 软中断当前 turn，但保留活跃 Query/Channel 以便继续注入下一条用户消息。
   * 与 abort() 的区别：不杀子进程，允许立即续跑新消息。
   */
  interruptQuery?(sessionId: string): Promise<void>
  /** 释放资源 */
  dispose(): void
  /** 向活跃查询注入队列消息（可选，仅支持队列的 Provider 实现） */
  sendQueuedMessage?(sessionId: string, message: SDKUserMessageInput, options?: SendQueuedMessageOptions): Promise<void>
  /** 在整个原生队列事务期间暂停送达回调，并在结束时按 SDK 权威内容一次性对账。 */
  withQueuedMessageDeliverySuppressed?<T>(sessionId: string, operation: () => Promise<T>): Promise<T>
  /** 清空底层原生队列；abort=true 时同时中止当前 run。 */
  clearQueuedMessages?(sessionId: string, options?: { abort?: boolean }): Promise<ClearedProviderMessageQueue>
  /** 取消队列中的待发送消息（可选） */
  cancelQueuedMessage?(sessionId: string, messageUuid: string): Promise<void>
  /** 动态切换活跃查询的权限模式（可选，仅支持 SDK 原生 setPermissionMode 的 Provider） */
  setPermissionMode?(sessionId: string, mode: string): Promise<void>
  /** 在同一 runtime session artifact 内切换树节点（仅 Pi 支持）。 */
  navigateSessionTree?(
    sessionId: string,
    input: SessionTreeNavigationAdapterInput,
  ): Promise<SessionTreeNavigationAdapterResult>
}

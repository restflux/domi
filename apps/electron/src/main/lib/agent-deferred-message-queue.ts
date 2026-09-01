import type {
  AgentDeferredQueueMessageInput,
  AgentMoveQueuedMessageInput,
  AgentQueuedMessageControlInput,
} from '@domi/shared'

export interface AgentDeferredMessageQueueOptions {
  isActive: (sessionId: string) => boolean
  startRun: (input: AgentDeferredQueueMessageInput) => void | Promise<void>
  onStarted: (input: AgentDeferredQueueMessageInput, startedAt: number) => void
  onError?: (input: AgentDeferredQueueMessageInput, error: unknown) => void
  now?: () => number
  schedule?: (callback: () => void) => void
}

/**
 * main 权威的短暂 deferred queue。只承接已经被宿主接受、但旧 Pi query 通道刚结束的消息；
 * renderer 仅保存可编辑投影，不能决定何时安全启动下一轮。
 */
export class AgentDeferredMessageQueue {
  private readonly queues = new Map<string, AgentDeferredQueueMessageInput[]>()
  private readonly dispatching = new Map<string, string>()
  private readonly now: () => number
  private readonly schedule: (callback: () => void) => void

  constructor(private readonly options: AgentDeferredMessageQueueOptions) {
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? queueMicrotask
  }

  enqueue(input: AgentDeferredQueueMessageInput): boolean {
    const { sessionId, queueMessageId } = input
    if (this.dispatching.get(sessionId) === queueMessageId) return false
    const queue = this.queues.get(sessionId) ?? []
    if (queue.some((entry) => entry.queueMessageId === queueMessageId)) return false
    queue.push(input)
    this.queues.set(sessionId, queue)
    this.tryDispatch(sessionId)
    return true
  }

  cancel(input: AgentQueuedMessageControlInput): boolean {
    const queue = this.queues.get(input.sessionId)
    if (!queue) return false
    const index = queue.findIndex((entry) => entry.queueMessageId === input.messageId)
    if (index < 0) return false
    queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(input.sessionId)
    return true
  }

  move(input: AgentMoveQueuedMessageInput): boolean {
    const queue = this.queues.get(input.sessionId)
    if (!queue) return false
    const sourceIndex = queue.findIndex((entry) => entry.queueMessageId === input.sourceId)
    const targetIndex = queue.findIndex((entry) => entry.queueMessageId === input.targetId)
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return false
    const [entry] = queue.splice(sourceIndex, 1)
    if (!entry) return false
    const adjustedTarget = queue.findIndex((item) => item.queueMessageId === input.targetId)
    queue.splice(input.placement === 'after' ? adjustedTarget + 1 : adjustedTarget, 0, entry)
    return true
  }

  clear(sessionId: string): AgentDeferredQueueMessageInput[] {
    const queue = this.queues.get(sessionId) ?? []
    this.queues.delete(sessionId)
    return queue
  }

  clearAll(): AgentDeferredQueueMessageInput[] {
    const messages = [...this.queues.values()].flat()
    this.queues.clear()
    return messages
  }

  hasPending(sessionId: string): boolean {
    return (this.queues.get(sessionId)?.length ?? 0) > 0
  }

  hasAnyWork(): boolean {
    return this.queues.size > 0 || this.dispatching.size > 0
  }

  isDispatching(sessionId: string, messageId?: string): boolean {
    const current = this.dispatching.get(sessionId)
    return messageId === undefined ? current !== undefined : current === messageId
  }

  onRunComplete(sessionId: string, stoppedByUser: boolean, backgroundTasksPending: boolean): void {
    if (stoppedByUser) {
      this.clear(sessionId)
      return
    }
    if (backgroundTasksPending) return
    this.schedule(() => this.tryDispatch(sessionId))
  }

  private tryDispatch(sessionId: string): void {
    if (this.dispatching.has(sessionId) || this.options.isActive(sessionId)) return
    const queue = this.queues.get(sessionId)
    const input = queue?.shift()
    if (!input) {
      this.queues.delete(sessionId)
      return
    }
    if (queue?.length === 0) this.queues.delete(sessionId)

    const messageId = input.queueMessageId
    const startedAt = this.now()
    const runInput: AgentDeferredQueueMessageInput = {
      ...input,
      startedAt,
      userMessageUuid: input.userMessageUuid ?? messageId,
    }
    this.dispatching.set(sessionId, messageId)
    this.options.onStarted(runInput, startedAt)

    void Promise.resolve(this.options.startRun(runInput))
      .catch((error) => this.options.onError?.(runInput, error))
      .finally(() => {
        if (this.dispatching.get(sessionId) === messageId) this.dispatching.delete(sessionId)
        this.tryDispatch(sessionId)
      })
  }
}

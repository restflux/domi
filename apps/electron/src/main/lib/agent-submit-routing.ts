/**
 * Pi query 已结束、但 renderer 尚未收到终态事件时，旧活跃通道可能拒绝消息注入。
 * 只有这些“消息尚未被接受”的错误可以安全交给 main deferred queue；权限、
 * Session Target、Worktree 所有权和 rewind 等真实拒绝必须继续上抛。
 */
import type {
  AgentSendInput,
  AgentSubmitOrEnqueueInput,
  AgentSubmitOrEnqueueResult,
} from '@domi/shared'

export function isStaleActiveQueueError(error: unknown): boolean {
  const record = error !== null && typeof error === 'object'
    ? error as Record<string, unknown>
    : undefined
  const code = typeof record?.code === 'string' ? record.code : ''
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === 'string'
      ? record.message
      : String(error)

  return code === 'agent.query.not_active'
    || message.includes('无活跃消息通道可注入队列消息')
    || message.includes('当前会话没有正在运行的 Agent')
    || message.includes('运行状态已变化，取消追加消息')
    || message.includes('运行状态已变化，取消队列注入')
}

export function buildDeferredAgentRunInput(input: AgentSubmitOrEnqueueInput): AgentSendInput {
  const {
    queueMessageId,
    queueKind: _queueKind,
    dispatch: _dispatch,
    interrupt: _interrupt,
    ...runInput
  } = input
  return {
    ...runInput,
    userMessageUuid: queueMessageId,
    triggeredBy: 'user',
  }
}

export interface AgentSubmissionGuardState {
  rewinding: boolean
  stopped: boolean
  blockingPermission: boolean
  delegationCheckoutReleased: boolean
  sessionWorkspaceId?: string
  requestedWorkspaceId?: string
}

/** 在消息进入 Pi 或 deferred queue 前复核不可排队绕过的宿主边界。 */
export function assertAgentSubmissionMayProceed(state: AgentSubmissionGuardState): void {
  if (state.rewinding) throw new Error('会话正在回退，请等待完成后再发送')
  if (state.stopped) throw new Error('会话正在停止，请等待本轮完全结束后再发送')
  if (state.blockingPermission) throw new Error('权限请求仍在等待用户确认，暂不能发送新消息')
  if (state.delegationCheckoutReleased) {
    throw new Error('该协作会话的 Worktree 占用已释放，不能继续运行')
  }
  if (
    state.sessionWorkspaceId
    && state.requestedWorkspaceId
    && state.sessionWorkspaceId !== state.requestedWorkspaceId
  ) {
    throw new Error('会话项目不匹配，已拒绝发送以避免访问错误的项目目录')
  }
}

export class AgentSubmissionDeduplicator {
  private readonly submissions = new Map<string, Promise<AgentSubmitOrEnqueueResult>>()
  private readonly maxEntries = 1_024

  submit(
    input: Pick<AgentSubmitOrEnqueueInput, 'sessionId' | 'queueMessageId'>,
    operation: () => Promise<AgentSubmitOrEnqueueResult>,
  ): Promise<AgentSubmitOrEnqueueResult> {
    const key = `${input.sessionId}\u0000${input.queueMessageId}`
    const existing = this.submissions.get(key)
    if (existing) return existing
    const submission = operation().catch((error) => {
      this.submissions.delete(key)
      throw error
    })
    this.submissions.set(key, submission)
    if (this.submissions.size > this.maxEntries) {
      const oldest = this.submissions.keys().next().value
      if (oldest !== undefined) this.submissions.delete(oldest)
    }
    return submission
  }

  forget(sessionId: string, messageId: string): void {
    this.submissions.delete(`${sessionId}\u0000${messageId}`)
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId}\u0000`
    for (const key of this.submissions.keys()) {
      if (key.startsWith(prefix)) this.submissions.delete(key)
    }
  }
}

export interface AgentSubmissionRoutingOptions {
  isActive: (sessionId: string) => boolean
  inject: (input: AgentSubmitOrEnqueueInput) => Promise<void>
  beforeEnqueue?: (input: AgentSubmitOrEnqueueInput) => void
  enqueue: (input: AgentSubmitOrEnqueueInput) => boolean
}

/** main 单一入口按实时状态决定注入；只有确认尚未接受的陈旧通道错误才允许降级排队。 */
export async function routeAgentSubmission(
  input: AgentSubmitOrEnqueueInput,
  options: AgentSubmissionRoutingOptions,
): Promise<AgentSubmitOrEnqueueResult> {
  if (input.dispatch === 'now' && options.isActive(input.sessionId)) {
    try {
      await options.inject(input)
      return { disposition: 'injected' }
    } catch (error) {
      if (!isStaleActiveQueueError(error)) throw error
    }
  }

  options.beforeEnqueue?.(input)
  options.enqueue(input)
  return { disposition: 'queued' }
}

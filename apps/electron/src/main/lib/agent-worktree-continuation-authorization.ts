import { randomUUID } from 'node:crypto'
import type { AgentSendInput, AgentWorkflow, SDKMessage, SessionTargetView } from '@domi/shared'
import { SessionCheckoutError, type CheckoutLease } from './session-checkout/index.ts'

export interface TrustedWorktreeContinuationAuthorization {
  kind: 'worktree_continuation'
  requestId: string
  sourceCheckoutId: string
  sourceRevision: number
  checkoutId: string
  revision: number
  iteration: number
  runGeneration: number
}

export interface ConfirmedWorktreeIterationContinuation {
  target: SessionTargetView
  authorizationToken: string
  continuationMessage: string
  requestId: string
  iteration: number
}

interface WorktreeIterationRequestRecord {
  requestId: string
  iteration: number
  task: string
  sourceCheckoutId?: string
  sourceRevision?: number
}

interface PendingWorktreeContinuationAuthorization extends Omit<TrustedWorktreeContinuationAuthorization, 'runGeneration'> {
  token: string
  sessionId: string
  continuationMessage: string
  activityEpoch: number
}

export interface AgentWorktreeContinuationDependencies {
  getMessages(sessionId: string): SDKMessage[]
  assertIdle(sessionId: string): Promise<void>
  inspectTarget(sessionId: string): Promise<SessionTargetView>
  beginNextIteration(sessionId: string): Promise<SessionTargetView>
  createToken(): string
}

function readIterationRequest(message: unknown, requestId: string): WorktreeIterationRequestRecord | null {
  if (!message || typeof message !== 'object') return null
  const record = message as Record<string, unknown>
  if (record.type !== 'system' || record.subtype !== 'worktree_next_iteration_requested') return null
  if (record.request_id !== requestId) return null
  const iteration = record.iteration
  const task = typeof record.task === 'string' ? record.task.trim().slice(0, 4000) : ''
  if (typeof iteration !== 'number' || !Number.isSafeInteger(iteration) || iteration <= 0 || !task) return null
  const sourceCheckoutId = typeof record.checkout_id === 'string' && record.checkout_id.trim() ? record.checkout_id.trim() : undefined
  const sourceRevision = typeof record.expected_revision === 'number' && Number.isSafeInteger(record.expected_revision) ? record.expected_revision : undefined
  return {
    requestId,
    iteration,
    task,
    ...(sourceCheckoutId ? { sourceCheckoutId } : {}),
    ...(sourceRevision !== undefined ? { sourceRevision } : {}),
  }
}

function findIterationRequest(messages: SDKMessage[], requestId: string): WorktreeIterationRequestRecord | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const request = readIterationRequest(messages[index], requestId)
    if (request) return request
  }
  return null
}

function previousIteration(target: SessionTargetView): number | null {
  const delivery = target.delivery
  if (delivery?.state === 'delivered' && target.checkout.phase === 'discarded') return delivery.iteration
  if (target.checkout.phase === 'discarded' && delivery === undefined) return target.checkout.iteration ?? null
  if (delivery?.state === 'finalized' && target.checkout.phase === 'finalized') return delivery.review.iteration
  if (delivery?.state === 'retained' && target.checkout.phase === 'retained') return delivery.review.iteration
  return null
}

export function buildWorktreeIterationContinuationMessage(iteration: number, task: string): string {
  return `第 ${iteration} 轮 Worktree 已创建。请立即继续执行以下已确认任务，不要再次请求创建 Worktree：\n\n${task}`
}

/**
 * 一次性授权只覆盖宿主确认的 canonical continuation message。
 * Renderer 不得把输入区附件、附言、mention、动态工具或运行控制覆盖夹带进同一 Direct run。
 */
export function assertWorktreeContinuationRunEnvelope(input: AgentSendInput): void {
  // 这些字段必须完全缺席，而不只是“看起来为空”。IPC 输入不受 TypeScript 运行时约束，
  // 因此也要拒绝伪造的非数组/非字符串值，避免其在后续 prompt 组装中被意外解释。
  const forbiddenFields: Array<keyof AgentSendInput> = [
    'nextTurnAsides',
    'additionalDirectories',
    'customTools',
    'mentionedSkills',
    'mentionedMcpServers',
    'mentionedSessionIds',
    'mentionedTodoIds',
    'mentionedCalendarEventIds',
    'automationContext',
    'retryOfErrorUuid',
    'executionPolicyOverride',
    'workflowOverride',
    'permissionModeOverride',
  ]
  if (forbiddenFields.some((field) => input[field] !== undefined) || (input.triggeredBy !== undefined && input.triggeredBy !== 'user')) {
    throw new SessionCheckoutError('operation_not_allowed', 'Worktree 续跑授权不能携带未确认的附加上下文或运行控制')
  }
}

export function resolveWorktreeContinuationRunWorkflow(persistentWorkflow: AgentWorkflow, authorization: TrustedWorktreeContinuationAuthorization | undefined): { workflow: AgentWorkflow; grantTemporaryExecution: boolean } {
  if (authorization && persistentWorkflow === 'read-only') {
    return { workflow: 'direct', grantTemporaryExecution: true }
  }
  return { workflow: persistentWorkflow, grantTemporaryExecution: false }
}

export function matchesWorktreeContinuationTarget(authorization: Omit<TrustedWorktreeContinuationAuthorization, 'runGeneration'>, sessionId: string, lease: Pick<CheckoutLease, 'kind' | 'checkoutId' | 'ownerSessionId' | 'revision' | 'followupOnly'>): boolean {
  return authorization.kind === 'worktree_continuation' && lease.kind === 'isolated' && lease.ownerSessionId === sessionId && lease.checkoutId === authorization.checkoutId && lease.revision === authorization.revision && lease.followupOnly !== true
}

export class AgentWorktreeContinuationAuthorizationRegistry {
  private records = new Map<string, PendingWorktreeContinuationAuthorization>()
  private tokenBySession = new Map<string, string>()
  private activityEpochBySession = new Map<string, number>()
  private confirmingSessions = new Set<string>()

  captureActivityEpoch(sessionId: string): number {
    return this.activityEpochBySession.get(sessionId) ?? 0
  }

  beginConfirmation(sessionId: string): number {
    if (this.confirmingSessions.has(sessionId)) {
      throw new SessionCheckoutError('operation_not_allowed', 'Worktree 续跑确认正在处理中，请勿重复提交')
    }
    this.confirmingSessions.add(sessionId)
    this.clearSession(sessionId)
    return this.captureActivityEpoch(sessionId)
  }

  endConfirmation(sessionId: string): void {
    this.confirmingSessions.delete(sessionId)
  }

  isConfirmationInProgress(sessionId: string): boolean {
    return this.confirmingSessions.has(sessionId)
  }

  /** 普通消息、分支切换或其他新任务进入时，使横跨该活动的确认和 token 一并失效。 */
  noteSessionActivity(sessionId: string): void {
    const current = this.captureActivityEpoch(sessionId)
    if (current >= Number.MAX_SAFE_INTEGER) throw new Error('Worktree 续跑活动序号已耗尽，请重启应用')
    this.clearSession(sessionId)
    this.activityEpochBySession.set(sessionId, current + 1)
  }

  issue(input: Omit<PendingWorktreeContinuationAuthorization, 'token' | 'activityEpoch'>, createToken: () => string = randomUUID, expectedActivityEpoch: number = this.captureActivityEpoch(input.sessionId)): string {
    if (this.captureActivityEpoch(input.sessionId) !== expectedActivityEpoch) {
      throw new SessionCheckoutError('operation_not_allowed', '会话状态已变化，请重新确认 Worktree 续跑任务')
    }
    this.clearSession(input.sessionId)
    const token = createToken()
    this.records.set(token, {
      ...input,
      token,
      activityEpoch: expectedActivityEpoch,
    })
    this.tokenBySession.set(input.sessionId, token)
    return token
  }

  consume(input: { token: string; sessionId: string; continuationMessage: string; runGeneration: number; lease: Pick<CheckoutLease, 'kind' | 'checkoutId' | 'ownerSessionId' | 'revision' | 'followupOnly'> }): TrustedWorktreeContinuationAuthorization {
    const record = this.records.get(input.token)
    if (record) {
      this.records.delete(input.token)
      if (this.tokenBySession.get(record.sessionId) === input.token) this.tokenBySession.delete(record.sessionId)
    }
    if (!record || record.sessionId !== input.sessionId || record.continuationMessage !== input.continuationMessage || record.activityEpoch !== this.captureActivityEpoch(input.sessionId) || !Number.isSafeInteger(input.runGeneration) || input.runGeneration <= 0 || !matchesWorktreeContinuationTarget(record, input.sessionId, input.lease)) {
      throw new SessionCheckoutError('operation_not_allowed', 'Worktree 续跑授权无效或已过期，请重新确认当前任务')
    }
    const { token: _token, sessionId: _sessionId, continuationMessage: _message, activityEpoch: _activityEpoch, ...authorization } = record
    return { ...authorization, runGeneration: input.runGeneration }
  }

  clearSession(sessionId: string): void {
    const token = this.tokenBySession.get(sessionId)
    if (token) this.records.delete(token)
    this.tokenBySession.delete(sessionId)
  }

  clear(): void {
    this.records.clear()
    this.tokenBySession.clear()
    this.activityEpochBySession.clear()
    this.confirmingSessions.clear()
  }
}

export const worktreeContinuationAuthorizationRegistry = new AgentWorktreeContinuationAuthorizationRegistry()

export async function confirmAgentWorktreeIterationContinuation(sessionId: string, requestId: string, registry: AgentWorktreeContinuationAuthorizationRegistry, dependencies: AgentWorktreeContinuationDependencies): Promise<ConfirmedWorktreeIterationContinuation> {
  const activityEpoch = registry.beginConfirmation(sessionId)
  try {
    await dependencies.assertIdle(sessionId)
    const request = findIterationRequest(dependencies.getMessages(sessionId), requestId)
    if (!request) {
      throw new SessionCheckoutError('operation_not_allowed', '未找到可确认的 Worktree 续跑请求')
    }

    const source = await dependencies.inspectTarget(sessionId)
    const alreadyCreated = source.checkout.kind === 'isolated' && source.ownership === 'owner' && source.delivery?.state === 'working' && source.delivery.iteration === request.iteration
    let target: SessionTargetView
    if (alreadyCreated) {
      // 应用重启不会保留旧 token；用户再次点击“继续本轮任务”时，只有新格式请求中
      // 持久化的来源 Checkout 证据齐全，宿主才为当前精确 Worktree 重新签发一次。
      if (request.sourceCheckoutId === undefined || request.sourceRevision === undefined) {
        throw new SessionCheckoutError('operation_not_allowed', '历史 Worktree 请求缺少可信来源证据，请重新发起')
      }
      target = source
    } else {
      const completedIteration = previousIteration(source)
      if (source.checkout.kind !== 'isolated' || source.ownership !== 'owner' || completedIteration !== request.iteration - 1 || (request.sourceCheckoutId !== undefined && request.sourceCheckoutId !== source.checkout.id) || (request.sourceRevision !== undefined && request.sourceRevision !== source.revision)) {
        throw new SessionCheckoutError('stale_target', 'Worktree 续跑请求对应的 Checkout 已变化，请重新发起')
      }
      target = await dependencies.beginNextIteration(sessionId)
    }
    if (target.checkout.kind !== 'isolated' || target.ownership !== 'owner' || target.delivery?.state !== 'working' || target.delivery.iteration !== request.iteration) {
      throw new SessionCheckoutError('operation_not_allowed', '下一轮 Worktree 未进入可执行状态')
    }

    const continuationMessage = buildWorktreeIterationContinuationMessage(request.iteration, request.task)
    const authorizationToken = registry.issue(
      {
        kind: 'worktree_continuation',
        sessionId,
        requestId: request.requestId,
        sourceCheckoutId: request.sourceCheckoutId ?? source.checkout.id,
        sourceRevision: request.sourceRevision ?? source.revision,
        checkoutId: target.checkout.id,
        revision: target.revision,
        iteration: request.iteration,
        continuationMessage,
      },
      dependencies.createToken,
      activityEpoch,
    )

    return {
      target,
      authorizationToken,
      continuationMessage,
      requestId: request.requestId,
      iteration: request.iteration,
    }
  } finally {
    registry.endConfirmation(sessionId)
  }
}

import { randomUUID } from 'node:crypto'
import type { SDKMessage, SessionTargetView } from '@domi/shared'
import { SessionCheckoutError } from './session-checkout/index.ts'
import { sanitizeWorktreeReviewText } from './agent-worktree-review.ts'

export interface AgentWorktreeIterationAvailabilityInput {
  targetKind?: 'local' | 'isolated'
  ownership?: 'owner' | 'inherited'
  followupOnly?: boolean
  followupReason?: 'delivered' | 'discarded' | 'retained' | 'preview_active'
  triggeredBy?: 'user' | 'automation' | 'delegation' | 'bridge' | 'channel'
  sourceDelegationId?: string
}

export interface AgentWorktreeIterationDependencies {
  inspectTarget(sessionId: string): Promise<SessionTargetView>
  persistMessages(sessionId: string, messages: SDKMessage[]): void
  createRequestId(): string
}

export interface WorktreeIterationRequestInput {
  /** 宿主会在请求卡之前确定性渲染的完整 Markdown 正文。 */
  details: string
  /** 供确认卡显示的简短摘要。 */
  summary: string
  /** 用户确认后自动续跑所需的完整、自包含任务。 */
  task: string
}

function sanitizeWorktreeIterationSummary(summary: string): string {
  return sanitizeWorktreeReviewText(summary).replace(/\s+/g, ' ').trim().slice(0, 240)
}

function sanitizeWorktreeIterationDetails(details: string): string {
  return sanitizeWorktreeReviewText(details).slice(0, 12_000)
}

const ABSOLUTE_LOCAL_PATH_PATTERN = /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`]+|(^|\s)\/(?:Users|home|tmp|var|opt|private|mnt|workspace|repo)(?:\/[^\s"'`]*)?/m
const INTERNAL_WORKTREE_REF_PATTERN = /refs\/domi\/[^\s"'`]+/
const UNRESOLVED_REDACTION_PATTERN = /\[(?:路径|内部引用)\]|<(?:path|路径)>|\{(?:path|路径)\}/i

function assertPortableWorktreeIterationText(input: WorktreeIterationRequestInput): void {
  const values = [input.details, input.summary, input.task]
  if (values.some((value) => ABSOLUTE_LOCAL_PATH_PATTERN.test(value) || INTERNAL_WORKTREE_REF_PATTERN.test(value))) {
    throw new SessionCheckoutError(
      'invalid_input',
      'Worktree 续改确认内容不得包含绝对路径或内部引用；请改用“当前项目的 Local Checkout”和项目相对路径后重试',
    )
  }
  if (values.some((value) => UNRESOLVED_REDACTION_PATTERN.test(value))) {
    throw new SessionCheckoutError(
      'invalid_input',
      'Worktree 续改确认内容包含未解析的路径占位符；请改用“当前项目的 Local Checkout”或具体项目相对路径后重试',
    )
  }
}

async function getProductionDependencies(): Promise<AgentWorktreeIterationDependencies> {
  const [{ getSessionCheckoutModule }, { appendSDKMessages }] = await Promise.all([
    import('./session-checkout/production.ts'),
    import('./agent-session-manager.ts'),
  ])
  return {
    inspectTarget: (sessionId) => getSessionCheckoutModule().inspect(sessionId),
    persistMessages: appendSDKMessages,
    createRequestId: randomUUID,
  }
}

export function canOfferNextWorktreeIteration(input: AgentWorktreeIterationAvailabilityInput): boolean {
  return input.targetKind === 'isolated'
    && input.ownership === 'owner'
    && input.followupOnly === true
    && input.followupReason !== 'preview_active'
    && (input.triggeredBy ?? 'user') === 'user'
    && !input.sourceDelegationId
}

export function canOfferWorktreePreviewRevision(input: AgentWorktreeIterationAvailabilityInput): boolean {
  return input.targetKind === 'isolated'
    && input.ownership === 'owner'
    && input.followupOnly === true
    && input.followupReason === 'preview_active'
    && (input.triggeredBy ?? 'user') === 'user'
    && !input.sourceDelegationId
}

export async function requestNextWorktreeIteration(
  sessionId: string,
  input: WorktreeIterationRequestInput,
  dependencies?: AgentWorktreeIterationDependencies,
): Promise<{ requestId: string; iteration: number; details: string; summary: string; task: string }> {
  assertPortableWorktreeIterationText(input)
  const sanitizedDetails = sanitizeWorktreeIterationDetails(input.details)
  const sanitizedSummary = sanitizeWorktreeIterationSummary(input.summary)
  const sanitizedTask = sanitizeWorktreeReviewText(input.task).slice(0, 4000)
  if (!sanitizedDetails) throw new SessionCheckoutError('invalid_input', '下一轮修改正文不能为空')
  if (!sanitizedSummary) throw new SessionCheckoutError('invalid_input', '下一轮修改摘要不能为空')
  if (!sanitizedTask) throw new SessionCheckoutError('invalid_input', '下一轮修改任务不能为空')
  const resolved = dependencies ?? await getProductionDependencies()
  const target = await resolved.inspectTarget(sessionId)
  const delivery = target.delivery
  const completedIteration = delivery?.state === 'delivered' && target.checkout.phase === 'discarded'
    ? delivery.iteration
    : target.checkout.phase === 'discarded' && delivery === undefined
      ? target.checkout.iteration ?? null
      : delivery?.state === 'finalized' && target.checkout.phase === 'finalized'
        ? delivery.review.iteration
        : delivery?.state === 'retained' && target.checkout.phase === 'retained'
          ? delivery.review.iteration
          : null
  if (
    target.checkout.kind !== 'isolated'
    || target.ownership !== 'owner'
    || completedIteration === null
  ) {
    throw new SessionCheckoutError('operation_not_allowed', '当前会话不处于已提交、已交付、已放弃或保留状态')
  }
  const requestId = resolved.createRequestId()
  const iteration = completedIteration + 1
  resolved.persistMessages(sessionId, [{
    type: 'system',
    subtype: 'worktree_next_iteration_requested',
    session_id: sessionId,
    request_id: requestId,
    iteration,
    checkout_id: target.checkout.id,
    expected_revision: target.revision,
    details_markdown: sanitizedDetails,
    summary: sanitizedSummary,
    task: sanitizedTask,
    message: `需要创建第 ${iteration} 轮 Worktree 后继续原请求。`,
    _createdAt: Date.now(),
  } as unknown as SDKMessage])
  return { requestId, iteration, details: sanitizedDetails, summary: sanitizedSummary, task: sanitizedTask }
}

export async function requestWorktreePreviewRevision(
  sessionId: string,
  input: WorktreeIterationRequestInput,
  dependencies?: AgentWorktreeIterationDependencies,
): Promise<{ requestId: string; iteration: number; details: string; summary: string; task: string }> {
  assertPortableWorktreeIterationText(input)
  const sanitizedDetails = sanitizeWorktreeIterationDetails(input.details)
  const sanitizedSummary = sanitizeWorktreeIterationSummary(input.summary)
  const sanitizedTask = sanitizeWorktreeReviewText(input.task).slice(0, 4000)
  if (!sanitizedDetails) throw new SessionCheckoutError('invalid_input', '继续调整正文不能为空')
  if (!sanitizedSummary) throw new SessionCheckoutError('invalid_input', '继续调整摘要不能为空')
  if (!sanitizedTask) throw new SessionCheckoutError('invalid_input', '继续调整任务不能为空')
  const resolved = dependencies ?? await getProductionDependencies()
  const target = await resolved.inspectTarget(sessionId)
  if (target.checkout.kind !== 'isolated' || target.ownership !== 'owner' || target.delivery?.state !== 'preview_active') {
    throw new SessionCheckoutError('operation_not_allowed', '当前会话不处于正在 Local 验收的状态')
  }
  const requestId = resolved.createRequestId()
  const iteration = target.delivery.review.iteration
  resolved.persistMessages(sessionId, [{
    type: 'system',
    subtype: 'worktree_preview_revision_requested',
    session_id: sessionId,
    request_id: requestId,
    iteration,
    details_markdown: sanitizedDetails,
    summary: sanitizedSummary,
    task: sanitizedTask,
    message: `需要撤回第 ${iteration} 轮 Local Preview 后继续调整。`,
    _createdAt: Date.now(),
  } as unknown as SDKMessage])
  return { requestId, iteration, details: sanitizedDetails, summary: sanitizedSummary, task: sanitizedTask }
}

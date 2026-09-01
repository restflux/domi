import type {
  SDKMessage,
  SessionTargetView,
  WorktreeValidationItem,
  WorktreeValidationStatus,
} from '@domi/shared'
import { normalizeAgentCommitMessage } from './agent-commit-message.ts'
import { SessionCheckoutError, type MarkReadyForReviewInput } from './session-checkout/index.ts'

export interface AgentWorktreeReviewAvailabilityInput {
  targetKind?: 'local' | 'isolated'
  ownership?: 'owner' | 'inherited'
  triggeredBy?: 'user' | 'automation' | 'delegation' | 'bridge' | 'channel'
  sourceDelegationId?: string
}

export interface ReadyAgentWorktreeInput {
  /** 宿主会在验收卡之前渲染为会话正文。 */
  details: string
  summary: string
  validationStatus: WorktreeValidationStatus
  validationSummary?: string
  tests: WorktreeValidationItem[]
  suggestedCommitMessage: string
}

export interface AgentWorktreeReviewDependencies {
  markReadyForReview(sessionId: string, input: MarkReadyForReviewInput): Promise<SessionTargetView>
  persistMessages(sessionId: string, messages: SDKMessage[]): void
}

async function getProductionDependencies(): Promise<AgentWorktreeReviewDependencies> {
  const [{ getSessionCheckoutModule }, { appendSDKMessages }] = await Promise.all([
    import('./session-checkout/production.ts'),
    import('./agent-session-manager.ts'),
  ])
  return {
    markReadyForReview: (sessionId, input) => getSessionCheckoutModule().markReadyForReview(sessionId, input),
    persistMessages: appendSDKMessages,
  }
}

export function sanitizeWorktreeReviewText(value: string): string {
  return value
    .replace(/(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`]+/g, '[路径]')
    .replace(/(^|\s)\/(?:Users|home|tmp|var|opt|private|mnt|workspace|repo)(?:\/[^\s"'`]*)?/g, '$1[路径]')
    .replace(/refs\/domi\/[^\s"'`]+/g, '[内部引用]')
    .trim()
}

export const normalizeSuggestedCommitMessage = normalizeAgentCommitMessage

export function canOfferReadyForReview(input: AgentWorktreeReviewAvailabilityInput): boolean {
  return input.targetKind === 'isolated'
    && input.ownership === 'owner'
    && (input.triggeredBy ?? 'user') === 'user'
    && !input.sourceDelegationId
}

export function createWorktreeReviewNotice(sessionId: string, target: SessionTargetView): SDKMessage {
  if (target.checkout.kind !== 'isolated' || !target.delivery || !('review' in target.delivery)) {
    throw new SessionCheckoutError('operation_not_allowed', 'Worktree 没有可持久化的验收记录')
  }
  const review = target.delivery.review
  return {
    type: 'system',
    subtype: 'worktree_ready_for_review',
    session_id: sessionId,
    checkout_id: target.checkout.id,
    review_id: review.reviewId,
    iteration: review.iteration,
    details_markdown: review.detailsMarkdown,
    summary: review.summary,
    validation_status: review.validationStatus,
    validation_summary: review.validationSummary,
    tests: review.tests,
    changed_files: review.changedFiles,
    suggested_commit_message: review.suggestedCommitMessage,
    message: target.delivery.state === 'preview_active'
      ? 'Worktree 已同步为可撤回的 Local Preview。'
      : 'Worktree 已准备好同步到 Local 验收。',
    _createdAt: Date.now(),
  } as unknown as SDKMessage
}

export async function readyAgentWorktree(
  sessionId: string,
  input: ReadyAgentWorktreeInput,
  dependencies?: AgentWorktreeReviewDependencies,
): Promise<SessionTargetView> {
  const detailsMarkdown = sanitizeWorktreeReviewText(input.details)
  const summary = sanitizeWorktreeReviewText(input.summary).replace(/\s+/g, ' ').slice(0, 240)
  const suggestedCommitMessage = normalizeSuggestedCommitMessage(
    sanitizeWorktreeReviewText(input.suggestedCommitMessage),
  )
  if (!detailsMarkdown || !summary || !suggestedCommitMessage) {
    throw new SessionCheckoutError('invalid_input', '验收正文、摘要和建议提交信息不能为空')
  }
  if (detailsMarkdown.length > 12_000) {
    throw new SessionCheckoutError('invalid_input', '验收正文最多保留 12000 字符')
  }
  if (input.tests.length > 20) {
    throw new SessionCheckoutError('invalid_input', '验证项目最多保留 20 条')
  }
  const resolved = dependencies ?? await getProductionDependencies()
  const target = await resolved.markReadyForReview(sessionId, {
    detailsMarkdown,
    summary,
    validationStatus: input.validationStatus,
    suggestedCommitMessage,
    ...(input.validationSummary?.trim() ? { validationSummary: sanitizeWorktreeReviewText(input.validationSummary) } : {}),
    tests: input.tests.map((test) => ({
      command: sanitizeWorktreeReviewText(test.command),
      status: test.status,
      ...(test.summary?.trim() ? { summary: sanitizeWorktreeReviewText(test.summary) } : {}),
    })),
  })
  if (target.checkout.kind !== 'isolated' || target.delivery?.state !== 'ready_for_review') {
    throw new SessionCheckoutError('operation_not_allowed', 'Worktree 未进入可验收状态')
  }
  resolved.persistMessages(sessionId, [createWorktreeReviewNotice(sessionId, target)])
  return target
}

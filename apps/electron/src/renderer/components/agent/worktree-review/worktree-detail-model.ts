import type { SDKMessage, SDKSystemMessage, SessionTargetView } from '@domi/shared'
import { parseWorktreeIterationRequest } from './WorktreeIterationRequestCard.tsx'

export function currentReviewMessage(sessionId: string, target: SessionTargetView | null): SDKSystemMessage | null {
  const delivery = target?.delivery
  if (!target || !delivery || !('review' in delivery)) return null
  const review = delivery.review
  return {
    type: 'system', subtype: 'worktree_ready_for_review', session_id: sessionId,
    checkout_id: target.checkout.id, review_id: review.reviewId, iteration: review.iteration,
    details_markdown: review.detailsMarkdown, summary: review.summary,
    validation_status: review.validationStatus, validation_summary: review.validationSummary,
    tests: review.tests, changed_files: review.changedFiles,
    suggested_commit_message: review.suggestedCommitMessage,
    _createdAt: review.preparedAt,
  } as SDKSystemMessage
}

export function isCurrentIterationRequest(message: SDKSystemMessage, sessionId: string, target: SessionTargetView | null): boolean {
  const request = parseWorktreeIterationRequest(message)
  if (!request || !target || message.session_id !== sessionId) return false
  if (target.checkout.kind !== 'isolated' || target.ownership !== 'owner') return false
  if (typeof message.checkout_id === 'string' && message.checkout_id !== target.checkout.id) return false
  if (typeof message.expected_revision === 'number' && message.expected_revision !== target.revision) return false
  const delivery = target.delivery
  if (request.mode === 'preview_revision') {
    // 预览修订不更换 Checkout、不递增 iteration，确认续改后产生的新验收卡只能靠时间戳区分：
    // 请求早于当前验收卡，说明该请求已在上一轮续改中被消费，重新预览不得复活它。
    if (delivery?.state !== 'preview_active' || delivery.review.iteration !== request.iteration) return false
    return !(typeof message._createdAt === 'number'
      && message._createdAt < delivery.review.preparedAt)
  }
  return (delivery?.state === 'delivered' && target.checkout.phase === 'discarded' && delivery.iteration === request.iteration - 1)
    || (delivery?.state === 'finalized' && target.checkout.phase === 'finalized' && delivery.review.iteration === request.iteration - 1)
    || (delivery?.state === 'retained' && target.checkout.phase === 'retained' && delivery.review.iteration === request.iteration - 1)
    || (target.checkout.phase === 'discarded' && !delivery && target.checkout.iteration === request.iteration - 1)
}

export function findCurrentIterationRequest(messages: SDKMessage[], sessionId: string, target: SessionTargetView | null): SDKSystemMessage | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type === 'system' && message.subtype === 'task_notification') break
    // 更新的验收卡证明其下方所有续跑/续改请求已被确认或取代；越过它复活旧请求会把
    // 新预览误判成“待确认继续修改”，遮住撤回预览/确认保存的正常操作。
    if (message?.type === 'system' && message.subtype === 'worktree_ready_for_review') break
    if (message?.type === 'system' && (message.subtype === 'worktree_next_iteration_requested' || message.subtype === 'worktree_preview_revision_requested')) {
      // 新请求覆盖旧请求；即便它的 Checkout 已失效，也不能退回更早的任务。
      return isCurrentIterationRequest(message as SDKSystemMessage, sessionId, target) ? message as SDKSystemMessage : null
    }
  }
  return null
}

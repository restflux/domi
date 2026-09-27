import type { SDKSystemMessage, SessionTargetView } from '@domi/shared'
import { currentReviewMessage, isCurrentIterationRequest } from './worktree-detail-model.ts'

export interface WorktreeHeaderReviewAction {
  label: string
  message: SDKSystemMessage
}

/** 顶栏只提供当前会话的详情入口；执行资格仍由详情及宿主再次验证。 */
export function resolveWorktreeHeaderReviewAction(
  sessionId: string,
  target: SessionTargetView | null,
  pendingRequest: SDKSystemMessage | null,
): WorktreeHeaderReviewAction | null {
  if (!target || target.checkout.kind !== 'isolated' || target.ownership !== 'owner') return null
  if (pendingRequest && isCurrentIterationRequest(pendingRequest, sessionId, target)) {
    return {
      message: pendingRequest,
      label: pendingRequest.subtype === 'worktree_preview_revision_requested'
        ? '查看任务并确认继续修改' : '查看任务并确认下一轮',
    }
  }
  const delivery = target.delivery
  if (!delivery) return null
  const label = delivery.state === 'ready_for_review'
    ? '查看验收并预览修改'
    : delivery.state === 'preview_active'
      ? '查看预览并确认保存'
      : delivery.state === 'preview_detached'
        ? '查看预览状态与恢复操作'
        : null
  const message = label ? currentReviewMessage(sessionId, target) : null
  return label && message ? { label, message } : null
}

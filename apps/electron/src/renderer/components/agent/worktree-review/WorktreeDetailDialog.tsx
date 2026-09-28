import * as React from 'react'
import { atom, useAtom, useAtomValue } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { SDKSystemMessage } from '@domi/shared'
import { MessageResponse } from '@/components/ai-elements/message.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { sessionTargetStateAtomFamily } from '@/atoms/session-target-atoms.ts'
import { WorktreeReviewCard, parseWorktreeReviewNotice } from './WorktreeReviewCard.tsx'
import { WorktreeIterationRequestCard, parseWorktreeIterationRequest } from './WorktreeIterationRequestCard.tsx'
import { currentReviewMessage, isCurrentIterationRequest } from './worktree-detail-model.ts'

export type WorktreeDetailAction = 'commit' | 'checkpoint' | 'discard' | 'handoff'
interface WorktreeDetailSelection {
  message: SDKSystemMessage
  action?: WorktreeDetailAction
}
export const worktreeDetailSelectionAtomFamily = atomFamily((_sessionId: string) => atom<WorktreeDetailSelection | null>(null))

/** 详情只在当前会话内打开；历史消息提供内容，当前交付的操作资格始终由 Session Target 判定。 */
export function WorktreeDetailDialog({ sessionId, currentRequest }: { sessionId: string; currentRequest: SDKSystemMessage | null }): React.ReactElement {
  const [selection, select] = useAtom(worktreeDetailSelectionAtomFamily(sessionId))
  const state = useAtomValue(sessionTargetStateAtomFamily(sessionId))
  const message = selection?.message
  const review = message ? parseWorktreeReviewNotice(message) : null
  const request = message ? parseWorktreeIterationRequest(message) : null
  const currentReview = currentReviewMessage(sessionId, state.snapshot)
  const isActiveReview = review != null && currentReview != null
    && review.sessionId === sessionId && review.checkoutId === state.snapshot?.checkout.id
    && review.reviewId === currentReview.review_id && review.review.iteration === currentReview.iteration
  const isActiveRequest = message != null && request != null && currentRequest?.request_id === request.requestId
    && currentRequest.subtype === message.subtype && isCurrentIterationRequest(message, sessionId, state.snapshot)
  return (
    <Dialog open={selection !== null} onOpenChange={(open) => { if (!open) select(null) }}>
      <DialogContent data-worktree-detail-dialog className="max-h-[min(88vh,920px)] w-[min(900px,calc(100vw-32px))] max-w-none overflow-y-auto p-5 sm:p-6">
        <DialogHeader>
          <DialogTitle>{review ? `第 ${review.review.iteration} 轮验收` : request ? `第 ${request.iteration} 轮调整` : 'Worktree 详情'}</DialogTitle>
          <DialogDescription>{(review && !isActiveReview) || (request && !isActiveRequest) ? '历史记录 · 仅供回看' : '查看任务详情与当前操作'}</DialogDescription>
        </DialogHeader>
        {review && isActiveReview && currentReview ? <WorktreeReviewCard key={review.reviewId} message={currentReview} currentSessionId={sessionId} initialAction={selection?.action} /> : null}
        {review && !isActiveReview ? (
          <section data-worktree-history-review-details className="space-y-5 text-sm">
            <div className="rounded-xl bg-muted/35 p-4"><p className="text-xs text-muted-foreground">历史验收 · 第 {review.review.iteration} 轮</p><h3 className="mt-1 font-semibold">{review.review.summary}</h3><p className="mt-1 text-xs text-muted-foreground">此记录不能用于当前操作</p></div>
            <section className="space-y-2"><h3 className="font-medium">修改文件</h3><ul className="max-h-44 space-y-1 overflow-auto rounded-lg bg-muted/25 p-3 font-mono text-xs">{review.review.changedFiles.map((file) => <li key={file} className="break-all">{file}</li>)}</ul></section>
            <section className="space-y-2"><h3 className="font-medium">验证结果</h3><p className="text-xs text-muted-foreground">{review.review.validationStatus}{review.review.validationSummary ? ` · ${review.review.validationSummary}` : ''}</p>{review.review.tests.map((test, index) => <p key={`${index}-${test.command}`} className="break-all rounded-md bg-muted/25 px-3 py-2 font-mono text-xs">{test.status} · {test.command}{test.summary ? ` · ${test.summary}` : ''}</p>)}</section>
          </section>
        ) : null}
        {message && request && isActiveRequest ? <WorktreeIterationRequestCard key={request.requestId} message={message} currentSessionId={sessionId} /> : null}
        {message && request && !isActiveRequest ? <div className="space-y-3 text-sm"><p className="text-muted-foreground">{request.summary}</p><MessageResponse>{request.detailsMarkdown}</MessageResponse></div> : null}
      </DialogContent>
    </Dialog>
  )
}

import * as React from 'react'
import { atom, useAtom, useSetAtom, useAtomValue } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { SDKSystemMessage } from '@domi/shared'
import { Button } from '@/components/ui/button'
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

export function WorktreeHistoryEvent({ message, sessionId }: { message: SDKSystemMessage; sessionId?: string }): React.ReactElement | null {
  const select = useSetAtom(worktreeDetailSelectionAtomFamily(sessionId ?? ''))
  const review = parseWorktreeReviewNotice(message)
  const request = parseWorktreeIterationRequest(message)
  if (!review && !request) return null
  return (
    <div data-worktree-history-event={review ? 'review' : 'iteration'} className="my-2 flex min-w-0 items-center gap-2 rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">{review ? `第 ${review.review.iteration} 轮验收 · ${review.review.summary}` : `第 ${request?.iteration} 轮调整 · ${request?.summary}`}</span>
      {sessionId ? <Button type="button" size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={() => select({ message })}>查看详情</Button> : null}
    </div>
  )
}

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
          <section data-worktree-history-review-details className="space-y-4 text-sm">
            <p className="text-muted-foreground">{review.review.summary}</p>
            <MessageResponse>{review.detailsMarkdown}</MessageResponse>
            <div className="space-y-2 rounded-md bg-muted/30 p-3 text-xs text-muted-foreground">
              <p>验证：{review.review.validationStatus}{review.review.validationSummary ? ` · ${review.review.validationSummary}` : ''}</p>
              {review.review.tests.map((test, index) => <p key={`${index}-${test.command}`}>{test.status} · {test.command}{test.summary ? ` · ${test.summary}` : ''}</p>)}
              {review.review.changedFiles.map((file) => <p key={file} className="break-all">{file}</p>)}
              <p className="whitespace-pre-wrap break-words">{review.review.suggestedCommitMessage}</p>
            </div>
          </section>
        ) : null}
        {message && request && isActiveRequest ? <WorktreeIterationRequestCard key={request.requestId} message={message} currentSessionId={sessionId} /> : null}
        {message && request && !isActiveRequest ? <div className="space-y-3 text-sm"><p className="text-muted-foreground">{request.summary}</p><MessageResponse>{request.detailsMarkdown}</MessageResponse></div> : null}
      </DialogContent>
    </Dialog>
  )
}

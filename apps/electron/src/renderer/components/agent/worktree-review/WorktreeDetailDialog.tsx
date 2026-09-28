import * as React from 'react'
import { atom, useAtom, useAtomValue } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { SDKSystemMessage } from '@domi/shared'
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

export function shouldOpenWorktreeDetailDialog(selection: WorktreeDetailSelection | null, isActiveRequest: boolean): boolean {
  return selection !== null && selection.action !== 'commit'
    && (!parseWorktreeIterationRequest(selection.message) || isActiveRequest)
}

/** 历史验收仍可查阅文件与验证；已失效的下一轮请求不再弹出消息区已有的正文。 */
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
  React.useEffect(() => {
    if (selection && ((request && !isActiveRequest) || (selection.action === 'commit' && !isActiveReview))) select(null)
  }, [selection, request?.requestId, isActiveRequest, isActiveReview, select])
  return (
    <>
    <Dialog open={shouldOpenWorktreeDetailDialog(selection, isActiveRequest)} onOpenChange={(open) => { if (!open) select(null) }}>
      <DialogContent data-worktree-detail-dialog className={`max-h-[min(88vh,920px)] max-w-none overflow-y-auto p-5 sm:p-6 ${request ? 'w-[min(520px,calc(100vw-32px))]' : 'w-[min(900px,calc(100vw-32px))]'}`}>
        <DialogHeader>
          <DialogTitle>{review ? `第 ${review.review.iteration} 轮验收` : request ? `确认第 ${request.iteration} 轮调整` : 'Worktree 详情'}</DialogTitle>
          <DialogDescription>{review && !isActiveReview ? '历史验收 · 仅供回看' : request ? '确认后将继续执行当前任务' : '查看任务详情与当前操作'}</DialogDescription>
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
      </DialogContent>
    </Dialog>
    {selection?.action === 'commit' && review && currentReview && isActiveReview ? (
      <WorktreeReviewCard key={review.reviewId} message={currentReview} currentSessionId={sessionId} initialAction="commit" confirmationOnly onActionClose={() => select(null)} />
    ) : null}
    </>
  )
}

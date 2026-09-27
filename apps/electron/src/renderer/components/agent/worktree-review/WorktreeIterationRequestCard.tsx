import * as React from 'react'
import type { SDKSystemMessage } from '@domi/shared'
import { useAtomValue, useSetAtom } from 'jotai'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { confirmWorktreeIterationAtomFamily, operateSessionTargetAtomFamily, sessionTargetStateAtomFamily } from '@/atoms/session-target-atoms.ts'
import {
  cancelReservedWorktreeIterationResumeConsumer,
  dispatchWorktreeIterationResume,
  reserveWorktreeIterationResumeConsumer,
  type WorktreeIterationResumeDetail,
} from '@/lib/worktree-iteration-resume.ts'
import { worktreeOperationBusyLabel } from './worktree-review-busy-state.ts'

function normalizeLegacyWorktreeIterationRedactions(value: string): string {
  return value
    .replace(/(?:用户\s*)?Local Checkout\s*`?\[路径\]`?/gi, '当前项目的 Local Checkout')
    .replace(/(^|[\p{Script=Han}])\s*`?\[路径\]`?/gu, '$1当前项目的 Local Checkout')
    .replace(/`?\[路径\]`?/g, '当前项目的 Local Checkout')
    .replace(/`?\[内部引用\]`?/g, '内部引用已隐藏')
}

function buildLegacyWorktreeIterationSummary(task: string): string {
  const normalized = task.replace(/\s+/g, ' ').trim()
  return normalized.length > 160 ? `${normalized.slice(0, 159)}…` : normalized
}

export function parseWorktreeIterationRequest(message: SDKSystemMessage): Omit<WorktreeIterationResumeDetail, 'sessionId'> | null {
  const mode = message.subtype === 'worktree_preview_revision_requested'
    ? 'preview_revision'
    : message.subtype === 'worktree_next_iteration_requested'
      ? 'next_iteration'
      : null
  if (!mode) return null
  const requestId = typeof message.request_id === 'string' ? message.request_id.trim().slice(0, 100) : ''
  const iteration = typeof message.iteration === 'number' && Number.isSafeInteger(message.iteration) && message.iteration > 0
    ? message.iteration
    : 0
  const task = typeof message.task === 'string'
    ? normalizeLegacyWorktreeIterationRedactions(message.task).trim().slice(0, 4000)
    : ''
  if (!requestId || !iteration || !task) return null
  const suppliedSummary = typeof message.summary === 'string'
    ? normalizeLegacyWorktreeIterationRedactions(message.summary).replace(/\s+/g, ' ').trim().slice(0, 240)
    : ''
  const summary = suppliedSummary || buildLegacyWorktreeIterationSummary(task)
  const detailsMarkdown = typeof message.details_markdown === 'string' && message.details_markdown.trim()
    ? normalizeLegacyWorktreeIterationRedactions(message.details_markdown).trim().slice(0, 12_000)
    : `## 调整内容\n\n${task}`
  return { requestId, iteration, detailsMarkdown, summary, task, mode }
}

export function WorktreeIterationRequestCard({
  message,
  currentSessionId,
}: {
  message: SDKSystemMessage
  currentSessionId?: string
}): React.ReactElement | null {
  const request = parseWorktreeIterationRequest(message)
  const authoritativeSessionId = currentSessionId ?? ''
  const state = useAtomValue(sessionTargetStateAtomFamily(authoritativeSessionId))
  const confirmIteration = useSetAtom(confirmWorktreeIterationAtomFamily(authoritativeSessionId))
  const operate = useSetAtom(operateSessionTargetAtomFamily(authoritativeSessionId))
  const [starting, setStarting] = React.useState(false)
  if (!request || !authoritativeSessionId) return null

  const delivery = state.snapshot?.delivery
  const currentIteration = delivery?.state === 'working' || delivery?.state === 'delivered'
    ? delivery.iteration
    : delivery?.review.iteration
  const alreadyCreated = state.snapshot?.checkout.kind === 'isolated'
    && delivery?.state === 'working'
    && currentIteration === request.iteration
  const previewActive = delivery?.state === 'preview_active' && delivery.review.iteration === request.iteration
  const revisionReady = request.mode === 'preview_revision'
    && delivery?.state === 'working'
    && delivery.iteration === request.iteration
  const requestHandled = request.mode === 'preview_revision'
    ? !previewActive && !revisionReady
    : currentIteration !== undefined && currentIteration >= request.iteration && !alreadyCreated
  const actionPending = state.pendingAction !== null
  const refreshing = state.loading && state.pendingAction === null && !starting
  const cardBusy = !requestHandled && (starting || actionPending || refreshing)
  const busyLabel = requestHandled
    ? null
    : starting
      ? request.mode === 'preview_revision' ? '正在撤回验收…' : `正在创建第 ${request.iteration} 轮修改…`
      : state.pendingAction
        ? worktreeOperationBusyLabel(state.pendingAction)
        : refreshing
          ? '正在加载请求状态…'
          : null
  const canStartForState = request.mode === 'preview_revision'
    ? previewActive
    : (state.snapshot?.checkout.kind === 'isolated'
        && state.snapshot.ownership === 'owner'
        && state.snapshot.checkout.phase === 'discarded'
        && delivery === undefined
        && state.snapshot.checkout.iteration === request.iteration - 1)
      || (delivery?.state === 'delivered' && delivery.iteration === request.iteration - 1)
      || (delivery?.state === 'finalized'
        && state.snapshot?.checkout.phase === 'finalized'
        && delivery.review.iteration === request.iteration - 1)
      || (delivery?.state === 'retained' && delivery.review.iteration === request.iteration - 1)
  const canStart = canStartForState && !cardBusy

  const resume = (authorization?: { authorizationToken: string; continuationMessage: string }): void => {
    dispatchWorktreeIterationResume({ sessionId: authoritativeSessionId, ...request, ...authorization })
  }

  const start = async (): Promise<void> => {
    if (starting || state.loading || state.pendingAction) return
    reserveWorktreeIterationResumeConsumer(authoritativeSessionId, request.requestId)
    setStarting(true)
    try {
      if (request.mode === 'preview_revision') {
        const result = await operate({ action: 'rollback_preview', resumeRevision: true })
        if (result?.status === 'preview_rolled_back') resume()
      } else {
        const confirmed = await confirmIteration(request.requestId)
        if (confirmed) {
          resume({
            authorizationToken: confirmed.authorizationToken,
            continuationMessage: confirmed.continuationMessage,
          })
        }
      }
    } finally {
      cancelReservedWorktreeIterationResumeConsumer(authoritativeSessionId, request.requestId)
      setStarting(false)
    }
  }

  return (
    <div data-worktree-request-detail={request.requestId} className="space-y-5 text-sm" aria-busy={cardBusy} {...(cardBusy ? { inert: '' } : {})}>
      <section data-worktree-detail-section="request-status" className="space-y-2 rounded-xl bg-muted/35 p-4" aria-busy={cardBusy}>
        <p className="text-xs text-muted-foreground">第 {request.iteration} 轮 · {request.mode === 'preview_revision' ? '撤回预览后继续' : '创建新 Worktree'}</p>
        <h3 className="font-semibold">{request.summary}</h3>
        <p className="text-xs leading-5 text-muted-foreground">{request.mode === 'preview_revision'
          ? '确认后安全撤回当前预览，随后在原 Worktree 中继续。'
          : '确认后基于最新 Local HEAD 创建临时 Worktree，自动继续当前会话。'}</p>
        {state.error ? <p className="text-xs text-destructive">{state.error.message}</p> : null}
        {busyLabel ? <p role="status" aria-live="polite" className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{busyLabel}</p> : null}
      </section>
      <section data-worktree-detail-section="request-task" className="space-y-2">
        <h3 className="text-sm font-semibold">确认后执行的完整任务</h3>
        <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/25 p-3 text-xs leading-5">{request.task}</p>
      </section>
      <div data-worktree-detail-section="request-action" className="flex justify-end border-t pt-3">
              {requestHandled ? (
                <span className="text-xs text-muted-foreground">
                  {request.mode === 'preview_revision' ? '当前验收已撤回，调整请求已进入处理' : `本请求已进入第 ${request.iteration} 轮处理`}
                </span>
              ) : alreadyCreated || revisionReady ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={cardBusy}
                  onClick={() => request.mode === 'preview_revision' ? resume() : void start()}
                >
                  {request.mode === 'preview_revision' ? '继续调整' : '继续本轮任务'}
                </Button>
              ) : (
                <Button type="button" size="sm" disabled={!canStart} onClick={() => void start()}>
                  {request.mode === 'preview_revision' ? '撤回验收并继续修改' : `创建第 ${request.iteration} 轮 Worktree 并继续`}
                </Button>
              )}
      </div>
    </div>
  )
}

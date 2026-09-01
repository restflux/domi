import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  FolderOpen,
  GitBranchPlus,
  GitCommitHorizontal,
  Loader2,
  MoreHorizontal,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog.tsx'
import {
  bindSessionTargetAtomFamily,
  operateSessionTargetAtomFamily,
  sessionTargetStateAtomFamily,
} from '@/atoms/session-target-atoms.ts'
import { agentSessionsAtom } from '@/atoms/agent-atoms.ts'
import { useOpenSession } from '@/hooks/useOpenSession.ts'
import { ComposerActionRail } from '@/components/agent/ComposerActionRail.tsx'
import { openDialogAfterDropdownMenu } from '@/lib/open-dialog-after-dropdown-menu.ts'
import {
  createWorktreeApplyConflictResumeFromPreflight,
  dispatchWorktreeApplyConflictResume,
} from '@/lib/worktree-apply-conflict-resume.ts'
import {
  createWorktreeReviewRegenerationFromPreflight,
  dispatchWorktreeReviewRegeneration,
  isStaleIsolatedPreflight,
} from '@/lib/worktree-review-regeneration.ts'
import {
  WORKTREE_REVIEW_ACTION_EVENT,
  directFinishActionLabel,
  directFinishBlockReason,
  partitionCollaboratorsForBulkRelease,
  type WorktreeReviewActionDetail,
} from './WorktreeReviewCard.tsx'
import { worktreeOperationBusyLabel } from './worktree-review-busy-state.ts'

export function WorktreeReviewStatus({
  sessionId,
  railKind = 'worktree_active',
  legacySurface = false,
}: {
  sessionId: string
  railKind?: 'worktree_active' | 'worktree_settled'
  legacySurface?: boolean
}): React.ReactElement | null {
  const state = useAtomValue(sessionTargetStateAtomFamily(sessionId))
  const beginIteration = useSetAtom(bindSessionTargetAtomFamily(sessionId))
  const operate = useSetAtom(operateSessionTargetAtomFamily(sessionId))
  const agentSessions = useAtomValue(agentSessionsAtom)
  const openSession = useOpenSession()
  const [starting, setStarting] = React.useState(false)
  const [discardOpen, setDiscardOpen] = React.useState(false)
  const [retainedCleanupOpen, setRetainedCleanupOpen] = React.useState(false)
  const delivery = state.snapshot?.delivery
  if (
    !delivery
    || delivery.state === 'working'
    || (state.snapshot?.checkout.phase === 'discarded' && delivery.state !== 'delivered')
  ) return null

  const hasReview = delivery.state === 'ready_for_review'
    || delivery.state === 'preview_active'
    || delivery.state === 'preview_detached'
    || delivery.state === 'finalized'
    || delivery.state === 'retained'
  const reviewId = hasReview ? delivery.review.reviewId : null
  const savedCheckpoint = reviewId
    ? state.snapshot?.checkpoints?.find((checkpoint) => checkpoint.reviewId === reviewId)
    : undefined
  const collaborators = state.snapshot?.collaborators ?? []
  const blockedByCollaborator = collaborators.length > 0
  const bulkRelease = partitionCollaboratorsForBulkRelease(collaborators)
  const canReleaseAll = bulkRelease.canReleaseAll
  const recoveryPreview = delivery.state === 'preview_active' && state.snapshot?.checkout.phase === 'recovery_required'
  const waitingForSlot = delivery.state === 'ready_for_review' && state.snapshot?.reviewSlot === 'waiting'
  const directFinishBlock = directFinishBlockReason({ waitingForSlot, blockedByCollaborator, canReleaseAll })
  const directFinishLabel = directFinishActionLabel({
    waitingForSlot,
    blockedByCollaborator,
    canReleaseAll,
    releasableCount: bulkRelease.releasable.length,
  })
  const preflight = state.preflight
  const staleIsolatedPreflight = isStaleIsolatedPreflight(preflight) ? preflight : null
  const reviewSlotOwnerSessionId = waitingForSlot ? state.snapshot?.reviewSlotOwnerSessionId : undefined
  const operationPending = state.pendingAction !== null
  const refreshing = (state.loading || state.preflightLoading === true) && state.pendingAction === null
  const pending = operationPending || refreshing || starting
  const busyLabel = state.pendingAction
    ? worktreeOperationBusyLabel(state.pendingAction)
    : starting
      ? '正在创建下一轮修改…'
      : state.preflightLoading
        ? '正在检查是否可以安全预览…'
        : refreshing
          ? '正在加载验收状态…'
          : null
  const canReveal = state.snapshot?.checkout.phase !== 'discarded'
  const hasMenuActions = reviewId !== null || canReveal || delivery.state === 'retained'

  const label = delivery.state === 'ready_for_review'
    ? preflight?.status === 'conflict'
      ? `本次修改暂时无法预览 · ${preflight.conflictingFiles.length} 个文件冲突`
      : preflight?.status === 'blocked'
        ? `暂时无法预览 · ${preflight.message}`
        : preflight?.status === 'local_advanced'
          ? '修改已完成，已确认可以安全合并后预览'
          : preflight?.status === 'already_in_local'
            ? '修改已完成，内容已在当前项目中'
            : savedCheckpoint
              ? `进度 ${savedCheckpoint.sequence} 已保存，可以预览或继续修改`
              : '修改已完成，等待你预览确认'

    : delivery.state === 'preview_active'
      ? recoveryPreview ? '预览需要恢复，安全记录已保留' : '正在预览本次修改，确认后即可保存'
      : delivery.state === 'preview_detached'
        ? '当前项目已有新变化，本次修改仍可保存'
      : delivery.state === 'finalized'
        ? '修改已保存，运行环境清理待重试'
        : delivery.state === 'retained'
          ? `修改已保存，运行环境已保留${delivery.commitOid ? ` · ${delivery.commitOid.slice(0, 8)}` : ''}`
          : `本轮修改已保存${delivery.commitOid ? ` · ${delivery.commitOid.slice(0, 8)}` : ''}`
  const Icon = delivery.state === 'ready_for_review'
    ? Clock3
    : delivery.state === 'preview_active'
      ? GitCommitHorizontal
      : delivery.state === 'preview_detached'
        ? AlertTriangle
        : CheckCircle2
  const compactActiveSurface = railKind === 'worktree_active'
    && !legacySurface
    && reviewId !== null
    && (delivery.state === 'ready_for_review'
      || delivery.state === 'preview_active'
      || delivery.state === 'preview_detached'
      || delivery.state === 'finalized')
  const compactLabel = delivery.state === 'ready_for_review'
    ? preflight?.status === 'conflict' || preflight?.status === 'blocked'
      ? label
      : '新修改待验收'
    : delivery.state === 'preview_active'
      ? recoveryPreview ? label : '正在预览本次修改'
      : delivery.state === 'preview_detached' || delivery.state === 'finalized'
        ? label
        : label
  const compactToneClass = delivery.state === 'ready_for_review'
    && preflight?.status !== 'conflict'
    && preflight?.status !== 'blocked'
    ? 'bg-sky-400'
    : 'bg-amber-400'
  const fallbackIconClass = delivery.state === 'retained' && delivery.cleanup === 'blocked'
    ? 'text-amber-500'
    : delivery.state === 'retained' || delivery.state === 'delivered'
      ? 'text-emerald-500'
      : 'text-blue-500'

  const focusCard = (): void => {
    if (!reviewId) return
    document.querySelector<HTMLElement>(`[data-worktree-review-id="${CSS.escape(reviewId)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const openCheckpointDialogOnCard = (): void => {
    if (!reviewId) return
    window.dispatchEvent(new CustomEvent<WorktreeReviewActionDetail>(WORKTREE_REVIEW_ACTION_EVENT, {
      detail: { reviewId, action: 'checkpoint' },
    }))
    focusCard()
  }

  const openHandoffDialogOnCard = (): void => {
    if (!reviewId) return
    window.dispatchEvent(new CustomEvent<WorktreeReviewActionDetail>(WORKTREE_REVIEW_ACTION_EVENT, {
      detail: { reviewId, action: 'handoff' },
    }))
    focusCard()
  }

  const openCommitDialogOnCard = (): void => {
    if (!reviewId || directFinishBlock) return
    window.dispatchEvent(new CustomEvent<WorktreeReviewActionDetail>(WORKTREE_REVIEW_ACTION_EVENT, {
      detail: { reviewId, action: 'commit' },
    }))
    focusCard()
  }

  const revealWorktree = (): void => {
    const checkoutId = state.snapshot?.checkout.id
    if (!checkoutId) return
    void window.electronAPI.sessionCheckout.revealManaged?.({ checkoutId }).then((result) => {
      if (result && !result.ok) toast.error('无法打开 Worktree', { description: result.error.message })
    }).catch((error) => {
      toast.error('无法打开 Worktree', {
        description: error instanceof Error ? error.message : '打开工作位置失败',
      })
    })
  }

  const openReviewSlotOwner = (): void => {
    if (!reviewSlotOwnerSessionId) {
      toast.error('无法定位占用任务', { description: '验收槽位占用信息尚未刷新，请稍后重试。' })
      return
    }
    const ownerSession = agentSessions.find((session) => session.id === reviewSlotOwnerSessionId)
    if (!ownerSession) {
      toast.error('无法打开占用任务', { description: '占用该验收槽位的会话当前不可用。' })
      return
    }
    openSession('agent', ownerSession.id, ownerSession.title)
  }

  const startNextIteration = (): void => {
    setStarting(true)
    void beginIteration('isolated').finally(() => setStarting(false))
  }

  const primaryAction = (): void => {
    if (delivery.state === 'ready_for_review') {
      if (staleIsolatedPreflight) {
        dispatchWorktreeReviewRegeneration(createWorktreeReviewRegenerationFromPreflight(sessionId, staleIsolatedPreflight))
        toast.info('已请求 Agent 重新生成验收结果', { description: 'Agent 会保持 Read Only 重新验证；Local 不会被修改。' })
      } else if (preflight?.status === 'conflict') {
        dispatchWorktreeApplyConflictResume(createWorktreeApplyConflictResumeFromPreflight(sessionId, preflight))
        toast.info('已让 Agent 在原 Worktree 中解决冲突', { description: 'Local 未修改；解决并验证后会重新请求同步确认。' })
      } else if (waitingForSlot) {
        openReviewSlotOwner()
      } else {
        void operate({ action: 'preview' })
      }
      return
    }
    if (delivery.state === 'preview_active') {
      if (recoveryPreview) void operate({ action: 'rollback_preview' })
      else openCommitDialogOnCard()
      return
    }
    if (delivery.state === 'preview_detached') {
      openCommitDialogOnCard()
      return
    }
    if (delivery.state === 'finalized' || (delivery.state === 'retained' && delivery.cleanup === 'blocked')) {
      void operate({ action: 'retry_cleanup' })
      return
    }
    startNextIteration()
  }

  const primaryLabel = delivery.state === 'ready_for_review'
    ? staleIsolatedPreflight ? '重新检查' : preflight?.status === 'conflict' ? '让 Agent 解决冲突' : waitingForSlot ? '查看占用任务' : '预览修改'
    : delivery.state === 'preview_active'
      ? recoveryPreview ? '恢复并撤回预览' : blockedByCollaborator && canReleaseAll ? `结束 ${bulkRelease.releasable.length} 个占用并保存` : '确认并保存'
      : delivery.state === 'preview_detached'
        ? blockedByCollaborator && canReleaseAll ? `结束 ${bulkRelease.releasable.length} 个占用并保存` : '保存修改'
      : delivery.state === 'finalized' || (delivery.state === 'retained' && delivery.cleanup === 'blocked')
        ? '重试清理环境'
        : '开始下一轮修改'
  const acceptanceBusyNavigation = waitingForSlot
    && preflight?.status === 'blocked'
    && preflight.reason === 'project_acceptance_busy'
  const primaryDisabled = pending
    || (delivery.state === 'ready_for_review' && preflight?.status === 'blocked' && !staleIsolatedPreflight && !acceptanceBusyNavigation)
    || (
      ((delivery.state === 'preview_active' && !recoveryPreview) || delivery.state === 'preview_detached')
      && blockedByCollaborator
      && !canReleaseAll
    )

  return (
    <>
      <ComposerActionRail
        dataKind={railKind}
        dataTestId="worktree-review-status"
        className={legacySurface
          ? 'legacy-worktree-review-status mx-3 mt-2 rounded-md border-blue-500/20 bg-blue-500/5'
          : compactActiveSurface
            ? 'mx-2 rounded-none border-0 bg-transparent px-1.5 py-1'
            : undefined}
        icon={busyLabel
          ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          : compactActiveSurface
            ? <span className={`size-2 rounded-full ${compactToneClass}`} />
            : <Icon className={`size-3.5 ${fallbackIconClass}`} />}
        actions={(
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={compactActiveSurface ? 'h-6 shrink-0 px-2 text-[11px] text-foreground/80' : 'h-6 shrink-0 px-2 text-[11px]'}
              disabled={compactActiveSurface ? pending : primaryDisabled}
              onClick={compactActiveSurface ? focusCard : primaryAction}
            >
              {compactActiveSurface ? <><ClipboardCheck className="size-3.5" />查看验收卡</> : primaryLabel}
            </Button>
            {hasMenuActions ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon-sm" className="size-6 shrink-0" disabled={pending} aria-label="更多交付操作">
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="z-[9999] min-w-56">
                  {reviewId ? (
                    <DropdownMenuItem onSelect={focusCard}>
                      <ClipboardCheck />查看验收卡
                    </DropdownMenuItem>
                  ) : null}
                  {canReveal ? (
                    <DropdownMenuItem onSelect={revealWorktree}>
                      <FolderOpen />打开当前工作位置
                    </DropdownMenuItem>
                  ) : null}
                  {delivery.state === 'ready_for_review' ? (
                    <>
                      <DropdownMenuSeparator />
                      {!savedCheckpoint ? (
                        <DropdownMenuItem disabled={blockedByCollaborator} onSelect={openCheckpointDialogOnCard}>
                          <GitCommitHorizontal />保存阶段并继续
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem
                        disabled={directFinishBlock !== null}
                        onSelect={openCommitDialogOnCard}
                      >
                        <GitCommitHorizontal />{directFinishLabel}
                      </DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive" onSelect={() => openDialogAfterDropdownMenu(() => setDiscardOpen(true))}>
                        <Trash2 />放弃任务
                      </DropdownMenuItem>
                    </>
                  ) : null}
                  {delivery.state === 'preview_active' ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem disabled={pending || blockedByCollaborator} onSelect={openCheckpointDialogOnCard}>
                        <GitCommitHorizontal />保存阶段并继续
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={pending} onSelect={() => void operate({ action: 'rollback_preview' })}>
                        <RotateCcw />撤回本次预览
                      </DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive" onSelect={() => openDialogAfterDropdownMenu(() => setDiscardOpen(true))}>
                        <Trash2 />放弃任务
                      </DropdownMenuItem>
                    </>
                  ) : null}
                  {delivery.state === 'preview_detached' ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem disabled={directFinishBlock !== null} onSelect={openCommitDialogOnCard}>
                        <GitCommitHorizontal />{directFinishLabel}
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={pending} onSelect={() => void operate({ action: 'rollback_preview' })}>
                        <RotateCcw />重新尝试撤回
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={pending} onSelect={openHandoffDialogOnCard}>
                        <GitBranchPlus />交接到新会话
                      </DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive" onSelect={() => openDialogAfterDropdownMenu(() => setDiscardOpen(true))}>
                        <Trash2 />放弃 Worktree
                      </DropdownMenuItem>
                    </>
                  ) : null}
                  {delivery.state === 'retained' ? (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => openDialogAfterDropdownMenu(() => setRetainedCleanupOpen(true))}>
                        <Trash2 />清理保留环境
                      </DropdownMenuItem>
                    </>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </>
        )}
      >
        {busyLabel ?? (compactActiveSurface ? compactLabel : label)}
      </ComposerActionRail>
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃本轮任务？</AlertDialogTitle>
            <AlertDialogDescription>
              {delivery.state === 'preview_active'
                ? '放弃任务不会撤回 Local Preview。若 Preview 已被提交，Domi 只清理 Worktree；若仍未提交或状态无法证明，操作会停止并保留恢复证据。'
                : delivery.state === 'preview_detached'
                  ? '旧验收已经解除，Local 不会被修改。Worktree 中尚未交付的修改将被永久丢弃，Preview 恢复证据也会一并清理。'
                  : 'Worktree 中尚未交付的修改将被永久丢弃，Local 不受影响。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() => {
                setDiscardOpen(false)
                void operate({ action: 'discard', confirmDirty: true })
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              确认放弃任务
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={retainedCleanupOpen} onOpenChange={setRetainedCleanupOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清理保留的 Worktree？</AlertDialogTitle>
            <AlertDialogDescription>
              当前 Worktree 已经提交并处于保留状态。清理后将删除运行环境，但不会影响已经创建的 Commit。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() => {
                setRetainedCleanupOpen(false)
                void operate({ action: 'retry_cleanup' })
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              确认清理环境
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

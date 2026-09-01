import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { ApplyBaseStrategy, SDKSystemMessage, WorktreeApplyPreflightView, WorktreeCollaboratorStatus, WorktreeCollaboratorView, WorktreeDeliveryProofView, WorktreeRetentionMode, WorktreeReviewView } from '@domi/shared'
import { AlertTriangle, ChevronDown, ChevronUp, ExternalLink, FileText, GitBranchPlus, GitCommitHorizontal, Loader2, MoreHorizontal, RefreshCw, RotateCcw, ShieldCheck, TestTube2, Trash2, Unplug } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { MessageResponse } from '@/components/ai-elements/message.tsx'
import { Textarea } from '@/components/ui/textarea.tsx'
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx'
import { useOpenSession } from '@/hooks/useOpenSession.ts'
import { openDialogAfterDropdownMenu } from '@/lib/open-dialog-after-dropdown-menu.ts'
import { getSessionHandoffFeedback } from '@/lib/session-handoff-feedback.ts'
import { worktreeOperationBusyLabel } from './worktree-review-busy-state.ts'
import { agentSessionsAtom, agentSessionStreamingStateAtomFamily } from '@/atoms/agent-atoms.ts'
import {
  createWorktreeReviewRegenerationFromPreflight,
  dispatchWorktreeReviewRegeneration,
  isStaleIsolatedPreflight,
} from '@/lib/worktree-review-regeneration.ts'
import {
  createWorktreeApplyConflictResumeFromPreflight,
  dispatchWorktreeApplyConflictResume,
} from '@/lib/worktree-apply-conflict-resume.ts'
import {
  inspectSessionTargetAtomFamily,
  preflightSessionTargetAtomFamily,
  operateSessionTargetAtomFamily,
  sessionTargetStateAtomFamily,
  type SessionTargetState,
} from '@/atoms/session-target-atoms.ts'

export interface ParsedReviewNotice {
  sessionId: string
  checkoutId: string
  reviewId: string
  /** 在卡片之前作为会话正文渲染，避免终止型工具吞掉模型前置文本。 */
  detailsMarkdown: string
  review: WorktreeReviewView
}

export const WORKTREE_REVIEW_ACTION_EVENT = 'domi:worktree-review-action'
export type WorktreeReviewAction = 'commit' | 'checkpoint' | 'discard' | 'handoff'
export interface WorktreeReviewActionDetail {
  reviewId: string
  action: WorktreeReviewAction
}

export function directFinishBlockReason({
  waitingForSlot,
  blockedByCollaborator,
  canReleaseAll,
}: {
  waitingForSlot: boolean
  blockedByCollaborator: boolean
  canReleaseAll: boolean
}): string | null {
  if (waitingForSlot) {
    return '另一个任务正在预览此项目的修改。请先完成或撤回该预览，再保存本轮修改。'
  }
  if (blockedByCollaborator && !canReleaseAll) return '请先停止或等待仍在运行的协作会话，再释放 Worktree 占用。'
  return null
}

export function directFinishAction(input: {
  waitingForSlot: boolean
  blockedByCollaborator: boolean
  canReleaseAll: boolean
}): 'blocked' | 'release_collaborators' | 'open_commit' {
  if (directFinishBlockReason(input)) return 'blocked'
  return input.blockedByCollaborator ? 'release_collaborators' : 'open_commit'
}

export function directFinishActionLabel({
  waitingForSlot,
  blockedByCollaborator,
  canReleaseAll,
  releasableCount,
}: {
  waitingForSlot: boolean
  blockedByCollaborator: boolean
  canReleaseAll: boolean
  releasableCount: number
}): string {
  if (waitingForSlot) return '跳过预览并保存（等待其他任务）'
  if (blockedByCollaborator) {
    return canReleaseAll ? `结束 ${releasableCount} 个占用并保存` : '跳过预览并保存（协作占用未结束）'
  }
  return '跳过预览并保存'
}

function buildLegacyWorktreeReviewDetails(
  summary: string,
  validationStatus: WorktreeReviewView['validationStatus'],
  validationSummary: string | undefined,
  tests: WorktreeReviewView['tests'],
  suggestedCommitMessage: string,
): string {
  const statusLabel = validationStatus === 'passed'
    ? '自动验证通过'
    : validationStatus === 'failed'
      ? '自动验证失败'
      : validationStatus === 'partial'
        ? '部分验证通过'
        : '未运行自动验证'
  const testLines = tests.length > 0
    ? tests.map((test) => `- ${test.status === 'passed' ? '通过' : test.status === 'failed' ? '失败' : '未运行'}：${test.command}${test.summary ? ` — ${test.summary}` : ''}`)
    : ['- 未记录单独测试命令']
  const commitBlock = suggestedCommitMessage.split('\n').map((line) => `    ${line}`).join('\n')
  return [
    '## 变更说明',
    summary,
    '## 验证结果',
    validationSummary || statusLabel,
    ...testLines,
    '## 建议 Commit Message',
    commitBlock,
  ].join('\n\n')
}

export function parseWorktreeReviewNotice(message: SDKSystemMessage): ParsedReviewNotice | null {
  if (
    typeof message.session_id !== 'string'
    || typeof message.checkout_id !== 'string'
    || typeof message.review_id !== 'string'
    || typeof message.iteration !== 'number'
    || typeof message.summary !== 'string'
    || typeof message.validation_status !== 'string'
    || !Array.isArray(message.tests)
    || !Array.isArray(message.changed_files)
    || typeof message.suggested_commit_message !== 'string'
  ) return null
  if (!['passed', 'failed', 'partial', 'not_run'].includes(message.validation_status)) return null
  const tests = message.tests.flatMap((test) => {
    if (!test || typeof test !== 'object') return []
    const item = test as Record<string, unknown>
    if (typeof item.command !== 'string' || !['passed', 'failed', 'not_run'].includes(String(item.status))) return []
    return [{
      command: item.command,
      status: item.status as 'passed' | 'failed' | 'not_run',
      ...(typeof item.summary === 'string' ? { summary: item.summary } : {}),
    }]
  })
  const validationStatus = message.validation_status as WorktreeReviewView['validationStatus']
  const validationSummary = typeof message.validation_summary === 'string' ? message.validation_summary : undefined
  const detailsMarkdown = typeof message.details_markdown === 'string' && message.details_markdown.trim()
    ? message.details_markdown.trim().slice(0, 12_000)
    : buildLegacyWorktreeReviewDetails(
        message.summary,
        validationStatus,
        validationSummary,
        tests,
        message.suggested_commit_message,
      )
  return {
    sessionId: message.session_id,
    checkoutId: message.checkout_id,
    reviewId: message.review_id,
    detailsMarkdown,
    review: {
      reviewId: message.review_id,
      iteration: message.iteration,
      preparedAt: typeof message._createdAt === 'number' ? message._createdAt : Date.now(),
      summary: message.summary,
      validationStatus,
      ...(validationSummary ? { validationSummary } : {}),
      tests,
      changedFiles: message.changed_files.filter((path): path is string => typeof path === 'string'),
      suggestedCommitMessage: message.suggested_commit_message,
    },
  }
}

export function isWorktreeReviewIdentityAuthorized(currentSessionId: string | undefined, notice: ParsedReviewNotice): boolean {
  return typeof currentSessionId === 'string' && currentSessionId === notice.sessionId
}

function validationLabel(status: WorktreeReviewView['validationStatus']): string {
  if (status === 'passed') return '自动验证通过'
  if (status === 'failed') return '自动验证失败，仍可继续验收'
  if (status === 'partial') return '部分验证通过'
  return '未运行自动验证'
}

export function partitionCollaboratorsForBulkRelease(collaborators: WorktreeCollaboratorView[]): {
  releasable: WorktreeCollaboratorView[]
  blocked: WorktreeCollaboratorView[]
  canReleaseAll: boolean
} {
  const releasable = collaborators.filter((collaborator) => collaborator.canRelease)
  const blocked = collaborators.filter((collaborator) => !collaborator.canRelease)
  return { releasable, blocked, canReleaseAll: collaborators.length > 0 && blocked.length === 0 }
}

function collaboratorStatusLabel(status: WorktreeCollaboratorStatus): string {
  if (status === 'running') return '运行中'
  if (status === 'idle') return '已停止'
  if (status === 'completed') return '已完成'
  if (status === 'failed') return '失败'
  if (status === 'cancelled') return '已取消'
  if (status === 'interrupted') return '已中断'
  return '状态未知'
}

function shortOid(oid: string): string {
  return oid.slice(0, 8)
}

function applyBaseStrategyLabel(strategy: ApplyBaseStrategy): string {
  if (strategy === 'isolated_contains_local_head') return 'Worktree 已基于当前 Local'
  if (strategy === 'local_contains_isolated_head') return 'Local 已包含 Worktree 提交'
  if (strategy === 'shared_merge_base') return '使用双方共享 Git 基线'
  return '使用本轮记录基线'
}

export function worktreePreflightSummary(preflight: WorktreeApplyPreflightView): string {
  if (preflight.status === 'ready') return `可以安全预览 · ${preflight.changedFiles.length} 个文件`
  if (preflight.status === 'local_advanced') return 'Local 有新变化，Domi 已确认可以安全合并后预览'
  if (preflight.status === 'already_in_local') return '本轮修改已在 Local，无需重复预览'
  if (preflight.status === 'conflict') return `暂时无法预览：${preflight.conflictingFiles.length} 个文件存在冲突`
  if (preflight.status === 'blocked' && preflight.reason === 'project_acceptance_busy') return '另一个任务正在预览此项目的修改'
  if (preflight.status === 'blocked') return `暂时无法预览：${preflight.message}`
  return '安全检查状态未知，请刷新后重试'
}

export function worktreeDeliveryProofSummary(proof: WorktreeDeliveryProofView, commitOid: string | null): string {
  if (!commitOid) return `本轮无新增 Commit · ${proof.changedFiles.length} 个文件已在 Local`
  if (proof.commitInLocalHistory === true) return `Commit ${shortOid(commitOid)} 已证明仍在 Local 历史中`
  if (proof.commitInLocalHistory === false) return `Commit ${shortOid(commitOid)} 当前不在 Local HEAD 历史中`
  return `Commit ${shortOid(commitOid)} 的 Local ancestry 暂时无法确认`
}

export function nextAutomaticPreflightKey(
  currentSessionId: string | undefined,
  notice: ParsedReviewNotice | null,
  state: Pick<SessionTargetState, 'snapshot' | 'preflight' | 'preflightLoading' | 'preflightError'>,
  previousAttemptKey: string | null,
): string | null {
  const delivery = state.snapshot?.delivery
  if (
    notice === null
    || currentSessionId !== notice.sessionId
    || state.snapshot?.checkout.id !== notice.checkoutId
    || delivery?.state !== 'ready_for_review'
    || delivery.review.reviewId !== notice.reviewId
    || state.preflight?.revision === state.snapshot.revision
    || state.preflightLoading === true
    || state.preflightError != null
  ) return null
  const key = [notice.sessionId, notice.checkoutId, notice.reviewId, state.snapshot.revision, state.snapshot.reviewSlot ?? 'unknown'].join(':')
  return key === previousAttemptKey ? null : key
}

function PreflightDetails({
  preflight,
  loading,
  error,
  onRetry,
}: {
  preflight: WorktreeApplyPreflightView | null | undefined
  loading: boolean
  error: SessionTargetState['preflightError']
  onRetry: () => void
}): React.ReactElement {
  if (loading && !preflight) return <></>
  if (!preflight && error) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/25 bg-amber-500/5 p-2 text-[11px] text-amber-700 dark:text-amber-300">
        <span className="min-w-0 flex-1">安全检查失败：{error.message}</span>
        <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={onRetry}>
          <RefreshCw className="size-3" />重新检查
        </Button>
      </div>
    )
  }
  if (!preflight) return <div className="rounded-md border bg-background/40 p-2 text-[11px] text-muted-foreground">点击“预览本次修改”时，Domi 会先完成实时安全检查。</div>
  if (preflight.status === 'blocked') {
    const guidance = preflight.reason === 'project_acceptance_busy'
      ? '请先完成或撤回该预览，再处理本轮。'
      : '检查过程不会修改 Local。'
    return <div className="rounded-md border border-amber-500/25 bg-amber-500/5 p-2 text-[11px] text-amber-700 dark:text-amber-300">{worktreePreflightSummary(preflight)}<div className="mt-1 text-[10px]">{guidance}</div></div>
  }
  return (
    <div className={`rounded-md border p-2 text-[11px] ${preflight.status === 'conflict' ? 'border-amber-500/25 bg-amber-500/5' : 'border-emerald-500/20 bg-emerald-500/5'}`}>
      <div className="font-medium text-foreground">{worktreePreflightSummary(preflight)}</div>
      {preflight.status !== 'conflict' ? <div className="mt-1 text-[10px] text-muted-foreground">预览可撤回，不会立即创建 Commit。</div> : null}
      {preflight.status === 'conflict' ? (
        <ul className="mt-1.5 space-y-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-300">
          {preflight.conflictingFiles.slice(0, 12).map((file) => <li key={file}>{file}</li>)}
          {preflight.conflictingFiles.length > 12 ? <li>…另有 {preflight.conflictingFiles.length - 12} 个文件</li> : null}
        </ul>
      ) : null}
      <details className="mt-1 text-[10px] text-muted-foreground">
        <summary className="cursor-pointer select-none transition-colors hover:text-foreground">技术详情</summary>
        <div className="mt-1 grid gap-x-3 gap-y-0.5 sm:grid-cols-2">
          <span>本轮基线 {shortOid(preflight.configuredBaseOid)}</span>
          <span>有效基线 {shortOid(preflight.effectiveBaseOid)}</span>
          <span>Worktree {shortOid(preflight.isolatedHeadOid)}</span>
          <span>Local {preflight.localBranch ?? 'Detached'} · {shortOid(preflight.localHeadOid)}</span>
          <span>{applyBaseStrategyLabel(preflight.baseStrategy)}</span>
          <span>{preflight.changedFiles.length} 个变更文件</span>
          <span className="sm:col-span-2">预览前会重新校验 revision、HEAD、branch、fingerprint 和 Worktree identity。</span>
        </div>
      </details>
    </div>
  )
}

export function WorktreeReviewCard({
  message,
  currentSessionId,
}: {
  message: SDKSystemMessage
  currentSessionId?: string
}): React.ReactElement | null {
  const notice = parseWorktreeReviewNotice(message)
  const operationSessionId = currentSessionId ?? 'invalid-review'
  const state = useAtomValue(sessionTargetStateAtomFamily(operationSessionId))
  const agentSessions = useAtomValue(agentSessionsAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const agentStreamState = useAtomValue(agentSessionStreamingStateAtomFamily(operationSessionId))
  const inspect = useSetAtom(inspectSessionTargetAtomFamily(operationSessionId))
  const preflight = useSetAtom(preflightSessionTargetAtomFamily(operationSessionId))
  const operate = useSetAtom(operateSessionTargetAtomFamily(operationSessionId))
  const openSession = useOpenSession()
  const [commitOpen, setCommitOpen] = React.useState(false)
  const [checkpointOpen, setCheckpointOpen] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [discardOpen, setDiscardOpen] = React.useState(false)
  const [releaseTarget, setReleaseTarget] = React.useState<WorktreeCollaboratorView | null>(null)
  const [releaseAllOpen, setReleaseAllOpen] = React.useState(false)
  const [handoffOpen, setHandoffOpen] = React.useState(false)
  const [handoffStarting, setHandoffStarting] = React.useState(false)
  const [commitMessage, setCommitMessage] = React.useState(notice?.review.suggestedCommitMessage ?? '')
  const [checkpointMessage, setCheckpointMessage] = React.useState(notice?.review.suggestedCommitMessage ?? '')
  const [retention, setRetention] = React.useState<WorktreeRetentionMode>('cleanup')
  const [slotReleased, setSlotReleased] = React.useState(false)
  const [detailsExpanded, setDetailsExpanded] = React.useState(false)
  const [regenerationRequested, setRegenerationRequested] = React.useState(false)
  const previousSlot = React.useRef<'available' | 'waiting' | undefined>(undefined)
  const automaticPreflightAttempt = React.useRef<string | null>(null)
  const regenerationObservedRunning = React.useRef(false)

  React.useEffect(() => {
    // 验收卡挂载时已有持久化卡片和 Session Target 元数据，刷新属于后台校准。
    // 若前一个 checkout mutation 尚在串行队列中，不要因 inspect 等待超时清空现有 UI。
    if (notice && currentSessionId === notice.sessionId) void inspect({ silent: true })
  }, [currentSessionId, inspect, notice?.sessionId])

  React.useEffect(() => {
    const attemptKey = nextAutomaticPreflightKey(currentSessionId, notice, state, automaticPreflightAttempt.current)
    if (!attemptKey) return
    automaticPreflightAttempt.current = attemptKey
    void preflight()
  }, [currentSessionId, notice?.checkoutId, notice?.reviewId, notice?.sessionId, preflight, state.preflight?.revision, state.preflightError, state.preflightLoading, state.snapshot])

  React.useEffect(() => {
    const slot = state.snapshot?.reviewSlot
    if (previousSlot.current === 'waiting' && slot === 'available') setSlotReleased(true)
    previousSlot.current = slot
    const collaboratorRunning = state.snapshot?.collaborators?.some((collaborator) => collaborator.status === 'running') ?? false
    if (slot !== 'waiting' && !collaboratorRunning) return
    const timer = window.setInterval(() => { void inspect({ silent: true }) }, 2_000)
    return () => window.clearInterval(timer)
  }, [inspect, state.snapshot?.collaborators, state.snapshot?.reviewSlot])

  React.useEffect(() => {
    const handleAction = (event: Event): void => {
      const detail = (event as CustomEvent<WorktreeReviewActionDetail>).detail
      if (!notice || !detail || detail.reviewId !== notice.reviewId || currentSessionId !== notice.sessionId) return
      if (detail.action === 'commit') {
        const readyForReview = state.snapshot?.delivery?.state === 'ready_for_review'
        const currentCollaborators = state.snapshot?.collaborators ?? []
        const action = directFinishAction({
          waitingForSlot: readyForReview && state.snapshot?.reviewSlot === 'waiting',
          blockedByCollaborator: currentCollaborators.length > 0,
          canReleaseAll: currentCollaborators.length > 0 && currentCollaborators.every((collaborator) => collaborator.canRelease),
        })
        if (action === 'release_collaborators') setReleaseAllOpen(true)
        if (action === 'open_commit') setCommitOpen(true)
      }
      if (detail.action === 'checkpoint') setCheckpointOpen(true)
      if (detail.action === 'discard') setDiscardOpen(true)
      if (detail.action === 'handoff') setHandoffOpen(true)
    }
    window.addEventListener(WORKTREE_REVIEW_ACTION_EVENT, handleAction)
    return () => window.removeEventListener(WORKTREE_REVIEW_ACTION_EVENT, handleAction)
  }, [currentSessionId, notice?.reviewId, notice?.sessionId, state.snapshot?.collaborators, state.snapshot?.delivery?.state, state.snapshot?.reviewSlot])

  const staleIsolatedPreflight = isStaleIsolatedPreflight(state.preflight) ? state.preflight : null
  React.useEffect(() => {
    if (!regenerationRequested) return
    if (agentStreamState?.running) {
      regenerationObservedRunning.current = true
      return
    }
    if (!regenerationObservedRunning.current) return
    regenerationObservedRunning.current = false
    setRegenerationRequested(false)
  }, [agentStreamState?.running, regenerationRequested])

  if (!notice) return null
  const delivery = state.snapshot?.delivery
  const discarded = state.snapshot?.checkout.id === notice.checkoutId
    && state.snapshot.checkout.phase === 'discarded'
    && delivery?.state !== 'delivered'
  const identityMatches = isWorktreeReviewIdentityAuthorized(currentSessionId, notice)
  const activeReview = !discarded && identityMatches && state.snapshot?.checkout.id === notice.checkoutId
    && delivery != null
    && (delivery.state === 'ready_for_review' || delivery.state === 'preview_active' || delivery.state === 'preview_detached' || delivery.state === 'finalized')
    && delivery.review.reviewId === notice.reviewId
  const previewActive = activeReview && delivery?.state === 'preview_active'
  const recoveryPreview = previewActive && state.snapshot?.checkout.phase === 'recovery_required'
  const previewDetached = activeReview && delivery?.state === 'preview_detached'
  const finalized = activeReview && delivery?.state === 'finalized'
  const retained = state.snapshot?.checkout.id === notice.checkoutId && delivery?.state === 'retained'
  const delivered = state.snapshot?.checkout.id === notice.checkoutId && delivery?.state === 'delivered'
  const checkpoints = state.snapshot?.checkout.id === notice.checkoutId ? state.snapshot.checkpoints ?? [] : []
  const savedCheckpoint = checkpoints.find((checkpoint) => checkpoint.reviewId === notice.reviewId)
  const pending = state.pendingAction !== null
  const refreshing = (state.loading || state.preflightLoading === true) && state.pendingAction === null
  const cardBusy = pending || refreshing || submitting || handoffStarting || regenerationRequested
  const busyLabel = state.pendingAction
    ? worktreeOperationBusyLabel(state.pendingAction)
    : handoffStarting
      ? '正在创建接力会话…'
      : submitting
        ? checkpointOpen ? '正在保存进度…' : '正在保存修改…'
        : regenerationRequested
          ? '正在重新检查验收结果…'
          : state.preflightLoading
            ? '正在检查是否可以安全预览…'
            : refreshing
              ? '正在加载验收状态…'
              : null
  const validationWarning = notice.review.validationStatus !== 'passed'
  const waitingForSlot = activeReview && delivery?.state === 'ready_for_review' && state.snapshot?.reviewSlot === 'waiting'
  const reviewSlotOwnerSessionId = waitingForSlot ? state.snapshot?.reviewSlotOwnerSessionId : undefined
  const collaborators = activeReview ? state.snapshot?.collaborators ?? [] : []
  const blockedByCollaborator = collaborators.length > 0
  const bulkRelease = partitionCollaboratorsForBulkRelease(collaborators)
  const releasableCollaborators = bulkRelease.releasable
  const unreleasableCollaborators = bulkRelease.blocked
  const canReleaseAll = bulkRelease.canReleaseAll
  const directFinishBlock = directFinishBlockReason({ waitingForSlot, blockedByCollaborator, canReleaseAll })
  const directFinishNextAction = directFinishAction({ waitingForSlot, blockedByCollaborator, canReleaseAll })
  const directFinishLabel = directFinishActionLabel({
    waitingForSlot,
    blockedByCollaborator,
    canReleaseAll,
    releasableCount: releasableCollaborators.length,
  })
  const preflightConflict = state.preflight?.status === 'conflict' ? state.preflight : null
  const preflightBlocksSync = preflightConflict !== null || state.preflight?.status === 'blocked'
  const cardTitle = discarded
    ? '修改已放弃'
    : delivery?.state === 'ready_for_review'
      ? '修改已完成'
      : delivery?.state === 'preview_active'
        ? '修改正在预览'
        : delivery?.state === 'preview_detached'
          ? '修改仍可保存'
          : retained || delivered
            ? '修改已保存'
            : '验收记录'
  const decisionTitle = !activeReview
    ? '本轮已完成'
    : delivery?.state === 'ready_for_review'
      ? '待你确认'
      : delivery?.state === 'preview_active'
        ? '检查预览效果'
        : delivery?.state === 'preview_detached'
          ? '需要重新确认'
          : finalized
            ? '清理待完成'
            : '本轮已完成'
  const decisionDescription = delivery?.state === 'ready_for_review'
    ? '先在当前项目中检查实际效果。'
    : delivery?.state === 'preview_active'
      ? recoveryPreview ? '先恢复并撤回中断的预览。' : '确认实际效果后保存本次修改。'
      : delivery?.state === 'preview_detached'
        ? '当前项目已有新变化，请选择保存或撤回。'
        : finalized
          ? '修改已经保存，只需重试环境清理。'
          : '可以继续开始下一轮修改。'
  const decisionStep = delivery?.state === 'ready_for_review' ? 1 : 2
  const reviewNeedsAttention = validationWarning
    || staleIsolatedPreflight !== null
    || preflightConflict !== null
    || state.preflight?.status === 'blocked'
  const newReview = activeReview && delivery?.state === 'ready_for_review' && !reviewNeedsAttention
  const reviewTone = reviewNeedsAttention
    ? 'amber'
    : delivery?.state === 'ready_for_review'
      ? 'sky'
      : delivery?.state === 'preview_active' || delivery?.state === 'preview_detached' || finalized
        ? 'amber'
      : retained || delivered
        ? 'emerald'
        : 'muted'
  const reviewDotClass = reviewTone === 'sky'
    ? 'bg-sky-400'
    : reviewTone === 'amber'
      ? 'bg-amber-400'
      : reviewTone === 'emerald'
        ? 'bg-emerald-500'
        : 'bg-muted-foreground/60'
  const currentStepClass = reviewTone === 'sky'
    ? 'border-sky-500/70 text-sky-400'
    : 'border-amber-500/70 text-amber-400'

  const regenerateStaleReview = (): void => {
    if (!staleIsolatedPreflight || !identityMatches || regenerationRequested) return
    setRegenerationRequested(true)
    dispatchWorktreeReviewRegeneration(createWorktreeReviewRegenerationFromPreflight(operationSessionId, staleIsolatedPreflight))
    toast.info('已请求 Agent 重新生成验收结果', {
      description: 'Agent 会保持 Read Only，确认 Worktree 停止变化并重新验证；Local 不会被修改。',
    })
  }

  const resolvePreflightConflict = (): void => {
    if (!preflightConflict || !identityMatches) return
    dispatchWorktreeApplyConflictResume(createWorktreeApplyConflictResumeFromPreflight(operationSessionId, preflightConflict))
    toast.info('已让 Agent 在原 Worktree 中解决冲突', { description: 'Local 未修改；解决并验证后会重新请求同步确认。' })
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

  const submitCommit = async (): Promise<void> => {
    const value = commitMessage.trim()
    if (!value || directFinishNextAction !== 'open_commit' || recoveryPreview || submitting) return
    // 对话框保持打开并显示提交中；operate 超时后原子会自动等待主进程收敛，
    // 期间用户能看到明确的处理中状态，而不是关掉后只能看到卡片按钮转圈。
    setSubmitting(true)
    try {
      const result = await operate({ action: previewActive ? 'finalize_preview' : 'finish', commitMessage: value, retention })
      if ((result?.status === 'error' || result?.status === 'preview_detached') && (previewActive || previewDetached)) {
        toast.warning('直接提交仍无法可靠收口', { description: '可以使用“交接到新会话”保底，由新 Agent 基于最新 Local HEAD 恢复缺失增量。' })
      }
    } finally {
      setSubmitting(false)
      setCommitOpen(false)
    }
  }

  const submitCheckpoint = async (): Promise<void> => {
    const value = checkpointMessage.trim()
    if (!value || !activeReview || savedCheckpoint || previewDetached || recoveryPreview || blockedByCollaborator || submitting) return
    setSubmitting(true)
    try {
      const result = await operate({ action: 'checkpoint', commitMessage: value })
      if (result?.status === 'checkpointed') {
        toast.success(`阶段 ${result.checkpoint.sequence} 已保存`, {
          description: 'Local 未更新；现在可直接同步到 Local 验收，也可以继续修改。',
        })
      }
    } finally {
      setSubmitting(false)
      setCheckpointOpen(false)
    }
  }

  const rollbackPreviewWithFallback = async (): Promise<void> => {
    const result = await operate({ action: 'rollback_preview' })
    if (result?.status === 'error' || result?.status === 'preview_detached') {
      toast.warning('重新撤回仍无法可靠收口', { description: '可以使用“交接到新会话”保底，旧 Preview 恢复证据会继续保留。' })
    }
  }

  const handoffToFreshWorktree = async (): Promise<void> => {
    if (!previewDetached || !state.snapshot || handoffStarting || !window.electronAPI.sessionCheckout.handoffSession) return
    setHandoffStarting(true)
    try {
      const result = await window.electronAPI.sessionCheckout.handoffSession({
        sessionId: operationSessionId,
        expectedRevision: state.snapshot.revision,
        targetKind: 'isolated',
        confirmedIgnoreDirtyLocal: true,
      })
      if (!result.ok) {
        toast.error('创建恢复接力失败', { description: result.error.message })
        return
      }
      setAgentSessions((sessions) => sessions.some((session) => session.id === result.value.session.id)
        ? sessions.map((session) => session.id === result.value.session.id ? result.value.session : session)
        : [result.value.session, ...sessions])
      setHandoffOpen(false)
      openSession('agent', result.value.session.id, result.value.session.title)
      const feedback = getSessionHandoffFeedback(result.value, 'isolated')
      toast.success(feedback.title, { description: feedback.description })
    } finally {
      setHandoffStarting(false)
    }
  }

  const discard = async (): Promise<void> => {
    setDiscardOpen(false)
    await operate({ action: 'discard', confirmDirty: true })
  }

  const releaseCollaborator = async (): Promise<void> => {
    const target = releaseTarget
    if (!target) return
    setReleaseTarget(null)
    await operate({ action: 'release_collaborator', collaboratorSessionId: target.sessionId })
  }

  const releaseAllAndContinue = async (): Promise<void> => {
    if (!canReleaseAll || cardBusy) return
    setReleaseAllOpen(false)
    const result = await operate({ action: 'release_collaborators' })
    if (result?.status === 'collaborators_released') setCommitOpen(true)
  }

  return (
    <div className="my-3 pl-[46px] pr-1" data-worktree-review-id={notice.reviewId}>
      <div className="mb-4 text-sm">
        <MessageResponse>{notice.detailsMarkdown}</MessageResponse>
      </div>
      <div
        data-worktree-review-layout={activeReview ? 'split' : 'history'}
        className={`overflow-hidden rounded-lg border border-border/70 bg-background/20 text-xs transition-opacity ${newReview ? 'border-l-2 border-l-sky-500/80' : reviewNeedsAttention && activeReview ? 'border-l-2 border-l-amber-500/80' : ''} ${cardBusy ? 'pointer-events-none opacity-60' : ''}`}
        aria-busy={cardBusy}
        {...(cardBusy ? { inert: '' } : {})}
      >
        {!activeReview ? (
          <div data-worktree-review-section="history" className="flex flex-wrap items-center gap-3 px-4 py-3">
            <ShieldCheck className={`size-4 shrink-0 ${discarded ? 'text-muted-foreground' : 'text-emerald-500'}`} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-xs font-medium text-foreground">第 {notice.review.iteration} 轮{cardTitle}</span>
                <span className="text-[10px] text-muted-foreground">{notice.review.changedFiles.length} 个文件</span>
              </div>
              {detailsExpanded ? <p className="mt-1 truncate text-[11px] text-muted-foreground" title={notice.review.summary}>{notice.review.summary}</p> : null}
            </div>
            <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-[10px] text-muted-foreground" aria-expanded={detailsExpanded} onClick={() => setDetailsExpanded((expanded) => !expanded)}>
              {detailsExpanded ? '收起详情' : '查看详情'}
            </Button>
          </div>
        ) : (
        <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(248px,32%)]">
          <section data-worktree-review-section="summary" className="min-w-0 p-4 md:px-5 md:py-4">
            <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              <span>Review {String(notice.review.iteration).padStart(2, '0')}</span>
              <span className={`size-1.5 rounded-full ${reviewDotClass}`} />
              {newReview ? <span className="tracking-[0.08em] text-sky-400">新验收</span> : null}
            </div>
            <h3 className="mt-3 text-[22px] font-semibold tracking-[-0.02em] text-foreground">{cardTitle}</h3>
            <p className="mt-1.5 max-w-3xl truncate text-sm leading-5 text-muted-foreground" title={notice.review.summary}>{notice.review.summary}</p>

            <div className="mt-4 grid gap-3 text-[11px] text-muted-foreground sm:grid-cols-3 sm:divide-x sm:divide-border/60">
              <div className="flex items-center gap-2 sm:pr-3">
                <TestTube2 className={`size-4 shrink-0 ${validationWarning ? 'text-amber-500' : 'text-emerald-500'}`} />
                <span>{validationLabel(notice.review.validationStatus)}</span>
              </div>
              <div className="flex items-center gap-2 sm:px-3">
                <FileText className="size-4 shrink-0" />
                <span>{notice.review.changedFiles.length} 个文件已更新</span>
              </div>
              <div className="flex items-center gap-2 sm:pl-3">
                <RotateCcw className="size-4 shrink-0" />
                <span>{previewDetached ? '当前项目已有新变化' : '预览可随时撤回'}</span>
              </div>
            </div>

            <div className="mt-4 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[11px] text-blue-300/75 transition-colors hover:text-blue-200"
                aria-expanded={detailsExpanded}
                onClick={() => setDetailsExpanded((expanded) => !expanded)}
              >
                {detailsExpanded ? '收起变更与技术详情' : '查看变更与技术详情'}
                {detailsExpanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              </button>
              {savedCheckpoint ? (
                <span className="border-l border-border/60 pl-3 text-[10px] text-muted-foreground">含 <span className="text-foreground/80">1</span> 个已保存进度</span>
              ) : checkpoints.length > 0 ? (
                <span className="border-l border-border/60 pl-3 text-[10px] text-muted-foreground">含 <span className="text-foreground/80">{checkpoints.length}</span> 个已保存进度</span>
              ) : null}
            </div>

            {detailsExpanded ? (
              <div className="mt-3 space-y-2 border-t border-border/50 pt-3 text-[11px] text-muted-foreground">
                {notice.review.validationSummary ? <p>{notice.review.validationSummary}</p> : null}
                {notice.review.tests.map((test, index) => (
                  <div key={`${test.command}-${index}`} className="grid grid-cols-[34px_minmax(0,1fr)] gap-2">
                    <span className={test.status === 'passed' ? 'text-emerald-500' : test.status === 'failed' ? 'text-amber-500' : ''}>
                      {test.status === 'passed' ? '通过' : test.status === 'failed' ? '失败' : '未运行'}
                    </span>
                    <code className="truncate">{test.command}</code>
                  </div>
                ))}
                {activeReview && delivery?.state === 'ready_for_review' && !staleIsolatedPreflight ? (
                  <PreflightDetails
                    preflight={state.preflight}
                    loading={state.preflightLoading === true}
                    error={state.preflightError}
                    onRetry={() => void preflight({ invalidateCached: true })}
                  />
                ) : null}
              </div>
            ) : null}

            {staleIsolatedPreflight ? (
              <div className="mt-4 space-y-1.5 rounded-md border border-amber-500/25 bg-amber-500/5 p-2.5 text-[11px] text-amber-700 dark:text-amber-300">
                <div className="font-medium">验收结果已过期，需要重新生成</div>
                <p>后台任务、子 Agent 或其他进程仍在写入 Worktree。Domi 会先确认写入停止，再重新检查修改和测试结果。</p>
              </div>
            ) : null}
            {!detailsExpanded && activeReview && delivery?.state === 'ready_for_review' && (preflightConflict || state.preflight?.status === 'blocked' || state.preflightError) ? (
              <div className="mt-4">
                <PreflightDetails
                  preflight={state.preflight}
                  loading={state.preflightLoading === true}
                  error={state.preflightError}
                  onRetry={() => void preflight({ invalidateCached: true })}
                />
              </div>
            ) : null}
            {slotReleased && activeReview && delivery?.state === 'ready_for_review' ? <p className="mt-3 text-[11px] text-emerald-600 dark:text-emerald-400">其他任务的预览已结束，现在可以继续。</p> : null}
            {recoveryPreview ? (
              <div className="mt-4 rounded-md border border-amber-500/25 bg-amber-500/5 p-2.5 text-[11px] text-amber-700 dark:text-amber-300">
                Preview 操作曾被中断，Domi 已保留完整撤回证据。请先恢复并撤回 Preview，再重新同步验收。
              </div>
            ) : null}
            {previewDetached ? (
              <div className="mt-4 rounded-md border border-amber-500/25 bg-amber-500/5 p-2.5 text-[11px] text-amber-700 dark:text-amber-300">
                当前项目在本次预览后发生了变化。Domi 会基于最新 Local 重新计算，不会覆盖无关修改。
              </div>
            ) : null}
            {blockedByCollaborator ? (
              <div className="mt-4 space-y-2 rounded-md border border-amber-500/25 bg-amber-500/5 p-2.5">
                <p className="text-[11px] font-medium text-foreground">保存或清理前，需要结束以下协作会话的占用：</p>
                {collaborators.map((collaborator) => (
                  <div key={collaborator.sessionId} className="flex flex-wrap items-center gap-2 rounded bg-background/60 px-2 py-1.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px] font-medium text-foreground">{collaborator.title}</div>
                      <div className="text-[10px] text-muted-foreground">{collaboratorStatusLabel(collaborator.status)}</div>
                    </div>
                    <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => openSession('agent', collaborator.sessionId, collaborator.title)}><ExternalLink className="size-3" />查看</Button>
                    {collaborator.canRelease ? (
                      <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[11px]" disabled={cardBusy} onClick={() => setReleaseTarget(collaborator)}><Unplug className="size-3" />结束占用</Button>
                    ) : <span className="text-[10px] text-amber-600 dark:text-amber-400">{collaborator.status === 'running' ? '请先停止会话' : '无法自动结束'}</span>}
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <aside data-worktree-review-section="decision" className={`flex flex-col border-t border-border/60 bg-background/20 p-4 md:border-l md:border-t-0 md:px-5 md:py-4 ${activeReview ? 'min-h-[224px]' : 'min-h-0'}`}>
            <div className="flex min-w-0 items-center gap-2 text-xs font-medium text-foreground">
              {busyLabel ? <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" /> : <span className={`size-2 rounded-full ${reviewDotClass}`} />}
              <span className="truncate">{busyLabel ?? decisionTitle}</span>
            </div>

            {activeReview && !finalized ? (
              <div className="mt-4 flex items-center gap-2.5 text-[11px]">
                <span className={`inline-flex size-6 items-center justify-center rounded border ${decisionStep === 1 ? currentStepClass : 'border-border text-muted-foreground'}`}>1</span>
                <span className={decisionStep === 1 ? 'text-foreground' : 'text-muted-foreground'}>预览修改</span>
                <span className="h-px min-w-5 flex-1 bg-border" />
                <span className={`inline-flex size-6 items-center justify-center rounded border ${decisionStep === 2 ? currentStepClass : 'border-border text-muted-foreground'}`}>2</span>
                <span className={decisionStep === 2 ? 'text-foreground' : 'text-muted-foreground'}>确认保存</span>
              </div>
            ) : null}

            {activeReview ? <p className="mt-4 text-[12px] leading-5 text-muted-foreground">{decisionDescription}</p> : null}

            <div className="mt-4">
              {activeReview && delivery?.state === 'ready_for_review' ? (
                staleIsolatedPreflight ? (
                  <Button type="button" className="w-full" disabled={cardBusy} onClick={regenerateStaleReview}><RefreshCw />重新生成验收结果</Button>
                ) : preflightConflict ? (
                  <Button type="button" className="w-full" disabled={cardBusy || state.preflightLoading === true} onClick={resolvePreflightConflict}><AlertTriangle />让 Agent 解决冲突</Button>
                ) : (
                  <Button type="button" className="w-full" disabled={cardBusy || (!waitingForSlot && (state.preflightLoading === true || preflightBlocksSync))} title={waitingForSlot ? '点击查看正在预览此项目修改的任务' : undefined} onClick={() => waitingForSlot ? openReviewSlotOwner() : void operate({ action: 'preview' })}>
                    {waitingForSlot ? '查看正在预览的任务' : preflightBlocksSync ? '请先处理阻塞' : '预览修改'}
                  </Button>
                )
              ) : null}
              {previewActive ? (
                recoveryPreview ? (
                  <Button type="button" className="w-full" disabled={cardBusy} onClick={() => void operate({ action: 'rollback_preview' })}><RotateCcw />恢复并撤回预览</Button>
                ) : (
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                    <Button type="button" className="min-w-0" disabled={cardBusy || (blockedByCollaborator && !canReleaseAll)} onClick={() => blockedByCollaborator ? setReleaseAllOpen(true) : setCommitOpen(true)}><GitCommitHorizontal />{blockedByCollaborator ? '释放并保存' : '确认保存'}</Button>
                    <Button type="button" variant="outline" className="shrink-0" disabled={cardBusy} onClick={() => { void rollbackPreviewWithFallback() }}><RotateCcw />撤回预览</Button>
                  </div>
                )
              ) : null}
              {previewDetached ? <Button type="button" className="w-full" disabled={cardBusy || directFinishBlock !== null} onClick={() => directFinishNextAction === 'release_collaborators' ? setReleaseAllOpen(true) : setCommitOpen(true)}><GitCommitHorizontal />保存修改</Button> : null}
              {finalized ? <Button type="button" className="w-full" disabled={cardBusy} onClick={() => void operate({ action: 'retry_cleanup' })}><RotateCcw />重试清理</Button> : null}
            </div>

            <div className="mt-auto flex min-h-8 items-center gap-2 border-t border-border/60 pt-3">
              <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[10px] text-muted-foreground">
                {activeReview && !finalized ? <><ShieldCheck className="size-3.5 shrink-0 text-emerald-500/80" /><span className="truncate">{previewActive ? '仅保存本轮内容' : '可撤回，不会立即保存'}</span></> : !activeReview ? <span>{discarded ? '本轮已放弃' : retained ? '环境已保留' : delivered ? '已保存到当前项目' : '历史记录'}</span> : null}
              </div>
              {activeReview && (delivery?.state === 'ready_for_review' || previewActive) && !savedCheckpoint && !staleIsolatedPreflight && !preflightConflict ? (
                <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-1.5 text-[10px] text-muted-foreground hover:bg-transparent hover:text-foreground" disabled={cardBusy || blockedByCollaborator} onClick={() => setCheckpointOpen(true)}>保存进度</Button>
              ) : null}
              {activeReview && !finalized ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-sm" disabled={cardBusy} aria-label="更多交付操作"><MoreHorizontal /></Button></DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="z-[9999] min-w-52">
                    {!previewActive ? <DropdownMenuItem disabled={directFinishBlock !== null} title={directFinishBlock ?? undefined} onSelect={() => openDialogAfterDropdownMenu(() => directFinishNextAction === 'release_collaborators' ? setReleaseAllOpen(true) : setCommitOpen(true))}><GitCommitHorizontal />{directFinishLabel}</DropdownMenuItem> : null}
                    {previewDetached ? <DropdownMenuItem onSelect={() => { void rollbackPreviewWithFallback() }}><RotateCcw />重新尝试撤回</DropdownMenuItem> : null}
                    {previewDetached ? <DropdownMenuItem onSelect={() => openDialogAfterDropdownMenu(() => setHandoffOpen(true))}><GitBranchPlus />交接到新会话</DropdownMenuItem> : null}
                    <DropdownMenuItem className="text-destructive" onSelect={() => openDialogAfterDropdownMenu(() => setDiscardOpen(true))}><Trash2 />放弃任务</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>

            {state.error ? <p className="mt-3 text-[11px] text-destructive">{state.error.message}</p> : null}
          </aside>
        </div>
        )}
      </div>

      <AlertDialog open={handoffOpen} onOpenChange={setHandoffOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>交接到新会话？</AlertDialogTitle>
            <AlertDialogDescription>
              Domi 会保留旧 Preview 恢复证据，基于最新 Local HEAD 创建干净 Worktree，并让新 Agent 自动读取 durable handoff、只恢复仍缺失的任务增量。不会 reset/rebase Local，也不会在新交付成功前删除旧 Worktree。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="rounded-md border border-amber-500/25 bg-amber-500/5 p-2.5 text-xs leading-5 text-amber-700 dark:text-amber-300">
            Local 中现有 staged、unstaged 和 untracked 修改不会复制到新 Worktree；它们只会作为最终重新验收时需要保留的状态。
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={handoffStarting}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={handoffStarting} onClick={() => void handoffToFreshWorktree()}>
              {handoffStarting ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <GitBranchPlus className="mr-1.5 size-3.5" />}
              {handoffStarting ? '正在创建接力…' : '确认交接并自动继续'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={checkpointOpen} onOpenChange={setCheckpointOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>保存当前进度并继续？</AlertDialogTitle>
            <AlertDialogDescription>
              Domi 会保存当前任务进度，方便你继续下一阶段；当前项目不会立即更新。最终确认时，所有进度仍会合并为一次保存。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Textarea
              value={checkpointMessage}
              onChange={(event) => setCheckpointMessage(event.target.value)}
              placeholder={'阶段标题\n\n- 当前阶段完成内容'}
              rows={5}
              maxLength={500}
              autoFocus
              className="scrollbar-thin min-h-[112px] max-h-[220px] resize-none overflow-y-auto font-mono text-sm [field-sizing:content]"
            />
            <p className="text-[11px] text-muted-foreground">阶段 Commit 只用于当前 Worktree 的依赖承接，不会原样进入 Local 历史。</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={!checkpointMessage.trim() || !!savedCheckpoint || blockedByCollaborator || submitting} onClick={() => void submitCheckpoint()}>
              {submitting ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {submitting ? '正在保存…' : '保存进度并继续'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={commitOpen} onOpenChange={setCommitOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{previewActive ? '确认并保存本次修改？' : previewDetached ? '保存本次修改？' : '跳过预览并直接保存？'}</AlertDialogTitle>
            <AlertDialogDescription>
              Domi 只会保存本轮任务内容，不会包含当前项目中已有或之后新增的其他修改。默认保存后清理临时运行环境，你仍可回到当前会话继续下一轮。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            {directFinishBlock ? (
              <p className="rounded-md border border-amber-500/25 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-300">
                {directFinishBlock}
              </p>
            ) : null}
            <Textarea
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              placeholder={'提交标题\n\n- 具体变更一\n- 具体变更二'}
              rows={6}
              maxLength={500}
              autoFocus
              className="scrollbar-thin min-h-[132px] max-h-[240px] resize-none overflow-y-auto font-mono text-sm [field-sizing:content]"
            />
            <p className="text-right text-[11px] text-muted-foreground">首行作为标题，空行后可列详细说明 · {commitMessage.length}/500</p>
            <label className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-2 text-xs">
              <input
                type="checkbox"
                checked={retention !== 'cleanup'}
                onChange={(event) => setRetention(event.target.checked ? 'retain_24h' : 'cleanup')}
                className="size-3.5 accent-primary"
              />
              <span>提交后暂时保留当前运行环境</span>
            </label>
            {retention !== 'cleanup' ? (
              <div className="space-y-1.5 rounded-md bg-muted/40 p-2.5">
                <select
                  value={retention}
                  onChange={(event) => setRetention(event.target.value as WorktreeRetentionMode)}
                  className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                >
                  <option value="retain_24h">保留 24 小时</option>
                  <option value="retain_3d">保留 3 天</option>
                  <option value="retain_manual">手动清理</option>
                </select>
                <p className="text-[11px] text-muted-foreground">仅用于保留依赖、构建产物、日志或调试现场；后续代码修改仍会创建新的 Worktree。</p>
              </div>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={!commitMessage.trim() || directFinishNextAction !== 'open_commit' || submitting} onClick={() => void submitCommit()}>
              {submitting ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {submitting ? '正在交付…' : retention === 'cleanup' ? '确认交付并清理' : '确认交付并保留环境'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={releaseAllOpen} onOpenChange={setReleaseAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>一次释放全部协作占用并继续提交？</AlertDialogTitle>
            <AlertDialogDescription>
              Domi 会保留这些会话的历史对话，并将它们与当前 Worktree 解绑；重新选择 Session Target 前不能继续运行。释放完成后会自动打开提交确认。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 text-sm">
            {releasableCollaborators.length > 0 ? (
              <div>
                <p className="mb-1 text-xs font-medium text-foreground">将释放：</p>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {releasableCollaborators.map((collaborator) => <li key={collaborator.sessionId}>• {collaborator.title}（{collaboratorStatusLabel(collaborator.status)}）</li>)}
                </ul>
              </div>
            ) : null}
            {unreleasableCollaborators.length > 0 ? (
              <div className="rounded-md border border-amber-500/25 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-300">
                <p className="font-medium">以下会话仍在运行或状态不安全，不会被释放：</p>
                <ul className="mt-1 space-y-1">{unreleasableCollaborators.map((collaborator) => <li key={collaborator.sessionId}>• {collaborator.title}（{collaboratorStatusLabel(collaborator.status)}）</li>)}</ul>
              </div>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction disabled={!canReleaseAll || pending} onClick={() => void releaseAllAndContinue()}>
              {pending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {canReleaseAll ? `确认释放 ${releasableCollaborators.length} 个并继续` : '请先停止仍在运行的会话'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={releaseTarget !== null} onOpenChange={(open) => { if (!open) setReleaseTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>释放当前 Worktree 占用？</AlertDialogTitle>
            <AlertDialogDescription>
              会保留“{releaseTarget?.title ?? '会话'}”的历史对话，并将它与当前 Worktree 解绑；重新选择 Session Target 前不能继续运行。释放后即可继续提交和清理。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction disabled={!releaseTarget?.canRelease || pending} onClick={() => void releaseCollaborator()}>
              结束并释放占用
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>放弃本轮任务？</AlertDialogTitle>
            <AlertDialogDescription>
              {previewActive
                ? '放弃任务不会撤回 Local Preview。若 Preview 已被提交，Domi 只清理 Worktree；若仍未提交或状态无法证明，操作会停止并保留恢复证据。会话仍可继续。'
                : checkpoints.length > 0
                  ? `Worktree 中 ${checkpoints.length} 个尚未交付阶段及当前修改将被永久丢弃，Local 不受影响。会话仍可继续；后续新任务将创建新的 Worktree。`
                  : 'Worktree 中尚未交付的修改将被永久丢弃，Local 不受影响。会话仍可继续；后续新任务将创建新的 Worktree。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={cardBusy} onClick={() => void discard()}>
              {pending ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
              {pending ? '正在放弃…' : '确认放弃任务'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

import * as React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import type { ListManagedWorktreesInput, ManagedWorktreeSummaryView, WorktreeRetentionMode } from '@domi/shared'
import {
  AlertTriangle,
  Check,
  ExternalLink,
  FolderOpen,
  HardDrive,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  ShieldAlert,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button.tsx'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet.tsx'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { worktreeManagerAtom } from '@/atoms/worktree-manager-atoms.ts'
import { allPendingPermissionRequestsAtom } from '@/atoms/agent-atoms.ts'
import { useOpenSession } from '@/hooks/useOpenSession.ts'
import { dispatchLocalMaintenanceResume } from '@/lib/local-maintenance-resume.ts'
import {
  createWorktreeApplyConflictResumeFromContinuation,
  dispatchWorktreeApplyConflictResume,
} from '@/lib/worktree-apply-conflict-resume.ts'
import { cn } from '@/lib/utils.ts'
import { openDialogAfterDropdownMenu } from '@/lib/open-dialog-after-dropdown-menu.ts'

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '占用未知'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function stateLabel(item: ManagedWorktreeSummaryView): string {
  if (item.state === 'working') return '正在修改'
  if (item.state === 'ready_for_review') return '等待验收'
  if (item.state === 'preview_active') return 'Local 验收中'
  if (item.state === 'retained') return '暂时保留'
  if (item.state === 'cleanup_pending') return '等待清理'
  if (item.state === 'delivered') return '已交付'
  return '需要处理'
}

function retentionLabel(item: ManagedWorktreeSummaryView): string | null {
  if (item.retention === 'retain_manual') return '手动清理'
  if (!item.expiresAt) return null
  return `保留至 ${new Date(item.expiresAt).toLocaleString()}`
}

export function partitionManagedWorktreesForBulkCleanup(items: ManagedWorktreeSummaryView[]): {
  safe: ManagedWorktreeSummaryView[]
  retained: ManagedWorktreeSummaryView[]
} {
  return {
    safe: items.filter((item) => item.cleanup?.eligibility === 'safe'),
    retained: items.filter((item) => item.cleanup?.eligibility !== 'safe'),
  }
}

function cleanupReasonLabel(item: ManagedWorktreeSummaryView): string | null {
  if (item.cleanupReason === 'directory_busy') return '目录被占用'
  if (item.cleanupReason === 'modified_after_finalize') return '提交后有新增修改'
  if (item.cleanupReason === 'collaborator_active') return '协作会话仍占用'
  if (item.cleanupReason === 'identity_changed') return '目录身份已变化'
  if (item.cleanupReason === 'detached_residue') return 'Git 已解绑的目录残余'
  if (item.cleanupReason === 'quarantine_busy') return 'Quarantine 被占用'
  return null
}

function canRetryCleanup(item: ManagedWorktreeSummaryView): boolean {
  return item.state === 'cleanup_pending'
    || (item.state === 'needs_attention' && (item.phase === 'retained' || item.phase === 'finalized'))
}

const GROUPS: Array<{ key: ManagedWorktreeSummaryView['state'][]; label: string }> = [
  { key: ['needs_attention', 'cleanup_pending'], label: '需要处理' },
  { key: ['working'], label: '正在工作' },
  { key: ['ready_for_review', 'preview_active'], label: '等待交付' },
  { key: ['retained'], label: '暂时保留' },
  { key: ['delivered'], label: '已交付' },
]

const RETENTION_OPTIONS: Array<{
  value: Exclude<WorktreeRetentionMode, 'cleanup'>
  label: string
}> = [
  { value: 'retain_24h', label: '保留 24 小时' },
  { value: 'retain_3d', label: '保留 3 天' },
  { value: 'retain_manual', label: '保留到手动清理' },
]

export function WorktreeManagerSheet(): React.ReactElement {
  const [manager, setManager] = useAtom(worktreeManagerAtom)
  const allPendingPermissions = useAtomValue(allPendingPermissionRequestsAtom)
  const openSession = useOpenSession()
  const [items, setItems] = React.useState<ManagedWorktreeSummaryView[]>([])
  const [loading, setLoading] = React.useState(false)
  const [diagnosticsLoading, setDiagnosticsLoading] = React.useState(false)
  const [diagnosedCheckoutIds, setDiagnosedCheckoutIds] = React.useState<Set<string>>(new Set())
  const [pendingCheckoutId, setPendingCheckoutId] = React.useState<string | null>(null)
  const [respondingRequestId, setRespondingRequestId] = React.useState<string | null>(null)
  const [cleanupTarget, setCleanupTarget] = React.useState<ManagedWorktreeSummaryView | null>(null)
  const [bulkCleanupOpen, setBulkCleanupOpen] = React.useState(false)
  const [bulkCleaning, setBulkCleaning] = React.useState(false)
  const loadGenerationRef = React.useRef(0)

  const load = React.useCallback(async (): Promise<void> => {
    if (!manager.open) return
    const listManaged = window.electronAPI.sessionCheckout.listManaged
    if (!listManaged) return

    const generation = ++loadGenerationRef.current
    const baseInput: ListManagedWorktreesInput = {
      ...(manager.scope === 'project' && manager.projectId ? { projectId: manager.projectId } : {}),
      ...(manager.scope === 'attention' ? { needsAttention: true } : {}),
    }
    setLoading(true)
    setDiagnosticsLoading(false)
    setDiagnosedCheckoutIds(new Set())

    try {
      // 首屏只读 registry 与同步文件存在性，不扫描大型目录，也不占用 mutation lock。
      const result = await listManaged(baseInput)
      if (generation !== loadGenerationRef.current) return
      if (!result.ok) {
        setItems([])
        toast.error('无法读取 Worktrees', { description: result.error.message })
        return
      }

      setItems(result.value)
      setLoading(false)
      if (result.value.length === 0) return

      // 磁盘大小与 Git/fingerprint 安全检查按单项、最多双并发渐进回填。
      // 即使大型 node_modules 扫描较慢，返回会话、打开目录和其他条目也始终可操作。
      setDiagnosticsLoading(true)
      const queue = [...result.value]
      let cursor = 0
      const worker = async (): Promise<void> => {
        while (cursor < queue.length) {
          const item = queue[cursor++]
          if (!item || generation !== loadGenerationRef.current) return
          const detail = await listManaged({ checkoutId: item.checkoutId, includeDiagnostics: true })
          if (generation !== loadGenerationRef.current) return
          setDiagnosedCheckoutIds((current) => {
            const next = new Set(current)
            next.add(item.checkoutId)
            return next
          })
          if (!detail.ok || !detail.value[0]) continue
          const diagnosed = detail.value[0]
          setItems((current) => current.map((candidate) => (
            candidate.checkoutId === diagnosed.checkoutId && candidate.revision <= diagnosed.revision
              ? diagnosed
              : candidate
          )))
        }
      }
      void Promise.all([worker(), worker()]).finally(() => {
        if (generation === loadGenerationRef.current) setDiagnosticsLoading(false)
      })
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false)
    }
  }, [manager.open, manager.projectId, manager.scope])

  React.useEffect(() => { void load() }, [load])

  const manage = async (
    item: ManagedWorktreeSummaryView,
    action: 'cleanup_retained' | 'retry_cleanup' | 'set_retention' | 'discard',
    retention?: Exclude<WorktreeRetentionMode, 'cleanup'>,
  ): Promise<void> => {
    const manageWorktree = window.electronAPI.sessionCheckout.manage
    if (!manageWorktree || pendingCheckoutId) return
    setPendingCheckoutId(item.checkoutId)
    try {
      const result = await manageWorktree(action === 'set_retention'
        ? { checkoutId: item.checkoutId, expectedRevision: item.revision, action, retention: retention! }
        : action === 'discard'
          ? {
              checkoutId: item.checkoutId,
              expectedRevision: item.revision,
              action,
              confirmDirty: true,
            }
          : { checkoutId: item.checkoutId, expectedRevision: item.revision, action })
      if (!result.ok) toast.error('Worktree 操作失败', { description: result.error.message })
      await load()
    } finally {
      setPendingCheckoutId(null)
    }
  }

  const bulkCleanup = async (): Promise<void> => {
    const execute = window.electronAPI.sessionCheckout.bulkCleanupManaged
    const candidates = items.filter((item) => item.cleanup?.eligibility === 'safe')
    if (!execute || candidates.length === 0 || bulkCleaning) return
    setBulkCleaning(true)
    setBulkCleanupOpen(false)
    try {
      const result = await execute({ candidates: candidates.map((item) => ({ checkoutId: item.checkoutId, expectedRevision: item.revision })) })
      if (!result.ok) toast.error('批量清理失败', { description: result.error.message })
      else if (result.value.retained.length > 0) {
        toast.warning(`已清理 ${result.value.cleaned.length} 个，保留 ${result.value.retained.length} 个`, { description: '保留项在执行前重新校验时仍不满足安全条件。' })
      } else toast.success(`已安全清理 ${result.value.cleaned.length} 个 Worktree`)
      await load()
    } finally {
      setBulkCleaning(false)
    }
  }

  const reveal = async (item: ManagedWorktreeSummaryView): Promise<void> => {    const revealManaged = window.electronAPI.sessionCheckout.revealManaged
    if (!revealManaged) return
    const result = await revealManaged({ checkoutId: item.checkoutId })
    if (!result.ok) toast.error('无法打开 Worktree', { description: result.error.message })
  }

  const managedCheckoutIds = new Set(items.map((item) => item.checkoutId))
  const managedOwnerSessionIds = new Set(items.map((item) => item.ownerSessionId))
  const deferredRequests = [...allPendingPermissions.values()]
    .flat()
    .filter((request) => request.deferred && managedCheckoutIds.has(request.deferred.checkoutId)
      && (request.deferred.kind === 'worktree' || managedOwnerSessionIds.has(request.sessionId)))

  const respondDeferred = async (requestId: string, behavior: 'allow' | 'deny'): Promise<void> => {
    if (respondingRequestId) return
    setRespondingRequestId(requestId)
    try {
      const result = await window.electronAPI.respondPermission({ requestId, behavior, alwaysAllow: false })
      if (!result.ok) toast.error('确认已失效或执行失败', { description: result.message })
      else if (behavior === 'allow') {
        if (result.continuation?.kind === 'local_maintenance' && result.sessionId) {
          const targetSessionId = result.sessionId
          const continuation = result.continuation
          dispatchLocalMaintenanceResume({
            sessionId: targetSessionId,
            requestId: continuation.requestId,
            transactionId: continuation.transactionId,
            goal: continuation.goal,
          })
          const owner = items.find((item) => item.ownerSessionId === targetSessionId)
          openSession('agent', targetSessionId, owner?.ownerSessionTitle ?? 'Agent 会话')
          setManager((current) => ({ ...current, open: false }))
        }
        if (result.continuation?.kind === 'worktree_apply_conflict' && result.sessionId) {
          const targetSessionId = result.sessionId
          dispatchWorktreeApplyConflictResume(createWorktreeApplyConflictResumeFromContinuation(targetSessionId, result.continuation))
          const owner = items.find((item) => item.ownerSessionId === targetSessionId)
          openSession('agent', targetSessionId, owner?.ownerSessionTitle ?? 'Agent 会话')
          setManager((current) => ({ ...current, open: false }))
        }
        if (result.continuation?.kind === 'worktree_apply_conflict') {
          toast.warning('检测到冲突，Local 未修改；Agent 正在自动处理')
        } else {
          toast.success(result.continuation?.kind === 'local_maintenance' ? '维修事务已开启，正在自动继续' : '已执行确认动作')
        }
      }
      await load()
    } finally {
      setRespondingRequestId(null)
    }
  }

  const knownSizeItems = items.filter((item) => item.approximateBytes !== null)
  const totalBytes = knownSizeItems.reduce((total, item) => total + (item.approximateBytes ?? 0), 0)
  const sizeSummary = diagnosticsLoading
    ? `正在后台检查 ${diagnosedCheckoutIds.size}/${items.length}`
    : knownSizeItems.length > 0
      ? `约 ${formatBytes(totalBytes)}`
      : '占用未知'
  const bulkCleanupItems = partitionManagedWorktreesForBulkCleanup(items)
  const safeCleanupItems = bulkCleanupItems.safe
  const retainedCleanupItems = bulkCleanupItems.retained
  const targetIsDiscard = cleanupTarget !== null
    && (cleanupTarget.phase === 'ready' || cleanupTarget.phase === 'recovery_required')
    && cleanupTarget.state !== 'retained'
    && cleanupTarget.state !== 'cleanup_pending'

  return (
    <Sheet open={manager.open} onOpenChange={(open) => setManager((current) => ({ ...current, open }))}>
      <SheetContent hideClose side="right" className="flex w-[620px] flex-col gap-0 p-0 sm:max-w-[620px]" aria-describedby={undefined}>
        <SheetTitle className="sr-only">Worktrees 管理</SheetTitle>
        <div className="flex items-start justify-between border-b border-border/60 px-5 pb-4 pt-5">
          <div>
            <h2 className="text-base font-semibold">Worktrees</h2>
            <p className="mt-1 text-xs text-muted-foreground">{items.length} 个物理环境 · {sizeSummary}</p>
          </div>
          <div className="flex items-center gap-1">
            <Button type="button" variant="outline" size="sm" disabled={bulkCleaning || diagnosticsLoading || safeCleanupItems.length === 0} onClick={() => setBulkCleanupOpen(true)}>
              {bulkCleaning ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              {bulkCleaning ? '清理中…' : `清理安全项${safeCleanupItems.length > 0 ? `（${safeCleanupItems.length}）` : ''}`}
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" disabled={loading} onClick={() => void load()} aria-label="刷新 Worktrees">
              <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => setManager((current) => ({ ...current, open: false }))} aria-label="关闭 Worktrees 管理">
              <X className="size-4" />
            </Button>
          </div>
        </div>

        <div className="flex gap-1 border-b border-border/60 px-5 py-3">
          {([
            ['project', '当前项目'],
            ['all', '所有项目'],
            ['attention', '需要处理'],
          ] as const).map(([scope, label]) => (
            <Button
              key={scope}
              type="button"
              size="sm"
              variant={manager.scope === scope ? 'secondary' : 'ghost'}
              disabled={scope === 'project' && !manager.projectId}
              onClick={() => setManager((current) => ({ ...current, scope }))}
            >{label}</Button>
          ))}
        </div>

        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-5">
          {deferredRequests.length > 0 ? (
            <section className="mb-6 space-y-2">
              <h3 className="text-xs font-semibold text-muted-foreground">等待确认 · {deferredRequests.length}</h3>
              {deferredRequests.map((request) => {
                const item = items.find((candidate) => candidate.checkoutId === request.deferred?.checkoutId)
                const responding = respondingRequestId === request.requestId
                const localMaintenance = request.deferred?.kind === 'local_maintenance'
                return (
                  <div key={request.requestId} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                    <div className="flex items-start gap-3">
                      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{localMaintenance ? '开启 Local 维修事务' : request.toolName === 'FinishWorktree' ? '提交并收口 Worktree' : '应用 Worktree 到 Local'}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {item?.ownerSessionTitle ?? 'Agent 会话'} · Iteration {item?.iteration ?? 0}。授权绑定 {localMaintenance ? 'Local HEAD、branch、dirty 指纹以及 ' : ''}revision、HEAD 与 Checkout 身份；任一变化都会使旧卡失效。
                        </p>
                        {localMaintenance && typeof request.toolInput.goal === 'string' ? <p className="mt-2 rounded bg-background/60 p-2 text-[11px]">维修目标：{request.toolInput.goal}</p> : null}
                        {request.toolName === 'FinishWorktree' && typeof request.toolInput.commitMessage === 'string' ? (
                          <pre className="mt-2 max-h-24 overflow-y-auto scrollbar-thin whitespace-pre-wrap rounded bg-background/60 p-2 text-[11px]">{request.toolInput.commitMessage}</pre>
                        ) : null}
                        <div className="mt-3 flex justify-end gap-2">
                          <Button type="button" size="sm" variant="ghost" disabled={responding} onClick={() => void respondDeferred(request.requestId, 'deny')}>拒绝</Button>
                          <Button type="button" size="sm" disabled={responding} onClick={() => void respondDeferred(request.requestId, 'allow')}>
                            {responding ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Check className="mr-1 size-3.5" />}
                            {localMaintenance ? '确认开启' : request.toolName === 'FinishWorktree' ? '确认提交' : '确认应用'}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </section>
          ) : null}
          {loading && items.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在读取 Worktrees…</div>
          ) : items.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">当前没有需要管理的物理 Worktree。</div>
          ) : (
            <div className="space-y-6">
              {GROUPS.map((group) => {
                const grouped = items.filter((item) => group.key.includes(item.state))
                if (grouped.length === 0) return null
                return (
                  <section key={group.label} className="space-y-2">
                    <h3 className="text-xs font-semibold text-muted-foreground">{group.label} · {grouped.length}</h3>
                    {grouped.map((item) => {
                      const pending = pendingCheckoutId === item.checkoutId
                      const diagnosed = diagnosedCheckoutIds.has(item.checkoutId)
                      const attention = item.state === 'needs_attention' || item.state === 'cleanup_pending'
                      const retryCleanup = canRetryCleanup(item)
                      const discardStateAllowed = (item.phase === 'ready' || item.phase === 'recovery_required')
                        && (item.state === 'working' || item.state === 'ready_for_review' || item.state === 'preview_active' || item.state === 'needs_attention')
                      const cleanupStateAllowed = item.state === 'retained' || retryCleanup
                      const destructiveAction = discardStateAllowed ? 'discard' : retryCleanup ? 'retry_cleanup' : 'cleanup_retained'
                      const cleanupDisabledReason = discardStateAllowed
                        ? !diagnosed
                          ? '正在检查 Worktree 身份、修改和协作占用'
                          : undefined
                        : !cleanupStateAllowed
                          ? '当前状态不支持清理或放弃'
                          : !diagnosed
                            ? '正在检查 Worktree 身份、修改和协作占用'
                            : !item.canCleanup
                              ? '检测到修改、身份异常或其他安全占用，暂不能清理'
                              : undefined
                      return (
                        <div key={item.checkoutId} className={cn('rounded-lg border p-3', attention && 'border-amber-500/30 bg-amber-500/5')}>
                          <div className="flex items-start gap-3">
                            {attention ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" /> : <HardDrive className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-start gap-2">
                                <div className="min-w-0 flex-1">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="truncate text-sm font-medium">{item.ownerSessionTitle}</span>
                                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{item.project.name}</span>
                                    <span className="text-[10px] text-muted-foreground">Iteration {item.iteration}</span>
                                  </div>
                                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                                    <span>{stateLabel(item)}</span>
                                    <span>{diagnosed ? formatBytes(item.approximateBytes) : '正在检查占用…'}</span>
                                    {item.commitOid ? <span>Commit {item.commitOid.slice(0, 8)}</span> : null}
                                    {retentionLabel(item) ? <span>{retentionLabel(item)}</span> : null}
                                  </div>
                                </div>

                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <Button type="button" variant="ghost" size="icon-sm" disabled={pending} aria-label={`管理 ${item.ownerSessionTitle}`}>
                                      {pending ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-4" />}
                                    </Button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="z-[120] min-w-56">
                                    <DropdownMenuItem onSelect={() => {
                                      setManager((current) => ({ ...current, open: false }))
                                      openSession('agent', item.ownerSessionId, item.ownerSessionTitle)
                                    }}>
                                      <ExternalLink />返回会话
                                    </DropdownMenuItem>
                                    <DropdownMenuItem disabled={!item.canReveal} onSelect={() => void reveal(item)} title={item.canReveal ? undefined : 'Worktree 目录不存在或身份尚未恢复'}>
                                      <FolderOpen />打开目录
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuLabel>冻结环境保留期限</DropdownMenuLabel>
                                    {RETENTION_OPTIONS.map((option) => {
                                      const retentionDisabled = item.state !== 'retained' || item.retention === option.value || pending
                                      return (
                                        <DropdownMenuItem
                                          key={option.value}
                                          disabled={retentionDisabled}
                                          title={item.state !== 'retained' ? '只有已冻结保留的 Worktree 可以调整期限' : undefined}
                                          onSelect={() => void manage(item, 'set_retention', option.value)}
                                        >
                                          {item.retention === option.value ? <Check /> : <span className="size-4" />}{option.label}
                                        </DropdownMenuItem>
                                      )
                                    })}
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      className="text-destructive focus:text-destructive"
                                      disabled={pending || cleanupDisabledReason !== undefined}
                                      title={cleanupDisabledReason}
                                      onSelect={() => {
                                        if (destructiveAction === 'retry_cleanup') void manage(item, 'retry_cleanup')
                                        else openDialogAfterDropdownMenu(() => setCleanupTarget(item))
                                      }}
                                    >
                                      {retryCleanup ? <RefreshCw /> : <Trash2 />}
                                      {discardStateAllowed ? '放弃任务并清理' : retryCleanup ? '重试清理环境' : '立即清理环境'}
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>

                              {item.cleanup ? (
                                <p className={cn('mt-2 text-[11px]', item.cleanup.eligibility === 'safe' ? 'text-emerald-600 dark:text-emerald-400' : item.cleanup.eligibility === 'retained' ? 'text-blue-600 dark:text-blue-400' : 'text-amber-700 dark:text-amber-300')}>
                                  <span className="mr-1 font-semibold">{item.cleanup.eligibility === 'safe' ? '可安全清理' : item.cleanup.eligibility === 'retained' ? '按策略保留' : '清理受阻'}：</span>
                                  {item.cleanup.message}
                                </p>
                              ) : null}
                              {item.cleanupMessage ? (
                                <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
                                  {cleanupReasonLabel(item) ? <span className="mr-1 font-semibold">{cleanupReasonLabel(item)}：</span> : null}
                                  {item.cleanupMessage}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </section>
                )
              })}
            </div>
          )}
        </div>
      </SheetContent>
      <AlertDialog open={bulkCleanupOpen} onOpenChange={setBulkCleanupOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清理全部已证明安全的 Worktree？</AlertDialogTitle>
            <AlertDialogDescription>
              这里只展示只读巡检结论。确认后 main 会重新校验 revision、checkout identity、交付状态、保留期限、协作占用和提交后修改；任何变化都会使对应项继续保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-72 space-y-3 overflow-y-auto scrollbar-thin text-xs">
            <div>
              <p className="font-medium text-foreground">将尝试清理 · {safeCleanupItems.length}</p>
              <ul className="mt-1 space-y-1 text-muted-foreground">
                {safeCleanupItems.map((item) => <li key={item.checkoutId}>• {item.ownerSessionTitle} · Iteration {item.iteration}{item.commitOid ? ` · ${item.commitOid.slice(0, 8)}` : ''}</li>)}
              </ul>
            </div>
            {retainedCleanupItems.length > 0 ? (
              <div className="rounded-md border border-amber-500/25 bg-amber-500/5 p-2">
                <p className="font-medium text-foreground">本次明确保留 · {retainedCleanupItems.length}</p>
                <ul className="mt-1 space-y-1 text-muted-foreground">
                  {retainedCleanupItems.map((item) => <li key={item.checkoutId}>• {item.ownerSessionTitle} · Iteration {item.iteration} · {item.cleanup?.message ?? stateLabel(item)}</li>)}
                </ul>
              </div>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction disabled={safeCleanupItems.length === 0 || bulkCleaning} onClick={() => void bulkCleanup()}>
              确认清理 {safeCleanupItems.length} 个安全项
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={cleanupTarget !== null} onOpenChange={(open) => { if (!open) setCleanupTarget(null) }}>        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{targetIsDiscard ? '放弃任务并清理 Worktree？' : '清理已保留的 Worktree？'}</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              {targetIsDiscard ? (
                <>
                  <span className="block">将放弃“{cleanupTarget?.ownerSessionTitle ?? '当前任务'}”第 {cleanupTarget?.iteration ?? 0} 轮。Worktree 中尚未交付的修改会永久丢弃，Local 不会被静默覆盖。</span>
                  {cleanupTarget?.state === 'preview_active' ? <span className="block">放弃任务不会撤回 Local Preview。只有能证明 Preview 已提交时才清理 Worktree；否则会停止并保留恢复证据。</span> : null}
                  {(cleanupTarget?.activeSessionIds?.length ?? 0) > 0 ? (
                    <span className="block">同一次确认将先保存并停止运行中的会话：{cleanupTarget!.activeSessionIds!.join('、')}；未能停止时不会删除 Worktree。</span>
                  ) : null}
                </>
              ) : (
                <span>将删除“{cleanupTarget?.ownerSessionTitle ?? '当前任务'}”第 {cleanupTarget?.iteration ?? 0} 轮的冻结运行环境。Commit、会话和验收记录不会删除；检测到新增修改或身份异常时会停止清理。</span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                const target = cleanupTarget
                setCleanupTarget(null)
                if (target) void manage(target, targetIsDiscard ? 'discard' : 'cleanup_retained')
              }}
            >{targetIsDiscard ? '确认放弃任务' : '确认清理环境'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  )
}

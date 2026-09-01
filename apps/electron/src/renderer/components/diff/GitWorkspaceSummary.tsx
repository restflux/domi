import * as React from 'react'
import { ArrowUpDown, Check, GitBranch, History, RefreshCw } from 'lucide-react'
import type { GitRepositorySnapshot, GitWorkspaceBranchesResult } from '@domi/shared'
import { cn } from '@/lib/utils'
import { getRepositoryBranchLabel } from '@/lib/git-workspace-view-model'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

export async function requestBranchesWhenOpen(
  open: boolean,
  onBranches: () => Promise<GitWorkspaceBranchesResult>,
): Promise<GitWorkspaceBranchesResult | null> {
  if (!open) return null
  return onBranches()
}

export function GitWorkspaceSummary({
  repository,
  loading,
  onRefresh,
  onBranches,
  onCheckout,
  onSync,
  onOpenHistory,
}: {
  repository: GitRepositorySnapshot
  loading: boolean
  onRefresh: () => void
  /** 提供后分支名变为可点击选择器（本地分支列表）。 */
  onBranches?: () => Promise<GitWorkspaceBranchesResult>
  /** 切换分支；失败信息由调用方提示。 */
  onCheckout?: (branch: string) => Promise<void>
  /** 一键同步（拉取后推送，VS Code 语义）；失败信息由调用方提示。 */
  onSync?: () => void | Promise<void>
  onOpenHistory?: () => void | Promise<void>
}): React.ReactElement {
  const branchLabel = getRepositoryBranchLabel(repository)
  const shortHead = repository.headOid?.slice(0, 7)
  const total = repository.conflicts.length + repository.staged.length
    + repository.unstaged.length + repository.untracked.length
  const [branchesOpen, setBranchesOpen] = React.useState(false)
  const [branches, setBranches] = React.useState<GitWorkspaceBranchesResult | null>(null)
  const [branchesLoading, setBranchesLoading] = React.useState(false)
  const [branchesError, setBranchesError] = React.useState(false)
  const [switching, setSwitching] = React.useState(false)
  const branchesRequestRef = React.useRef(0)

  React.useEffect(() => {
    branchesRequestRef.current += 1
    setBranches(null)
    setBranchesLoading(false)
    setBranchesError(false)
  }, [repository.repositoryId])

  const loadBranches = React.useCallback(async (open: boolean) => {
    if (!onBranches || !open) return
    const requestId = ++branchesRequestRef.current
    setBranchesLoading(true)
    setBranchesError(false)
    try {
      const result = await requestBranchesWhenOpen(open, onBranches)
      if (requestId === branchesRequestRef.current) setBranches(result)
    } catch {
      if (requestId === branchesRequestRef.current) setBranchesError(true)
    } finally {
      if (requestId === branchesRequestRef.current) setBranchesLoading(false)
    }
  }, [onBranches])

  const handleBranchesOpen = React.useCallback((open: boolean) => {
    setBranchesOpen(open)
    if (!branches && !branchesLoading) void loadBranches(open)
  }, [branches, branchesLoading, loadBranches])

  const handleCheckout = React.useCallback(async (branch: string) => {
    if (!onCheckout || switching) return
    setSwitching(true)
    try {
      await onCheckout(branch)
      setBranches((current) => current ? { ...current, current: branch } : current)
      setBranchesOpen(false)
    } finally {
      setSwitching(false)
    }
  }, [onCheckout, switching])

  const branchControl = onBranches ? (
    <Popover open={branchesOpen} onOpenChange={handleBranchesOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="切换分支"
          className="min-w-0 flex-1 truncate text-left text-xs font-medium hover:text-foreground/80 transition-colors"
        >
          {branchLabel}
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-52 p-1">
        <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground">本地分支</div>
        {branchesLoading ? (
          <div className="px-2 py-2 text-[11px] text-muted-foreground">加载分支…</div>
        ) : branchesError ? (
          <button
            type="button"
            className="w-full rounded px-2 py-2 text-left text-[11px] text-destructive transition-colors hover:bg-muted/60"
            onClick={() => void loadBranches(true)}
          >
            加载失败，点击重试
          </button>
        ) : !branches ? (
          <div className="px-2 py-2 text-[11px] text-muted-foreground">加载分支…</div>
        ) : branches.local.length === 0 ? (
          <div className="px-2 py-2 text-[11px] text-muted-foreground">暂无本地分支</div>
        ) : (
          <div className="max-h-64 overflow-y-auto scrollbar-thin">
            {branches.local.map((branch) => {
              const isCurrent = branch === branches.current
              return (
                <button
                  key={branch}
                  type="button"
                  disabled={isCurrent || switching}
                  onClick={() => void handleCheckout(branch)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors',
                    isCurrent
                      ? 'bg-primary/10 font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-50',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{branch}</span>
                  {isCurrent && <Check className="size-3 shrink-0 text-primary" />}
                </button>
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  ) : (
    <span className="min-w-0 flex-1 truncate text-xs font-medium" title={branchLabel}>{branchLabel}</span>
  )

  return (
    <div className="border-b border-border/50 bg-muted/15 px-3 py-2">
      <div className="flex items-center gap-2">
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
        {branchControl}
        {shortHead && <code className="shrink-0 text-[10px] text-muted-foreground">{shortHead}</code>}
        {onSync && (
          <button
            type="button"
            aria-label="同步"
            title="同步（拉取后推送）"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground"
            onClick={() => void onSync()}
            disabled={loading}
          >
            <ArrowUpDown className="size-3.5" />
          </button>
        )}
        {onOpenHistory && (
          <button
            type="button"
            aria-label="提交历史"
            title="提交历史"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground"
            onClick={onOpenHistory}
          >
            <History className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          aria-label="刷新 Git 状态"
          title={repository.upstream ? '获取远端更新并刷新状态' : '刷新 Git 状态'}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground"
          onClick={onRefresh}
          disabled={loading}
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </button>
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
        {repository.upstream ? <span className="truncate">{repository.upstream}</span> : <span>无 upstream</span>}
        {(repository.ahead > 0 || repository.behind > 0) && (
          <span className="shrink-0 tabular-nums">↑{repository.ahead} ↓{repository.behind}</span>
        )}
        <span className="ml-auto shrink-0 tabular-nums">{total} 项</span>
      </div>
    </div>
  )
}

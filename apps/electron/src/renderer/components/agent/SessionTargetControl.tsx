import type * as React from 'react'
import { Boxes, ChevronDown, FolderGit2, FolderOpen, GitBranch, GitBranchPlus, HardDrive, Loader2, RotateCcw, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils.ts'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import {
  buildSessionTargetViewModel,
  type SessionTargetChoice,
  type SessionTargetDisplayInput,
  type SessionTargetStatusViewModel,
} from '@/lib/session-target-view-model.ts'

export interface SessionTargetControlProps {
  target: SessionTargetDisplayInput
  compact?: boolean
  disabled?: boolean
  className?: string
  onChooseTarget: (choice: SessionTargetChoice) => void
  /** 顶部状态栏 Worktree 勾选（参考 Claude 桌面版）：local 时可勾选/取消，isolated 时勾选且禁用。 */
  worktreeChecked?: boolean
  worktreeDisabled?: boolean
  /** 当前项目是否支持创建 Isolated Checkout；未传入时保持旧行为。 */
  worktreeAvailable?: boolean
  worktreeUnavailableReason?: string
  onToggleWorktree?: (checked: boolean) => void
  /** 由宿主按 sessionId 打开可信目标；renderer 不持有绝对路径。 */
  onRevealTarget?: () => void
  onOpenWorktreeManager?: (scope: 'project' | 'all') => void
  /** Worktree 生命周期操作显示在状态卡片中，而不是文件改动面板。 */
  worktreeLifecycleAction?: {
    label: string
    icon: 'cleanup' | 'retry'
    disabled?: boolean
    pending?: boolean
    onClick: () => void
  }
  /** 所有已绑定 Agent 会话都可主动创建 durable handoff。 */
  sessionHandoffAction?: {
    disabled?: boolean
    pending?: boolean
    onClick: () => void
  }
}

const STATUS_CLASSES: Record<SessionTargetStatusViewModel['tone'], string> = {
  neutral: 'bg-muted text-muted-foreground',
  progress: 'bg-primary/10 text-primary',
  ready: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  muted: 'bg-muted text-muted-foreground',
}

export function SessionTargetControl({
  target,
  compact = false,
  disabled = false,
  className,
  onChooseTarget: _onChooseTarget,
  worktreeChecked = false,
  worktreeDisabled = false,
  worktreeAvailable = true,
  worktreeUnavailableReason = 'Worktree 仅支持 Git 项目',
  onToggleWorktree,
  onRevealTarget,
  onOpenWorktreeManager,
  worktreeLifecycleAction,
  sessionHandoffAction,
}: SessionTargetControlProps): React.ReactElement {
  const model = buildSessionTargetViewModel(target)
  const isWorktree = target.checkout.kind === 'isolated'
  const compactTargetLabel = isWorktree ? 'Worktree' : 'Local'
  const CompactTargetIcon = isWorktree ? FolderGit2 : HardDrive

  const worktreeUnavailable = !worktreeAvailable
  const worktreeToggle = onToggleWorktree ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <label
          className={cn(
            'flex shrink-0 select-none items-center gap-1 text-[11px] text-muted-foreground',
            worktreeUnavailable || worktreeDisabled || disabled ? 'cursor-not-allowed' : 'cursor-pointer',
          )}
        >
          <input
            type="checkbox"
            checked={worktreeChecked}
            disabled={worktreeDisabled || disabled || worktreeUnavailable}
            onChange={(event) => { onToggleWorktree(event.target.checked) }}
            className="size-3 accent-primary"
          />
          <span className="font-medium">Worktree（隔离副本）</span>
        </label>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        <p>
          {worktreeUnavailable
            ? '当前项目不是 Git 仓库，无法使用 Worktree 隔离副本'
            : '勾选后在独立副本中修改代码，不影响原项目；不勾选则直接在原项目中修改'}
        </p>
      </TooltipContent>
    </Tooltip>
  ) : null
  const worktreeUnavailableChip = onToggleWorktree && worktreeUnavailable ? (
    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
      仅 Git 项目支持
    </span>
  ) : null
  const pendingCreationChip = worktreeChecked && !worktreeUnavailable && target.checkout.kind !== 'isolated' ? (
    <span className="shrink-0 rounded-full bg-sky-500/10 px-2 py-0.5 font-medium text-sky-700 dark:text-sky-400">
      首次发送时创建
    </span>
  ) : null
  // 就绪与未选择（默认 Local）无需提示；仅在异常/进行中状态显示徽标。
  const statusBadge = (model.status.tone === 'ready' || model.status.tone === 'neutral') ? null : (
    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium', STATUS_CLASSES[model.status.tone])}>
      {model.status.tone === 'progress' ? <Loader2 className="mr-1 inline size-3 animate-spin" /> : null}
      {model.status.label}
    </span>
  )

  if (compact) {
    const iteration = target.delivery?.state === 'working' || target.delivery?.state === 'delivered'
      ? target.delivery.iteration
      : target.delivery?.review.iteration
    const checkpointCount = target.checkpoints?.length ?? 0
    const productLabel = isWorktree
      ? model.status.label === '已交付' || model.status.label === '已放弃'
        ? model.status.label
        : checkpointCount > 0 && target.delivery?.state === 'working'
          ? `Worktree · ${checkpointCount} 个阶段未交付`
          : `Worktree · ${model.status.label}`
      : 'Local'
    const canReveal = !!onRevealTarget && target.checkout.phase !== 'discarded'
    const tooltip = (
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground">修改环境</span><span>{isWorktree ? '隔离 Worktree' : 'Local Checkout'}</span>
        <span className="text-muted-foreground">状态</span><span>{model.status.label}</span>
        {model.identity.sourceLabel ? <><span className="text-muted-foreground">来源</span><span>{model.identity.sourceLabel.replace(/^来自\s*/, '')} · {target.source?.oid.slice(0, 7)}</span></> : null}
        {model.identity.branchLabel ? <><span className="text-muted-foreground">当前 Git</span><span>{model.identity.branchLabel} · {model.identity.headLabel}</span></> : null}
        {iteration ? <><span className="text-muted-foreground">Iteration</span><span>{iteration}</span></> : null}
        {checkpointCount > 0 ? <><span className="text-muted-foreground">阶段保存</span><span>已保存 {checkpointCount} 个，尚未交付到 Local</span></> : null}
        {target.delivery?.state === 'retained' ? <><span className="text-muted-foreground">保留</span><span>{target.delivery.expiresAt ? new Date(target.delivery.expiresAt).toLocaleString() : '手动清理'}</span></> : null}
      </div>
    )
    return (
      <section className={cn('flex min-w-0 items-center gap-2 text-foreground', className)} aria-label="当前修改环境">
        <span className="min-w-0 truncate text-xs font-semibold">{model.identity.projectName}</span>
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-session-target-mode={isWorktree ? 'worktree' : 'local'}
                  data-session-handoff-available={sessionHandoffAction ? 'true' : undefined}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-semibold transition-colors hover:bg-muted/70',
                    model.status.tone === 'warning'
                      ? 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                      : isWorktree
                        ? 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                        : 'border-border/50 bg-background/60 text-muted-foreground',
                  )}
                >
                  <CompactTargetIcon className="size-3" aria-hidden="true" />
                  {productLabel}
                  <ChevronDown className="size-3 opacity-60" />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-sm p-3">{tooltip}</TooltipContent>
          </Tooltip>
          <PopoverContent align="end" className="w-80 space-y-3 p-3">
            <div>
              <div className="text-sm font-medium">{productLabel}</div>
              <p className="mt-1 text-xs text-muted-foreground">
                {target.delivery?.state === 'delivered'
                  ? '本轮已经提交并清理；后续可在当前会话创建新的 Worktree。'
                  : target.delivery?.state === 'retained'
                    ? '本轮已经提交，当前运行环境处于冻结保留状态。'
                    : isWorktree ? checkpointCount > 0 ? `当前 Worktree 已保存 ${checkpointCount} 个未交付阶段；后续验收会包含这些阶段。` : '当前会话在独立 Worktree 中工作。' : '当前会话直接使用 Local Checkout。'}
              </p>
            </div>
            <div className="rounded-md bg-muted/40 p-2.5">{tooltip}</div>
            <div className="grid gap-1">
              {canReveal ? (
                <button type="button" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted" onClick={onRevealTarget}>
                  <FolderOpen className="size-3.5" />打开当前工作位置
                </button>
              ) : null}
              {sessionHandoffAction ? (
                <button
                  type="button"
                  disabled={sessionHandoffAction.disabled || sessionHandoffAction.pending}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={sessionHandoffAction.onClick}
                >
                  {sessionHandoffAction.pending ? <Loader2 className="size-3.5 animate-spin" /> : <GitBranchPlus className="size-3.5" />}
                  {sessionHandoffAction.pending ? '正在交接' : '交接到新会话'}
                </button>
              ) : null}
              {isWorktree && onOpenWorktreeManager ? (
                <>
                  <button type="button" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted" onClick={() => onOpenWorktreeManager('project')}>
                    <FolderGit2 className="size-3.5" />管理当前项目 Worktrees
                  </button>
                  <button type="button" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted" onClick={() => onOpenWorktreeManager('all')}>
                    <Boxes className="size-3.5" />管理所有 Worktrees
                  </button>
                </>
              ) : null}
              {isWorktree && worktreeLifecycleAction ? (
                <>
                  <div className="my-1 border-t border-border/60" />
                  <button
                    type="button"
                    disabled={worktreeLifecycleAction.disabled || worktreeLifecycleAction.pending}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs disabled:cursor-not-allowed disabled:opacity-50',
                      worktreeLifecycleAction.icon === 'cleanup'
                        ? 'text-destructive hover:bg-destructive/10'
                        : 'text-foreground hover:bg-muted',
                    )}
                    onClick={worktreeLifecycleAction.onClick}
                  >
                    {worktreeLifecycleAction.pending
                      ? <Loader2 className="size-3.5 animate-spin" />
                      : worktreeLifecycleAction.icon === 'cleanup'
                        ? <Trash2 className="size-3.5" />
                        : <RotateCcw className="size-3.5" />}
                    {worktreeLifecycleAction.pending ? '处理中' : worktreeLifecycleAction.label}
                  </button>
                </>
              ) : null}
            </div>
          </PopoverContent>
        </Popover>
      </section>
    )
  }

  // 非 compact：作为输入框上方的轻量元信息行，不再嵌套独立卡片表面。
  return (
    <section
      data-session-target-chooser="true"
      className={cn(
        'flex min-h-9 min-w-0 items-center rounded-[10px] border border-transparent bg-transparent px-2.5 py-1 text-foreground',
        className,
      )}
      aria-label="当前修改环境"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]">
        <span className="truncate text-xs font-semibold">{model.identity.projectName}</span>
        <span className="shrink-0 rounded-md bg-background/70 px-1.5 py-0.5 text-xs font-semibold">
          {model.identity.targetLabel}
        </span>
        {statusBadge}
        {model.identity.branchLabel ? (
          <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
            <GitBranch className="size-3.5 shrink-0" />
            <span className="truncate">{model.identity.branchLabel}</span>
          </span>
        ) : null}
        {model.identity.sourceLabel ? (
          <span className="shrink-0 text-muted-foreground">{model.identity.sourceLabel}</span>
        ) : null}
        {model.identity.headLabel ? (
          <code className="shrink-0 rounded bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            HEAD {model.identity.headLabel}
          </code>
        ) : null}
        {model.inheritanceLabel ? (
          <span className="shrink-0 rounded-full bg-sky-500/10 px-2 py-0.5 font-medium text-sky-700 dark:text-sky-400">
            {model.inheritanceLabel}
          </span>
        ) : null}
        {worktreeToggle}
        {worktreeUnavailableChip}
        {pendingCreationChip}
      </div>
    </section>
  )
}

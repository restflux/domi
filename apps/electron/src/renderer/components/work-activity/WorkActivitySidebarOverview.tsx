import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Activity, AlertCircle, CheckCircle2 } from 'lucide-react'
import type { WorkActivityState } from '@domi/shared'
import { workActivityProjectionAtom } from '@/atoms/work-activity-atoms'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useSessionMiniMapHover } from '@/components/session-preview/SessionMiniMapPopover'
import { WorkActivityHoverPreview } from './WorkActivityHoverPreview'
import { cn } from '@/lib/utils'

interface WorkActivitySidebarOverviewProps {
  active: boolean
  onOpenAll: () => void
  onOpenSession: (sessionId: string, title: string) => void
}

const STATE_META: Record<WorkActivityState, {
  label: string
  shortLabel: string
  dot: string
  icon: typeof Activity
}> = {
  attention_required: {
    label: '需要处理',
    shortLabel: '需处理',
    dot: 'bg-amber-500',
    icon: AlertCircle,
  },
  working: {
    label: '正在工作',
    shortLabel: '进行中',
    dot: 'bg-blue-500',
    icon: Activity,
  },
  recently_completed: {
    label: '最近完成',
    shortLabel: '已完成',
    dot: 'bg-emerald-500',
    icon: CheckCircle2,
  },
}

function formatCount(count: number, loaded: boolean): string {
  if (!loaded) return '—'
  return count > 99 ? '99+' : String(count)
}

/**
 * Work 模式紧凑入口。常驻区域只显示标题与三类计数；多会话列表按需在悬浮层挂载，
 * 不在侧栏重复扫描会话、Session Target 或 Automation 数据。
 */
export const WorkActivitySidebarOverview = React.memo(function WorkActivitySidebarOverview({
  active,
  onOpenAll,
  onOpenSession,
}: WorkActivitySidebarOverviewProps): React.ReactElement {
  const projection = useAtomValue(workActivityProjectionAtom)
  const preview = useSessionMiniMapHover(500)
  const loaded = projection.generatedAt > 0
  const attentionCount = formatCount(projection.counts.attention_required, loaded)
  const workingCount = formatCount(projection.counts.working, loaded)
  const completedCount = formatCount(projection.counts.recently_completed, loaded)
  const ariaLabel = loaded
    ? `工作动态概览，需要处理 ${projection.counts.attention_required}，正在工作 ${projection.counts.working}，最近完成 ${projection.counts.recently_completed}`
    : '工作动态概览，状态读取中'

  const { closeNow } = preview
  const openAll = React.useCallback((): void => {
    closeNow()
    onOpenAll()
  }, [closeNow, onOpenAll])
  const openSession = React.useCallback((sessionId: string, title: string): void => {
    closeNow()
    onOpenSession(sessionId, title)
  }, [closeNow, onOpenSession])

  return (
    <div
      ref={preview.setAnchorRef}
      className="titlebar-no-drag"
      onMouseEnter={preview.handleMouseEnter}
      onMouseLeave={preview.handleMouseLeave}
    >
      <button
        type="button"
        onClick={openAll}
        aria-label={ariaLabel}
        className={cn(
          'flex h-11 w-full items-center gap-2.5 rounded-xl px-3 text-left transition-colors titlebar-no-drag',
          active
            ? 'bg-primary/[0.09] text-foreground ring-1 ring-inset ring-primary/18'
            : 'bg-foreground/[0.025] text-foreground/75 hover:bg-foreground/[0.05] hover:text-foreground',
        )}
      >
        <Activity className={cn('size-4 flex-none', active ? 'text-primary' : 'text-foreground/45')} />
        <span className="min-w-0 flex-none text-[13px] font-medium">工作动态</span>
        <span className="ml-auto flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-[9px] tabular-nums text-muted-foreground">
          <span className={cn('flex-none', projection.counts.attention_required > 0 && loaded && 'font-semibold text-amber-600 dark:text-amber-400')}>需处理 {attentionCount}</span>
          <span className="flex-none" aria-hidden>·</span>
          <span className="flex-none">进行中 {workingCount}</span>
          <span className="flex-none" aria-hidden>·</span>
          <span className="flex-none">已完成 {completedCount}</span>
        </span>
      </button>

      <WorkActivityHoverPreview
        anchorRef={preview.anchorRef}
        open={preview.isOpen}
        isLeaving={preview.isLeaving}
        onMouseEnter={preview.handlePanelMouseEnter}
        onMouseLeave={preview.handlePanelMouseLeave}
        onOpenAll={openAll}
        onOpenSession={openSession}
      />
    </div>
  )
})

export const WorkActivitySidebarRailButton = React.memo(function WorkActivitySidebarRailButton({
  active,
  onClick,
}: {
  active: boolean
  onClick: () => void
}): React.ReactElement {
  const projection = useAtomValue(workActivityProjectionAtom)
  const loaded = projection.generatedAt > 0
  const attentionCount = projection.counts.attention_required
  const workingCount = projection.counts.working
  const completedCount = projection.counts.recently_completed
  const summary = `需处理 ${formatCount(attentionCount, loaded)} · 进行中 ${formatCount(workingCount, loaded)} · 已完成 ${formatCount(completedCount, loaded)}`
  const ariaLabel = loaded
    ? `工作动态，需要处理 ${attentionCount}，正在工作 ${workingCount}，最近完成 ${completedCount}`
    : '工作动态，状态读取中'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          onClick={onClick}
          className={cn(
            'relative flex size-10 items-center justify-center rounded-[12px] border transition-colors titlebar-no-drag',
            active
              ? 'border-primary/80 bg-primary text-primary-foreground shadow-sm'
              : 'border-border/45 bg-foreground/[0.025] text-foreground/45 hover:border-border/70 hover:bg-foreground/[0.045] hover:text-primary',
          )}
        >
          <Activity size={16} />
          {loaded && attentionCount > 0 ? (
            <span className={cn(
              'absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums',
              active ? 'bg-primary-foreground text-primary' : 'bg-amber-500 text-white',
            )}>
              {attentionCount > 99 ? '99+' : attentionCount}
            </span>
          ) : loaded && workingCount > 0 ? (
            <span className="absolute right-0.5 top-0.5 size-2 rounded-full bg-blue-500 ring-2 ring-[hsl(var(--sidebar-surface))]" aria-label="有工作正在进行" />
          ) : null}
          <span className="sr-only">{summary}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-64">
        <div className="font-medium">工作动态</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{summary}</div>
        {projection.sessions.slice(0, 3).map((session) => (
          <div key={session.id} className="mt-1 max-w-56 truncate text-[11px]">{session.title}</div>
        ))}
      </TooltipContent>
    </Tooltip>
  )
})

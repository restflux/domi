import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import {
  Activity,
  AlertCircle,
  Archive,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock3,
  ExternalLink,
  ListChecks,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Workflow,
} from 'lucide-react'
import type { WorkActivityState, WorkSessionView } from '@domi/shared'
import { useOpenSession } from '@/hooks/useOpenSession'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  collectWorkActivityWorkspaces,
  describeWorkActivityStopImpact,
  filterWorkActivitySessions,
} from './work-activity-view-model'
import {
  requestWorkActivityRefreshAtom,
  workActivityLoadingAtom,
  workActivityProjectionAtom,
  workActivityRefreshErrorAtom,
  workActivityRefreshingAtom,
} from '@/atoms/work-activity-atoms'

type WorkActivityScope = 'all' | WorkActivityState

const SECTIONS: Array<{
  state: WorkActivityState
  title: string
  shortTitle: string
  description: string
  emptyLabel: string
}> = [
  {
    state: 'attention_required',
    title: '需要处理',
    shortTitle: '待处理',
    description: '回答、批准、验收或需要知晓的异常',
    emptyLabel: '暂无需要处理的任务',
  },
  {
    state: 'working',
    title: '正在工作',
    shortTitle: '进行中',
    description: '仍在运行的父会话与协作子 Agent',
    emptyLabel: '暂无进行中的任务',
  },
  {
    state: 'recently_completed',
    title: '最近完成',
    shortTitle: '已完成',
    description: '今天完成且尚未移出的工作',
    emptyLabel: '暂无已完成的任务',
  },
]

/**
 * 状态涂装系统：rail（左侧状态条）、icon（图标徽章）、count（分组计数）、text（状态文字）、dot（进度圆点）
 * 全部围绕 amber / blue / emerald 三色系派生，保证亮暗主题下都有一致的层次。
 */
const STATE_TONES = {
  attention_required: {
    rail: 'bg-amber-500/80',
    icon: 'bg-amber-500/10 text-amber-600 ring-inset ring-amber-500/20 dark:text-amber-400',
    count: 'bg-amber-500/12 text-amber-700 dark:text-amber-300',
    text: 'text-amber-700 dark:text-amber-300',
    dot: 'bg-amber-500',
  },
  working: {
    rail: 'bg-blue-500/80',
    icon: 'bg-blue-500/10 text-blue-600 ring-inset ring-blue-500/20 dark:text-blue-400',
    count: 'bg-blue-500/12 text-blue-700 dark:text-blue-300',
    text: 'text-blue-700 dark:text-blue-300',
    dot: 'bg-blue-500',
  },
  recently_completed: {
    rail: 'bg-emerald-500/70',
    icon: 'bg-emerald-500/10 text-emerald-600 ring-inset ring-emerald-500/20 dark:text-emerald-400',
    count: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
    text: 'text-emerald-700 dark:text-emerald-300',
    dot: 'bg-emerald-500',
  },
} as const satisfies Record<WorkActivityState, {
  rail: string
  icon: string
  count: string
  text: string
  dot: string
}>

/** CURRENT STAGE 步进指示器的三段流程。 */
const STAGE_FLOW: Array<{ label: string; state: WorkActivityState }> = [
  { label: '运行中', state: 'working' },
  { label: '等待', state: 'attention_required' },
  { label: '完成', state: 'recently_completed' },
]

/** 表格列头与行共用的栅格定义（保持列数一致）。 */
const TABLE_GRID = 'grid grid-cols-[44px_minmax(0,1.8fr)_minmax(0,1.2fr)_minmax(0,1fr)_64px_106px_84px_auto] items-center gap-x-3'

const TABLE_COLUMNS: Array<{ label: string; align?: string }> = [
  { label: '状态' },
  { label: '任务 · 原因' },
  { label: '阶段' },
  { label: '工作空间' },
  { label: '来源' },
  { label: '已等待' },
  { label: '归档' },
  { label: '操作', align: 'text-right' },
]

function formatDuration(from: number | undefined, now: number): string {
  if (!from) return '—'
  const seconds = Math.max(0, Math.floor((now - from) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分钟`
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
}

function pendingActionLabel(session: WorkSessionView): string {
  if (session.pendingActionKind === 'ask_user') return '去回答'
  if (session.pendingActionKind === 'permission') return '确认权限'
  if (session.pendingActionKind === 'plan_approval') return '审批计划'
  if (session.pendingActionKind === 'ready_for_review') return '去验收'
  if (session.pendingActionKind === 'conflict') return '处理冲突'
  return '打开会话'
}

function StateIcon({ state }: { state: WorkActivityState }): React.ReactElement {
  const icon = state === 'attention_required'
    ? <AlertCircle className="size-4" />
    : state === 'working'
      ? <Activity className="size-4" />
      : <CheckCircle2 className="size-4" />
  return (
    <span className={cn('inline-flex size-7 flex-none items-center justify-center rounded-lg ring-1', STATE_TONES[state].icon)}>
      {icon}
    </span>
  )
}

function elapsedLabel(session: WorkSessionView, now: number): string {
  if (session.state === 'attention_required') return `已等待 ${formatDuration(session.stateChangedAt, now)}`
  if (session.state === 'working') return `已运行 ${formatDuration(session.startedAt, now)}`
  return `${formatDuration(session.stateChangedAt, now)}前完成`
}

export function WorkActivityRefreshFailure({
  reason,
  retrying,
  onRetry,
}: {
  reason: string
  retrying: boolean
  onRetry: () => void
}): React.ReactElement {
  return (
    <div className="mx-6 mt-4 flex items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/[0.055] px-3.5 py-3 sm:mx-8" role="alert" aria-live="polite">
      <AlertCircle className="mt-0.5 size-4 flex-none text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-foreground">工作动态刷新失败</p>
        <p className="mt-0.5 break-words text-xs leading-5 text-muted-foreground">{reason}</p>
      </div>
      <Button type="button" size="sm" variant="outline" disabled={retrying} onClick={onRetry} className="h-7 flex-none text-xs">
        <RefreshCw className={cn('size-3.5', retrying && 'animate-spin')} />
        {retrying ? '重试中…' : '重试'}
      </Button>
    </div>
  )
}

interface WorkActivityItemProps {
  session: WorkSessionView
  now: number
  selected: boolean
  onSelect: (session: WorkSessionView) => void
  onOpen: (session: WorkSessionView) => void
  onAcknowledge: (session: WorkSessionView) => void
}

function WorkActivityItem({
  session,
  now,
  selected,
  onSelect,
  onOpen,
  onAcknowledge,
}: WorkActivityItemProps): React.ReactElement {
  const isFailure = session.pendingActionKind === 'failure' || session.pendingActionKind === 'interrupted'
  const tone = STATE_TONES[session.state]

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`查看 ${session.title} 的工作详情`}
      onClick={() => onSelect(session)}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(session) } }}
      className={cn(
        `${TABLE_GRID} group relative cursor-pointer px-3 py-2.5 transition-colors`,
        selected ? 'bg-primary/[0.045]' : 'hover:bg-muted/25',
        session.state === 'recently_completed' && 'opacity-80',
      )}
    >
      {/* 左侧状态条 */}
      <span aria-hidden className={cn('absolute inset-y-2 left-0 w-[3px] rounded-r-full', tone.rail)} />
      <span className="flex-none"><StateIcon state={session.state} /></span>

      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-[13px] font-semibold leading-5 text-foreground">{session.title}</h3>
          {session.unread ? (
            <span className="size-1.5 flex-none rounded-full bg-primary shadow-[0_0_0_3px] shadow-primary/20" aria-label="未读" />
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-xs leading-4">
          <span className={cn('font-medium', session.state === 'attention_required' ? tone.text : 'text-foreground/75')}>{session.reason}</span>
        </p>
      </div>

      <p className="truncate text-xs text-muted-foreground">{session.phaseSummary}</p>

      <span className="truncate rounded-md bg-muted/45 px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ring-border/40">{session.workspaceName}</span>

      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        {session.source === 'automation' ? <Clock3 className="size-3" /> : <Bot className="size-3" />}
        {session.source === 'automation' ? session.automationName || '自动任务' : '手动'}
      </span>

      <span className="text-[11px] tabular-nums text-muted-foreground">{elapsedLabel(session, now)}</span>

      <span>
        {session.archived ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><Archive className="size-3" />已归档</span>
        ) : <span className="text-muted-foreground/40">—</span>}
      </span>

      <div className="flex items-center justify-end gap-1.5">
        {isFailure ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={(event) => { event.stopPropagation(); onAcknowledge(session) }}
          >已知晓</Button>
        ) : null}
        {session.state === 'attention_required' && !isFailure ? (
          <Button
            type="button"
            size="sm"
            onClick={(event) => { event.stopPropagation(); onOpen(session) }}
          >
            {pendingActionLabel(session)}<ArrowRight className="size-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`查看 ${session.title} 的工作详情`}
          onClick={(event) => { event.stopPropagation(); onSelect(session) }}
          className="text-muted-foreground opacity-70"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      {/* 选中态的顶部内高光（玻璃质感） */}
      {selected ? <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" /> : null}
    </div>
  )
}

interface WorkActivityInspectorProps {
  session: WorkSessionView | null
  now: number
  onOpen: (session: WorkSessionView) => void
  onRemove: (session: WorkSessionView) => void
  onRequestStop: (session: WorkSessionView) => void
}

function StageSteps({ state }: { state: WorkActivityState }): React.ReactElement {
  const currentIndex = STAGE_FLOW.findIndex((stage) => stage.state === state)
  return (
    <div className="flex items-center gap-2 px-1">
      {STAGE_FLOW.map((stage, index) => {
        const reached = index <= currentIndex
        const isCurrent = index === currentIndex
        const tone = isCurrent ? STATE_TONES[state] : null
        return (
          <React.Fragment key={stage.state}>
            {index > 0 ? (
              <span
                aria-hidden
                className={cn('h-px flex-1', index <= currentIndex ? 'bg-emerald-500/60' : 'bg-border')}
              />
            ) : null}
            <span className="flex flex-col items-center gap-1 py-1">
              <span
                className={cn(
                  'size-2.5 rounded-full transition-colors',
                  isCurrent && tone ? cn(tone.dot, 'shadow-[0_0_0_4px]', tone.dot === 'bg-amber-500' ? 'shadow-amber-500/15' : tone.dot === 'bg-blue-500' ? 'shadow-blue-500/15' : 'shadow-emerald-500/15')
                    : reached ? 'bg-emerald-500/80' : 'bg-muted-foreground/30',
                )}
              />
              <span className={cn(
                'text-[10px] leading-none',
                isCurrent ? cn('font-semibold', tone?.text) : reached ? 'text-muted-foreground' : 'text-muted-foreground/60',
              )}>
                {stage.label}
              </span>
            </span>
          </React.Fragment>
        )
      })}
    </div>
  )
}

function WorkActivityInspector({
  session,
  now,
  onOpen,
  onRemove,
  onRequestStop,
}: WorkActivityInspectorProps): React.ReactElement {
  if (!session) {
    return (
      <aside className="flex min-h-[320px] items-center justify-center border-t border-border/50 bg-muted/[0.12] p-8 text-center backdrop-blur-sm lg:min-h-0 lg:border-l lg:border-t-0">
        <div className="max-w-[250px] rounded-xl border border-dashed border-border/70 bg-background/40 px-6 py-9">
          <div className="mx-auto flex size-11 items-center justify-center rounded-xl bg-muted/45 ring-1 ring-inset ring-border/40">
            <ListChecks className="size-5 text-muted-foreground/50" />
          </div>
          <p className="mt-3.5 text-sm font-medium">选择一项工作查看详情</p>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">这里会显示当前阶段、可见进度和协作 Agent。</p>
        </div>
      </aside>
    )
  }

  const visibleTasks = session.tasks.filter((task) => task.status !== 'deleted')
  const tone = STATE_TONES[session.state]

  return (
    <aside className="border-t border-border/50 bg-muted/[0.12] backdrop-blur-sm lg:border-l lg:border-t-0" aria-label="工作详情">
      <div className="p-5 lg:sticky lg:top-0">
        {/* 身份区：workspace 状态点 + 标题 */}
        <div className="flex items-start gap-3">
          <StateIcon state={session.state} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className={cn('inline-flex items-center gap-1.5 rounded-full bg-muted/50 px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ring-border/40', tone.text)}>
                <span className={cn('size-1.5 rounded-full', tone.dot)} />
                {SECTIONS.find((section) => section.state === session.state)?.shortTitle}
              </span>
              <p className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{session.workspaceName}</p>
            </div>
            <h2 className="mt-1.5 text-[15px] font-semibold leading-6">{session.title}</h2>
          </div>
        </div>

        {/* CURRENT STAGE：阶段步进指示器 */}
        <div className="mt-5 overflow-hidden rounded-xl border border-border/50 bg-background/80 shadow-sm">
          <div className="border-b border-border/40 bg-muted/30 px-3.5 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">当前阶段 · Current Stage</p>
          </div>
          <div className="px-3.5 py-3">
            <StageSteps state={session.state} />
            <p className="mt-1.5 text-xs font-semibold text-foreground">{session.phaseSummary}</p>
            <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
              <span className="truncate">{session.reason}</span>
              <span className="flex-none tabular-nums">{elapsedLabel(session, now)}</span>
            </div>
          </div>
        </div>

        {/* VISIBLE PROGRESS：时间线式任务列表 */}
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">可见进度 · Visible Progress</h3>
            <span className="text-[11px] tabular-nums text-muted-foreground">{visibleTasks.length} 项</span>
          </div>
          {visibleTasks.length > 0 ? (
            <div className="mt-2 space-y-0.5">
              {visibleTasks.map((task, index) => (
                <div
                  key={`${session.id}:${task.id}:${index}`}
                  className="flex items-start gap-2.5 rounded-lg px-1.5 py-2 transition-colors hover:bg-background/80"
                >
                  <span className={cn(
                    'mt-1 size-2 flex-none shrink-0 rounded-full',
                    task.status === 'completed' ? 'bg-emerald-500 shadow-[0_0_0_3px] shadow-emerald-500/15'
                      : task.status === 'blocked' || task.status === 'error' ? 'bg-amber-500 shadow-[0_0_0_3px] shadow-amber-500/15'
                        : task.status === 'in_progress' ? 'bg-blue-500 shadow-[0_0_0_3px] shadow-blue-500/15'
                          : 'bg-muted-foreground/35 shadow-[0_0_0_3px] shadow-muted-foreground/10',
                  )} />
                  <div className="min-w-0">
                    <p className="text-xs font-medium leading-4">{task.subject}</p>
                    <p className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-wide text-muted-foreground">{task.activeForm || task.status}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="mt-2 text-xs leading-5 text-muted-foreground">当前会话没有公开的任务进度。</p>}
        </div>

        {/* COLLABORATORS：协作 Agent */}
        {session.children.length > 0 ? (
          <div className="mt-5">
            <div className="flex items-center justify-between">
              <h3 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">协作 Agent · Collaborators</h3>
              <span className="text-[11px] tabular-nums text-muted-foreground">{session.completedChildren}/{session.totalChildren} 已完成</span>
            </div>
            <div className="mt-2 space-y-1.5">
              {session.children.map((child) => (
                <div key={child.sessionId} className="flex items-start gap-2 rounded-lg border border-border/45 bg-background/80 p-2.5 transition-colors hover:border-border/70">
                  <Workflow className="mt-0.5 size-3.5 flex-none text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{child.title}</p>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{child.phaseSummary}</p>
                  </div>
                  <span className={cn('mt-1 size-1.5 flex-none rounded-full', child.status === 'working' ? 'bg-blue-500' : child.status === 'attention_required' ? 'bg-amber-500' : 'bg-emerald-500')} />
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* 底部操作：主按钮通栏，次级按钮并排 */}
        <div className="mt-6 space-y-1.5 border-t border-border/55 pt-4">
          <Button type="button" className="w-full" onClick={() => onOpen(session)}>
            打开原会话<ExternalLink className="size-3.5" />
          </Button>
          {session.state === 'recently_completed' || session.activeSessionIds.length > 0 ? (
            <div className="flex gap-1.5">
              {session.state === 'recently_completed' ? (
                <Button type="button" size="sm" variant="outline" className="flex-1" onClick={() => onRemove(session)}>
                  <Trash2 className="size-3.5" />移出
                </Button>
              ) : null}
              {session.activeSessionIds.length > 0 ? (
                <Button type="button" size="sm" variant="ghost" className="flex-1 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => onRequestStop(session)}>
                  <Square className="size-3.5" />停止工作
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  )
}

export function WorkActivityView(): React.ReactElement {
  const openSession = useOpenSession()
  const projection = useAtomValue(workActivityProjectionAtom)
  const loading = useAtomValue(workActivityLoadingAtom)
  const refreshing = useAtomValue(workActivityRefreshingAtom)
  const refreshError = useAtomValue(workActivityRefreshErrorAtom)
  const requestRefresh = useSetAtom(requestWorkActivityRefreshAtom)
  const [query, setQuery] = React.useState('')
  const deferredQuery = React.useDeferredValue(query)
  const [workspaceId, setWorkspaceId] = React.useState('all')
  const [source, setSource] = React.useState('all')
  const [scope, setScope] = React.useState<WorkActivityScope>('all')
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [now, setNow] = React.useState(() => Date.now())
  const [stopTarget, setStopTarget] = React.useState<WorkSessionView | null>(null)
  const [stopping, setStopping] = React.useState(false)
  const refreshErrorShownRef = React.useRef(false)

  React.useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(clock)
  }, [])

  React.useEffect(() => {
    if (!refreshError) {
      refreshErrorShownRef.current = false
      return
    }
    if (refreshErrorShownRef.current) return
    refreshErrorShownRef.current = true
    toast.error('工作动态刷新失败', { description: refreshError })
  }, [refreshError])

  const workspaces = React.useMemo(
    () => collectWorkActivityWorkspaces(projection.sessions),
    [projection.sessions],
  )
  const filteredByControls = React.useMemo(
    () => filterWorkActivitySessions(projection.sessions, { query: deferredQuery, workspaceId, source }),
    [deferredQuery, projection.sessions, source, workspaceId],
  )
  const filtered = React.useMemo(
    () => scope === 'all'
      ? filteredByControls
      : filteredByControls.filter((session) => session.state === scope),
    [filteredByControls, scope],
  )
  const selectedSession = filtered.find((session) => session.id === selectedId) ?? filtered[0] ?? null

  const open = (session: WorkSessionView): void => {
    void window.electronAPI.markWorkActivityViewed(session.rootSessionId).catch(console.error)
    openSession('agent', session.rootSessionId, session.title)
  }

  const select = (session: WorkSessionView): void => {
    setSelectedId(session.id)
    if (session.unread) {
      void window.electronAPI.markWorkActivityViewed(session.rootSessionId).catch(console.error)
    }
  }

  const acknowledge = async (session: WorkSessionView): Promise<void> => {
    try {
      await window.electronAPI.acknowledgeWorkActivityOutcome(session.rootSessionId)
    } catch (error) {
      console.error(error)
      toast.error('标记已知晓失败')
    }
  }

  const remove = async (session: WorkSessionView): Promise<void> => {
    try {
      await window.electronAPI.removeWorkActivityCompleted(session.rootSessionId)
      if (selectedId === session.id) setSelectedId(null)
    } catch (error) {
      console.error(error)
      toast.error('移出最近完成失败')
    }
  }

  const stop = async (): Promise<void> => {
    if (!stopTarget || stopping) return
    setStopping(true)
    try {
      await window.electronAPI.stopWorkActivitySession(stopTarget.rootSessionId)
      setStopTarget(null)
    } catch (error) {
      console.error(error)
      toast.error('停止工作失败')
    } finally {
      setStopping(false)
    }
  }

  const removeAll = async (): Promise<void> => {
    try {
      await window.electronAPI.removeAllWorkActivityCompleted()
      setSelectedId(null)
    } catch (error) {
      console.error(error)
      toast.error('移出最近完成失败')
    }
  }

  const projectionLoaded = projection.generatedAt > 0
  const activeWorkspaceCount = React.useMemo(() => new Set(
    projection.sessions
      .filter((session) => session.state !== 'recently_completed')
      .map((session) => session.workspaceId ?? session.workspaceName),
  ).size, [projection.sessions])

  return (
    <section className="relative flex h-full min-h-0 flex-col overflow-hidden bg-content-area titlebar-no-drag">
      {/* 背景极淡辉光：工作台氛围（低透明度，不干扰内容） */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-72"
        style={{ background: 'radial-gradient(900px 300px at 72% -60px, hsl(var(--primary) / 0.07), transparent 65%)' }}
      />

      <header className="relative z-10 border-b border-border/50 bg-content-area/80 backdrop-blur-md">
        <div className="flex items-center px-5 pb-2.5 pt-4 sm:px-7">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex size-9 flex-none items-center justify-center rounded-xl bg-gradient-to-br from-primary/20 via-primary/10 to-transparent text-primary ring-1 ring-inset ring-primary/15 shadow-[inset_0_1px_0_0_hsl(0_0%_100%/0.06)]">
              <Activity className="size-[18px]" />
            </span>
            <div>
              <h1 className="text-base font-semibold leading-5 tracking-tight">工作动态</h1>
              <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                {activeWorkspaceCount > 0 ? `${activeWorkspaceCount} 个项目有活动工作` : '跨项目掌握 Agent 工作状态'}
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-5 pb-3 sm:px-7">
          <div className="flex max-w-full flex-none items-center gap-0.5 overflow-x-auto rounded-lg border border-border/50 bg-background/55 p-0.5 shadow-sm" aria-label="筛选工作状态">
            <button
              type="button"
              onClick={() => setScope('all')}
              className={cn(
                'flex-none rounded-md px-2.5 py-1.5 text-xs font-medium transition-all',
                scope === 'all'
                  ? 'bg-foreground text-background shadow-sm'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              全部 <span className="ml-1 tabular-nums">{projectionLoaded ? projection.sessions.length : '—'}</span>
            </button>
            {SECTIONS.map((section) => {
              const count = projectionLoaded ? projection.counts[section.state] : null
              return (
                <button
                  key={section.state}
                  type="button"
                  onClick={() => setScope(section.state)}
                  className={cn(
                    'flex-none rounded-md px-2.5 py-1.5 text-xs font-medium transition-all',
                    scope === section.state
                      ? 'bg-foreground text-background shadow-sm'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  {section.shortTitle}{' '}
                  <span className={cn(
                    'ml-1 tabular-nums',
                    scope !== section.state && section.state === 'attention_required' && count !== null && count > 0 && 'text-amber-600 dark:text-amber-400',
                  )}>
                    {count ?? '—'}
                  </span>
                </button>
              )
            })}
          </div>
          <div className="relative min-w-[220px] basis-[280px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目、会话、阶段或自动任务" className="h-9 bg-background/75 pl-9 text-xs" />
          </div>
          <Select value={workspaceId} onValueChange={setWorkspaceId}>
            <SelectTrigger aria-label="筛选项目" className="h-9 w-[168px] bg-background/75 text-xs"><SelectValue placeholder="全部项目" /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部项目</SelectItem>{workspaces.map((workspace) => <SelectItem key={workspace.id} value={workspace.id}>{workspace.name}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={source} onValueChange={setSource}>
            <SelectTrigger aria-label="筛选来源" className="h-9 w-[142px] bg-background/75 text-xs"><SelectValue placeholder="全部来源" /></SelectTrigger>
            <SelectContent><SelectItem value="all">全部来源</SelectItem><SelectItem value="manual">手动</SelectItem><SelectItem value="automation">自动任务</SelectItem></SelectContent>
          </Select>
        </div>
      </header>

      {refreshError ? (
        <WorkActivityRefreshFailure
          reason={refreshError}
          retrying={refreshing}
          onRetry={requestRefresh}
        />
      ) : null}

      <main className="relative z-10 min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="py-24 text-center text-sm text-muted-foreground">
            <RefreshCw className="mx-auto size-6 animate-spin text-muted-foreground/40" />
            <p className="mt-3">正在读取工作动态…</p>
          </div>
        ) : refreshError && !projectionLoaded ? (
          <div className="py-24 text-center">
            <AlertCircle className="mx-auto size-9 text-destructive/45" />
            <p className="mt-3 text-sm font-medium">暂时无法读取工作动态</p>
            <p className="mt-1 text-xs text-muted-foreground">查看上方原因后重试；当前没有把失败结果当作空列表。</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-24 text-center">
            <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-muted/45 ring-1 ring-inset ring-border/40">
              <ListChecks className="size-6 text-muted-foreground/40" />
            </div>
            <p className="mt-3.5 text-sm font-medium">当前筛选条件下没有工作动态</p>
            <p className="mt-1 text-xs text-muted-foreground">尝试切换状态、项目或清除搜索词。</p>
          </div>
        ) : (
          <div className="grid min-h-full lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_400px]">
            <div className="min-w-0 px-5 py-4 sm:px-7">
              <div className="space-y-6">
                {SECTIONS.map((section) => {
                  const sessions = filtered.filter((session) => session.state === section.state)
                  const tone = STATE_TONES[section.state]
                  return (
                    <section key={section.state} aria-labelledby={`work-activity-${section.state}`}>
                      <div className="mb-2 flex items-end justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <h2 id={`work-activity-${section.state}`} className="text-sm font-semibold tracking-tight">{section.title}</h2>
                            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold tabular-nums', tone.count)}>{sessions.length}</span>
                          </div>
                          <p className="mt-0.5 text-[11px] text-muted-foreground">{section.description}</p>
                        </div>
                        {section.state === 'recently_completed' && sessions.length > 0 ? <Button size="sm" variant="ghost" onClick={() => void removeAll()} className="h-7 text-xs">全部移出</Button> : null}
                      </div>

                      <div className="overflow-x-auto rounded-xl border border-border/50 bg-background/60 shadow-sm">
                        <div className="min-w-[880px]">
                          {/* 列头 */}
                          <div className={cn(`${TABLE_GRID} border-b border-border/45 bg-muted/25 px-3 py-2`, 'gap-x-3')}>
                            {TABLE_COLUMNS.map((column) => (
                              <span key={column.label} className={cn('text-[10px] font-semibold uppercase tracking-wider text-muted-foreground', column.align)}>{column.label}</span>
                            ))}
                          </div>
                          {sessions.length > 0 ? (
                            <div className="divide-y divide-border/40">
                              {sessions.map((session) => (
                                <WorkActivityItem
                                  key={session.id}
                                  session={session}
                                  now={now}
                                  selected={selectedSession?.id === session.id}
                                  onSelect={select}
                                  onOpen={open}
                                  onAcknowledge={(target) => void acknowledge(target)}
                                />
                              ))}
                            </div>
                          ) : (
                            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
                              <ListChecks className="size-4 text-muted-foreground/40" />
                              {section.emptyLabel}
                            </div>
                          )}
                        </div>
                      </div>
                    </section>
                  )
                })}
              </div>
            </div>
            <WorkActivityInspector
              session={selectedSession}
              now={now}
              onOpen={open}
              onRemove={(session) => void remove(session)}
              onRequestStop={setStopTarget}
            />
          </div>
        )}
      </main>

      <AlertDialog open={stopTarget !== null} onOpenChange={(openDialog) => { if (!openDialog && !stopping) setStopTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>停止「{stopTarget?.title}」？</AlertDialogTitle>
            <AlertDialogDescription>{stopTarget ? describeWorkActivityStopImpact(stopTarget) : ''}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stopping}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={stopping} onClick={(event) => { event.preventDefault(); void stop() }} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{stopping ? '停止中…' : '确认停止'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useAtomValue } from 'jotai'
import { Activity, AlertCircle, ArrowRight, CheckCircle2 } from 'lucide-react'
import type { WorkActivityState, WorkSessionView } from '@domi/shared'
import {
  workActivityLoadingAtom,
  workActivityProjectionAtom,
  workActivityRefreshErrorAtom,
} from '@/atoms/work-activity-atoms'
import { useSessionMiniMapPopoverPosition } from '@/components/session-preview/SessionMiniMapPopover'
import { cn } from '@/lib/utils'

const MAX_PREVIEW_SESSIONS = 5
const PANEL_HEIGHT = 322

const STATE_META: Record<WorkActivityState, {
  label: string
  dot: string
  icon: typeof Activity
}> = {
  attention_required: { label: '需要处理', dot: 'bg-amber-500', icon: AlertCircle },
  working: { label: '正在工作', dot: 'bg-blue-500', icon: Activity },
  recently_completed: { label: '最近完成', dot: 'bg-emerald-500', icon: CheckCircle2 },
}

interface WorkActivityHoverPreviewProps {
  anchorRef: React.MutableRefObject<HTMLElement | null>
  open: boolean
  isLeaving: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
  onOpenAll: () => void
  onOpenSession: (sessionId: string, title: string) => void
}

export function WorkActivityHoverPreview(props: WorkActivityHoverPreviewProps): React.ReactElement | null {
  if (!props.open) return null
  return <WorkActivityHoverPreviewPortal {...props} />
}

function WorkActivityHoverPreviewPortal({
  anchorRef,
  open,
  isLeaving,
  onMouseEnter,
  onMouseLeave,
  onOpenAll,
  onOpenSession,
}: WorkActivityHoverPreviewProps): React.ReactElement | null {
  const position = useSessionMiniMapPopoverPosition(anchorRef, open, PANEL_HEIGHT)
  if (!open || !position) return null

  return createPortal(
    <div
      className="fixed z-[9999] w-[318px] titlebar-no-drag transition-[top,height] duration-150 ease-out pointer-events-auto"
      style={{ top: position.top, left: position.left, height: position.height }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className={cn(
        'session-minimap-popover flex h-full flex-col overflow-hidden rounded-xl bg-popover shadow-xl ring-1 ring-black/[0.05] dark:ring-white/[0.08]',
        isLeaving ? 'session-minimap-popover-exit' : 'session-minimap-popover-enter',
      )}>
        <WorkActivityHoverPreviewContent onOpenAll={onOpenAll} onOpenSession={onOpenSession} />
      </div>
    </div>,
    document.body,
  )
}

export function WorkActivityHoverPreviewContent({
  onOpenAll,
  onOpenSession,
}: Pick<WorkActivityHoverPreviewProps, 'onOpenAll' | 'onOpenSession'>): React.ReactElement {
  const projection = useAtomValue(workActivityProjectionAtom)
  const loading = useAtomValue(workActivityLoadingAtom)
  const refreshError = useAtomValue(workActivityRefreshErrorAtom)
  const sessions = projection.sessions.slice(0, MAX_PREVIEW_SESSIONS)
  const loaded = projection.generatedAt > 0

  return (
    <>
      <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/35 bg-muted/35 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Activity className="size-4 flex-none text-primary" />
          <span className="truncate text-xs font-semibold text-popover-foreground/85">工作动态</span>
        </div>
        <span className="flex-none text-[10px] tabular-nums text-muted-foreground">
          {loaded ? `${sessions.length} / ${projection.sessions.length}` : '读取中'}
        </span>
      </div>

      <div className="min-h-0 flex-1 bg-popover p-1.5">
        {loading && !loaded ? (
          <div className="flex h-full items-center justify-center rounded-lg bg-muted/25 text-xs text-muted-foreground">正在汇总跨项目工作…</div>
        ) : refreshError && !loaded ? (
          <div className="flex h-full items-center justify-center rounded-lg bg-muted/25 px-5 text-center text-xs leading-5 text-muted-foreground">工作动态暂时不可用，打开完整页面可查看原因并重试。</div>
        ) : sessions.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-lg bg-muted/25 text-xs text-muted-foreground">暂无工作动态</div>
        ) : (
          <div className="h-full space-y-0.5 overflow-y-auto scrollbar-thin session-minimap-content-enter">
            {sessions.map((session) => (
              <PreviewSessionRow key={session.id} session={session} onOpen={onOpenSession} />
            ))}
          </div>
        )}
      </div>

      <div className="flex-none border-t border-border/35 bg-muted/20 p-1.5">
        <button
          type="button"
          onClick={onOpenAll}
          className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-primary transition-colors hover:bg-primary/[0.08]"
        >
          查看全部工作动态<ArrowRight className="size-3.5" />
        </button>
      </div>
    </>
  )
}

function PreviewSessionRow({
  session,
  onOpen,
}: {
  session: WorkSessionView
  onOpen: (sessionId: string, title: string) => void
}): React.ReactElement {
  const meta = STATE_META[session.state]
  return (
    <button
      type="button"
      onClick={() => onOpen(session.rootSessionId, session.title)}
      aria-label={`打开工作会话：${session.title}，${meta.label}`}
      className="group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-muted/45"
    >
      <span className={cn('mt-1.5 size-2 flex-none rounded-full', meta.dot)} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs font-medium text-popover-foreground/90">{session.title}</span>
          {session.unread ? <span className="size-1.5 flex-none rounded-full bg-primary" aria-label="未读" /> : null}
        </span>
        <span className="mt-0.5 block truncate text-[10px] leading-4 text-muted-foreground">
          {session.workspaceName} · {session.phaseSummary}
        </span>
      </span>
      <span className="mt-0.5 flex-none rounded-md bg-muted/45 px-1.5 py-0.5 text-[9px] text-muted-foreground">{meta.label}</span>
    </button>
  )
}

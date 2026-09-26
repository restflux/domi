import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CalendarClock, ChevronDown, ChevronRight, FolderClosed, PanelLeftClose, Plus, Search, Settings2, SquarePen } from 'lucide-react'
import { toast } from 'sonner'
import {
  agentChannelIdAtom, agentModelIdAtom, agentSessionsAtom, agentWorkspacesAtom,
  currentAgentSessionIdAtom, currentAgentWorkspaceIdAtom,
} from '@/atoms/agent-atoms.ts'
import { activeViewAtom } from '@/atoms/active-view.ts'
import { commandPaletteOpenAtom } from '@/atoms/command-palette.ts'
import { draftSessionIdsAtom } from '@/atoms/draft-session-atoms.ts'
import { settingsOpenAtom } from '@/atoms/settings-tab.ts'
import { sidebarCollapsedAtom } from '@/atoms/tab-atoms.ts'
import { useOpenSession } from '@/hooks/useOpenSession.ts'
import { Button } from '@/components/ui/button.tsx'
import { cn } from '@/lib/utils.ts'
import { WorkspaceSidebarCollapsedRail } from './zcode/WorkspaceSidebarCollapsedRail.tsx'
import { WorkspacePurposeSection } from './zcode/WorkspacePurposeSection.tsx'
import { selectWorkspaceTaskGroupsV2 } from './zcode/workspaceSidebarModel.ts'

interface WorkbenchSidebarV2Props {
  width: number
  noTransition?: boolean
  previewExpanded?: boolean
}

const INITIAL_SECTION_ORDER = ['projects', 'recent'] as const
const CONTENT_LIMIT = 24

/**
 * ZCode WorkspaceSidebar 的独立 v2 结构（顶端新任务/搜索、purpose section、
 * workspace→task 列表、底部操作和单入口 rail），不再渲染 Domi LeftSidebar。
 * 原版依赖 @zcode/services 的任务模型仅在数据边界映射到 Domi session 身份。
 */
export function WorkbenchSidebarV2({ width }: WorkbenchSidebarV2Props): React.ReactElement {
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const currentWorkspaceId = useAtomValue(currentAgentWorkspaceIdAtom)
  const activeSessionId = useAtomValue(currentAgentSessionIdAtom)
  const channelId = useAtomValue(agentChannelIdAtom)
  const modelId = useAtomValue(agentModelIdAtom)
  const setCurrentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setDraftIds = useSetAtom(draftSessionIdsAtom)
  const setActiveView = useSetAtom(activeViewAtom)
  const setCommandPaletteOpen = useSetAtom(commandPaletteOpenAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const openSession = useOpenSession()
  const [expandedWorkspaces, setExpandedWorkspaces] = React.useState<Set<string>>(new Set())
  const [sectionsOpen, setSectionsOpen] = React.useState({ projects: true, recent: true })
  const [sectionOrder, setSectionOrder] = React.useState<string[]>([...INITIAL_SECTION_ORDER])
  const [visibleLimit, setVisibleLimit] = React.useState(CONTENT_LIMIT)
  const [creating, setCreating] = React.useState(false)

  // 按 ZCode workspace/task 层级做有界投影；终端输出和消息 token 不会进入该列表。
  const groups = React.useMemo(() => selectWorkspaceTaskGroupsV2(workspaces, sessions, visibleLimit), [workspaces, sessions, visibleLimit])
  const recent = React.useMemo(() => sessions.filter((item) => !item.archived && !item.sideChatParentSessionId)
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8), [sessions])

  const createTask = async (workspaceId?: string): Promise<void> => {
    const targetId = workspaceId ?? currentWorkspaceId ?? workspaces[0]?.id
    if (!targetId || creating) {
      if (!targetId) toast.error('请先创建项目')
      return
    }
    setCreating(true)
    try {
      const meta = await window.electronAPI.createAgentSession(undefined, channelId ?? undefined, targetId, modelId ?? undefined)
      setAgentSessions((current) => [meta, ...current])
      setDraftIds((current) => new Set(current).add(meta.id))
      openSession('agent', meta.id, meta.title)
      setActiveView('conversations')
    } catch (error) {
      toast.error('无法新建任务', { description: error instanceof Error ? error.message : '请稍后重试' })
    } finally {
      setCreating(false)
    }
  }

  const selectWorkspace = (workspaceId: string): void => {
    setExpandedWorkspaces((current) => {
      const next = new Set(current)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      return next
    })
    setCurrentWorkspaceId(workspaceId)
    void window.electronAPI.updateSettings({ agentWorkspaceId: workspaceId }).catch(() => toast.error('无法保存当前项目'))
  }

  const onSectionDragEnd = ({ active, over }: DragEndEvent): void => {
    if (!over || active.id === over.id) return
    setSectionOrder((current) => {
      const from = current.indexOf(String(active.id))
      const to = current.indexOf(String(over.id))
      return from < 0 || to < 0 ? current : arrayMove(current, from, to)
    })
  }

  if (collapsed) return <WorkspaceSidebarCollapsedRail onToggleSidebar={() => setCollapsed(false)} />

  const projects = (
    <div className="px-1 pb-2" role="list" aria-label="项目与任务">
      {groups.map(({ workspace, sessions: workspaceSessions, hiddenCount }) => {
        const expanded = expandedWorkspaces.has(workspace.id) || currentWorkspaceId === workspace.id
        return (
          <div key={workspace.id} className="mb-1" role="listitem">
            <div className={cn('group flex h-8 items-center rounded-lg hover:bg-accent/70', currentWorkspaceId === workspace.id && 'bg-accent/55')}>
              <button type="button" className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg pl-2.5 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-expanded={expanded} onClick={() => selectWorkspace(workspace.id)}>
                <FolderClosed className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                {expanded ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
              </button>
              <button type="button" aria-label={`在${workspace.name}中新建任务`} title={`在${workspace.name}中新建任务`} className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100" onClick={() => void createTask(workspace.id)}><Plus className="size-3.5" /></button>
            </div>
            {expanded && <div className="ml-4 border-l border-border/60 pl-2" role="list" aria-label={`${workspace.name}的任务`}>
              {workspaceSessions.map((session) => <button key={session.id} type="button" role="listitem" aria-current={activeSessionId === session.id ? 'page' : undefined} className={cn('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-accent/65 hover:text-foreground', activeSessionId === session.id && 'bg-accent text-foreground')} onClick={() => openSession('agent', session.id, session.title)}><SquarePen className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">{session.title}</span></button>)}
              {hiddenCount > 0 && <button type="button" className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => setVisibleLimit((limit) => limit + CONTENT_LIMIT)}>再显示 {Math.min(hiddenCount, CONTENT_LIMIT)} 项</button>}
            </div>}
          </div>
        )
      })}
    </div>
  )
  const recentTasks = <div className="px-1 pb-2" role="list" aria-label="最近任务">{recent.map((session) => <button key={session.id} type="button" role="listitem" className="flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-xs text-muted-foreground hover:bg-accent/65 hover:text-foreground" onClick={() => openSession('agent', session.id, session.title)}><SquarePen className="size-3.5 shrink-0" /><span className="truncate">{session.title}</span></button>)}</div>

  return (
    <aside className="zcode-v2-sidebar relative flex h-full shrink-0 flex-col overflow-hidden border-r border-border/60 bg-background" style={{ width }} data-workbench-v2-sidebar>
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-3 titlebar-drag">
        <span className="select-none text-sm font-semibold tracking-tight">工作区</span>
        <Button type="button" variant="ghost" size="icon" className="size-7 titlebar-no-drag" aria-label="收起工作区侧栏" onClick={() => setCollapsed(true)}><PanelLeftClose className="size-4" /></Button>
      </div>
      <div className="space-y-1 px-2 py-3">
        <Button type="button" disabled={creating} className="h-9 w-full justify-start gap-2 rounded-lg text-sm" onClick={() => void createTask()}><Plus className="size-4" />新建任务</Button>
        <Button type="button" variant="ghost" className="h-9 w-full justify-start gap-2 rounded-lg text-sm" onClick={() => setCommandPaletteOpen(true)}><Search className="size-4" />搜索<span className="ml-auto text-xs opacity-60">⌘ K</span></Button>
        <Button type="button" variant="ghost" className="h-9 w-full justify-start gap-2 rounded-lg text-sm" onClick={() => setActiveView('planning')}><CalendarClock className="size-4" />自动任务</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <DndContext collisionDetection={closestCenter} onDragEnd={onSectionDragEnd}>
          <SortableContext items={sectionOrder} strategy={verticalListSortingStrategy}>
            {sectionOrder.map((id) => id === 'projects'
              ? <WorkspacePurposeSection key="projects" title="项目" open={sectionsOpen.projects} onOpenChange={(open) => setSectionsOpen((current) => ({ ...current, projects: open }))} action={<button type="button" aria-label="新建项目任务" className="flex size-6 items-center justify-center rounded-md hover:bg-accent" onClick={() => void createTask()}><Plus className="size-3.5" /></button>} testId="zcode-v2-projects" sortableId="projects" dragHandleLabel="拖动项目分组">{projects}</WorkspacePurposeSection>
              : <WorkspacePurposeSection key="recent" title="最近任务" open={sectionsOpen.recent} onOpenChange={(open) => setSectionsOpen((current) => ({ ...current, recent: open }))} action={null} testId="zcode-v2-recent" sortableId="recent" dragHandleLabel="拖动最近任务分组">{recentTasks}</WorkspacePurposeSection>)}
          </SortableContext>
        </DndContext>
      </div>
      <div className="shrink-0 border-t border-border/60 p-2"><Button type="button" variant="ghost" className="h-9 w-full justify-start gap-2 text-sm" onClick={() => setSettingsOpen(true)}><Settings2 className="size-4" />设置</Button></div>
    </aside>
  )
}

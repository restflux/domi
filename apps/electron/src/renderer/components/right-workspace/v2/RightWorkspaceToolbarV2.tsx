import * as React from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, horizontalListSortingStrategy } from '@dnd-kit/sortable'
import { Blinds, FolderClosed, GitCompareArrows, Globe2, Maximize2, Minimize2, NotebookPen, PanelRightClose, Plus, SquareTerminal } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import type { RightWorkspaceTabId, RightWorkspaceTool } from '@/lib/right-workspace-model.ts'
import { SidePaneTabTrigger } from './zcode/SidePaneTabTrigger.tsx'

export interface RightWorkspaceToolbarTab {
  id: RightWorkspaceTabId
  tool: RightWorkspaceTool
  label: string
  closeable: boolean
}

interface RightWorkspaceToolbarProps {
  tabs: RightWorkspaceToolbarTab[]
  activeTabId: RightWorkspaceTabId
  scratchVisible: boolean
  hasUnseenChanges: boolean
  expandAvailable: boolean
  expanded: boolean
  onTabChange: (tabId: RightWorkspaceTabId) => void
  onCloseTab: (tabId: RightWorkspaceTabId) => void
  onAddBrowser: () => void
  onOpenTerminal: () => void
  onOpenSessionFiles?: () => void
  onOpenFiles?: () => void
  onOpenChanges?: () => void
  onShowScratch: () => void
  onToggleExpand: () => void
  onCloseWorkspace: () => void
}

export function getHorizontalTabWheelDelta(deltaX: number, deltaY: number): number {
  return Math.abs(deltaY) > Math.abs(deltaX) ? deltaY : deltaX
}

/** ZCode AnimatedSidePanePanel 的可排序等宽 tab 带；Domi 只提供 tab 身份与宿主操作。 */
export function RightWorkspaceToolbarV2({ tabs, activeTabId, scratchVisible, hasUnseenChanges, expandAvailable, expanded, onTabChange, onCloseTab, onAddBrowser, onOpenTerminal, onOpenSessionFiles, onOpenFiles, onOpenChanges, onShowScratch, onToggleExpand, onCloseWorkspace }: RightWorkspaceToolbarProps): React.ReactElement {
  const { t } = useTranslation('workspace', { i18n })
  const [order, setOrder] = React.useState<string[]>([])
  const [menuOpen, setMenuOpen] = React.useState(false)
  const viewport = React.useRef<HTMLDivElement>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const ordered = React.useMemo(() => {
    const positions = new Map(order.map((id, index) => [id, index]))
    return [...tabs].sort((a, b) => (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  }, [order, tabs])
  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (!over || active.id === over.id) return
    const currentOrder: string[] = ordered.map((tab) => tab.id)
    const from = currentOrder.indexOf(String(active.id))
    const to = currentOrder.indexOf(String(over.id))
    if (from >= 0 && to >= 0) setOrder(arrayMove(currentOrder, from, to))
  }
  React.useEffect(() => {
    const target = Array.from(viewport.current?.querySelectorAll('[data-side-pane-tab-id]') ?? [])
      .find((element) => element.getAttribute('data-side-pane-tab-id') === activeTabId)
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTabId])
  const closable = tabs.filter((tab) => tab.closeable)
  const closeAll = (): void => { for (const tab of closable) onCloseTab(tab.id) }
  const onWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    const element = viewport.current
    if (!element || element.scrollWidth <= element.clientWidth) return
    const delta = getHorizontalTabWheelDelta(event.deltaX, event.deltaY)
    if (delta) { event.preventDefault(); element.scrollLeft += delta }
  }
  return (
    <nav className="zcode-v2-side-pane titlebar-no-drag flex h-12 shrink-0 items-center border-b border-border/50 bg-background p-0" aria-label={t('tabList')}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <div ref={viewport} onWheel={onWheel} className="flex h-12 min-w-0 flex-1 items-center gap-1 overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label={t('toolsTabList')}>
          <SortableContext items={ordered.map((tab) => tab.id)} strategy={horizontalListSortingStrategy}>
            {ordered.map((tab) => <SidePaneTabTrigger key={tab.id} tab={tab} active={tab.id === activeTabId} unseen={hasUnseenChanges} onActivate={() => onTabChange(tab.id)} onClose={() => onCloseTab(tab.id)} onCloseOthers={() => { for (const other of closable) if (other.id !== tab.id) onCloseTab(other.id) }} onCloseAll={closeAll} />)}
          </SortableContext>
        </div>
      </DndContext>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild><button type="button" aria-label={t('addTool')} title={t('addTool')} aria-expanded={menuOpen} className="mr-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><Plus className="size-4" /></button></DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="min-w-44" aria-label={t('addToolMenu')}>
          <DropdownMenuItem onSelect={onOpenSessionFiles} disabled={!onOpenSessionFiles} className="gap-2"><Blinds className="size-4" />{t('sessionFiles')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenFiles} disabled={!onOpenFiles} className="gap-2"><FolderClosed className="size-4" />{t('files')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenChanges} disabled={!onOpenChanges} className="gap-2"><GitCompareArrows className="size-4" />改动</DropdownMenuItem>
          <DropdownMenuItem onSelect={onAddBrowser} className="gap-2"><Globe2 className="size-4" />{t('newBrowser')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenTerminal} className="gap-2"><SquareTerminal className="size-4" />{t('openTerminal')}</DropdownMenuItem>
          <DropdownMenuItem onSelect={onShowScratch} className="gap-2"><NotebookPen className="size-4" />{scratchVisible ? t('openDraft') : t('showDraft')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {expandAvailable && <Tooltip><TooltipTrigger asChild><button type="button" aria-label={expanded ? t('restoreSplit') : t('expandMain')} aria-pressed={expanded} onClick={onToggleExpand} className="mr-2 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}</button></TooltipTrigger><TooltipContent side="bottom">{expanded ? t('restoreSplit') : t('expandMain')}</TooltipContent></Tooltip>}
      <Tooltip><TooltipTrigger asChild><button type="button" aria-label={t('closeWorkspace')} onClick={onCloseWorkspace} className="mr-1 flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"><PanelRightClose className="size-4" /></button></TooltipTrigger><TooltipContent side="bottom">{t('closeWorkspace')}</TooltipContent></Tooltip>
    </nav>
  )
}

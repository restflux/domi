import * as React from 'react'
import {
  Eye,
  Files,
  GitCompareArrows,
  Globe2,
  Maximize2,
  MessagesSquare,
  Minimize2,
  NotebookPen,
  Plus,
  SquareTerminal,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { shouldPinRightWorkspaceMenu, type RightWorkspaceTabId, type RightWorkspaceTool } from '@/lib/right-workspace-model'

const useClientLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

const TOOL_ICONS: Record<RightWorkspaceTool, LucideIcon> = {
  files: Files,
  changes: GitCompareArrows,
  browser: Globe2,
  terminal: SquareTerminal,
  scratch: NotebookPen,
  preview: Eye,
  'side-chat': MessagesSquare,
}

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
  onShowScratch: () => void
  onToggleExpand: () => void
}

function TabButton({
  tab,
  active,
  hasUnseenChanges,
  onTabChange,
  onCloseTab,
}: {
  tab: RightWorkspaceToolbarTab
  active: boolean
  hasUnseenChanges: boolean
  onTabChange: (tabId: RightWorkspaceTabId) => void
  onCloseTab: (tabId: RightWorkspaceTabId) => void
}): React.ReactElement {
  const Icon = TOOL_ICONS[tab.tool]
  return (
    <div
      className={cn(
        'group relative flex h-8 shrink-0 items-center rounded-lg text-muted-foreground',
        active ? 'max-w-40 bg-background text-foreground shadow-sm' : 'max-w-32 hover:bg-accent/70 hover:text-foreground',
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={tab.label}
            aria-pressed={active}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              'flex h-8 min-w-8 items-center gap-1.5 rounded-lg pl-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              tab.closeable ? 'pr-7' : 'pr-2',
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{tab.label}</span>
            {tab.tool === 'changes' && hasUnseenChanges && (
              <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" aria-label="有未查看的改动" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tab.label}</TooltipContent>
      </Tooltip>
      {tab.closeable && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`关闭${tab.label}`}
              className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-70 hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(event) => {
                event.stopPropagation()
                onCloseTab(tab.id)
              }}
            >
              <X className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">关闭{tab.label}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

/** 顶部是实例级标签栏：菜单只添加标签，关闭操作只出现在标签自身。 */
export function RightWorkspaceToolbar({
  tabs,
  activeTabId,
  scratchVisible,
  hasUnseenChanges,
  expandAvailable,
  expanded,
  onTabChange,
  onCloseTab,
  onAddBrowser,
  onShowScratch,
  onToggleExpand,
}: RightWorkspaceToolbarProps): React.ReactElement {
  const toolsAreaRef = React.useRef<HTMLDivElement>(null)
  const toolsRef = React.useRef<HTMLDivElement>(null)
  const [menuPinned, setMenuPinned] = React.useState(false)
  const [menuOpen, setMenuOpen] = React.useState(false)

  useClientLayoutEffect(() => {
    const toolsArea = toolsAreaRef.current
    const tools = toolsRef.current
    if (!toolsArea || !tools) return
    const updatePlacement = (): void => setMenuPinned(shouldPinRightWorkspaceMenu(toolsArea.clientWidth, tools.scrollWidth))
    updatePlacement()
    const observer = new ResizeObserver(updatePlacement)
    observer.observe(toolsArea)
    observer.observe(tools)
    return () => observer.disconnect()
  }, [tabs])

  return (
    <nav className="titlebar-no-drag flex h-10 shrink-0 items-center gap-1 border-b border-border/50 bg-muted/20 px-1.5" aria-label="工作区标签">
      <div ref={toolsAreaRef} className="flex min-w-0 flex-1 items-center gap-1">
        <div ref={toolsRef} className={cn('flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden', menuPinned && 'flex-1')}>
          {tabs.map((tab) => (
            <TabButton
              key={tab.id}
              tab={tab}
              active={activeTabId === tab.id}
              hasUnseenChanges={hasUnseenChanges}
              onTabChange={onTabChange}
              onCloseTab={onCloseTab}
            />
          ))}
        </div>

        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="添加工具"
              title="添加工具"
              data-placement={menuPinned ? 'pinned' : 'inline'}
              aria-expanded={menuOpen}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="min-w-44" aria-label="添加工具菜单" onEscapeKeyDown={() => setMenuOpen(false)}>
            <DropdownMenuItem onSelect={() => { setMenuOpen(false); onAddBrowser() }} className="gap-2">
              <Globe2 className="size-4" />
              <span>新建浏览器</span>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { setMenuOpen(false); onShowScratch() }} className="gap-2">
              <NotebookPen className="size-4" />
              <span>{scratchVisible ? '打开草稿' : '显示草稿'}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {expandAvailable && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" aria-label={expanded ? '恢复分栏' : '展开到主区域'} aria-pressed={expanded} onClick={onToggleExpand} className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{expanded ? '恢复分栏' : '展开到主区域'}</TooltipContent>
        </Tooltip>
      )}
    </nav>
  )
}

import * as React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Eye, Files, GitCompareArrows, Globe2, MessagesSquare, NotebookPen, SquareTerminal, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { cn } from '@/lib/utils.ts'
import type { RightWorkspaceToolbarTab } from '../RightWorkspaceToolbarV2.tsx'

const ICONS: Record<RightWorkspaceToolbarTab['tool'], LucideIcon> = {
  files: Files, changes: GitCompareArrows, browser: Globe2, terminal: SquareTerminal,
  scratch: NotebookPen, preview: Eye, 'side-chat': MessagesSquare,
}

interface SidePaneTabTriggerProps {
  tab: RightWorkspaceToolbarTab
  active: boolean
  unseen: boolean
  onActivate: () => void
  onClose: () => void
  onCloseOthers: () => void
  onCloseAll: () => void
}

/** 改编自 ZCode SidePaneTabTrigger：固定 tab 宽度、水平排序、单击/中键/菜单关闭语义。 */
export function SidePaneTabTrigger({ tab, active, unseen, onActivate, onClose, onCloseOthers, onCloseAll }: SidePaneTabTriggerProps): React.ReactElement {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id })
  const suppressedClick = React.useRef(false)
  if (isDragging) suppressedClick.current = true
  const Icon = ICONS[tab.tool]
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform ? { ...transform, scaleX: 1, scaleY: 1 } : null),
    transition, zIndex: isDragging ? 10 : undefined, opacity: isDragging ? 0.85 : 1,
  }
  return (
    <ContextMenu>
      <Tooltip>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <div ref={setNodeRef} style={style} {...attributes} {...listeners} data-side-pane-tab-id={tab.id} data-active={active || undefined}
              className={cn('group relative inline-flex h-7 min-w-[60px] max-w-[156px] flex-[1_1_156px] cursor-default items-center gap-1 overflow-hidden rounded-lg border border-transparent px-1.5 pr-7 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring', active && 'bg-accent/80 text-foreground', isDragging && 'cursor-grabbing shadow-md')}
              onClick={(event) => {
                if (suppressedClick.current) { suppressedClick.current = false; event.preventDefault(); return }
                if (event.button !== 0) return
                onActivate()
              }}
              onAuxClick={(event) => {
                if (event.button !== 1 || !tab.closeable) return
                event.preventDefault(); event.stopPropagation(); onClose()
              }}
              role="tab" aria-label={tab.label} aria-selected={active} tabIndex={active ? 0 : -1}>
              <Icon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{tab.label}</span>
              {tab.tool === 'changes' && unseen && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label="有未查看的改动" />}
              {tab.closeable && <button type="button" aria-label={`关闭${tab.label}`} className={cn('absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md hover:bg-background/80', !active && 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100')} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onClose() }}><X className="size-3" /></button>}
            </div>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent side="bottom">{tab.label}</TooltipContent>
      </Tooltip>
      {tab.closeable && <ContextMenuContent className="w-44">
        <ContextMenuItem onSelect={onClose}>关闭当前标签</ContextMenuItem>
        <ContextMenuItem onSelect={onCloseOthers}>关闭其他标签</ContextMenuItem>
        <ContextMenuItem onSelect={onCloseAll}>关闭所有标签</ContextMenuItem>
      </ContextMenuContent>}
    </ContextMenu>
  )
}

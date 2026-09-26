import { PanelLeftOpen } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'

/**
 * 移植自 ZCode packages/ui/src/WorkspaceSidebar/WorkspaceSidebarCollapsedRail.tsx
 * (29628c9)，替换商标资源与国际化适配 Domi；保留 ZCode 的单入口极窄 rail。
 */
export function WorkspaceSidebarCollapsedRail({ onToggleSidebar }: { onToggleSidebar: () => void }): React.ReactElement {
  return (
    <aside className="flex h-full w-12 flex-col overflow-hidden border-r border-border bg-background">
      <div className="flex h-12 shrink-0 items-center justify-center border-b border-border/60 bg-background px-1.5 titlebar-drag">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="group relative overflow-hidden rounded-lg titlebar-no-drag" onClick={onToggleSidebar} aria-label="展开工作区侧栏">
              <span className="text-sm font-bold transition-opacity group-hover:opacity-0" aria-hidden="true">D</span>
              <PanelLeftOpen className="absolute size-4 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">展开侧栏</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  )
}

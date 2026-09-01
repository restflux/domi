import * as React from 'react'
import { Activity } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { inputToolbarButtonClass } from '@/components/ai-elements/input-toolbar-styles'

export interface AgentStatusShortcutProps {
  running: boolean
  onOpen: () => void
}

/** 输入工具栏中的只读会话状态入口；与 `/status` 复用同一个 Dialog。 */
export function AgentStatusShortcut({ running, onOpen }: AgentStatusShortcutProps): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(inputToolbarButtonClass, running && 'text-primary')}
          onClick={onOpen}
          aria-label="会话状态与耗时"
          title="会话状态与耗时"
          data-agent-status-shortcut="true"
        >
          <Activity className="size-[17px]" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top"><p>会话状态与耗时</p></TooltipContent>
    </Tooltip>
  )
}

import * as React from 'react'
import { Activity } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { SessionIndicatorStatus } from '@/atoms/agent-atoms'
import { inputToolbarButtonClass } from '@/components/ai-elements/input-toolbar-styles'

export interface AgentStatusShortcutProps {
  running: boolean
  status?: SessionIndicatorStatus
  onOpen: (trigger: HTMLButtonElement) => void
}

/** 输入工具栏中的只读会话状态入口；与 `/status` 复用同一个 Dialog。 */
export function AgentStatusShortcut({ running, status = 'idle', onOpen }: AgentStatusShortcutProps): React.ReactElement {
  const currentStatus = status === 'idle' && running ? 'running' : status
  const blocked = currentStatus === 'blocked'
  const label = blocked ? '会话状态：需要处理' : currentStatus === 'running' ? '会话状态：运行中' : currentStatus === 'completed' ? '会话状态：已完成' : '会话状态与耗时'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(inputToolbarButtonClass, 'relative', blocked ? 'text-amber-600 dark:text-amber-400' : currentStatus === 'running' && 'text-primary')}
          onClick={(event) => onOpen(event.currentTarget)}
          aria-label={label}
          title={label}
          data-agent-status-shortcut="true"
        >
          <Activity className="size-[17px]" />
          {blocked && <span aria-hidden="true" className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-amber-500" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top"><p>会话状态与耗时</p></TooltipContent>
    </Tooltip>
  )
}

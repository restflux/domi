import * as React from 'react'
import { ListTodo, Loader2, Terminal } from 'lucide-react'
import type { BackgroundTask } from '@/atoms/agent-atoms'

interface SessionBackgroundTasksSectionProps {
  tasks: readonly BackgroundTask[]
}

/** 仅展示当前会话仍在运行的后台任务；终端服务另由顶部终端入口管理。 */
export function SessionBackgroundTasksSection({ tasks }: SessionBackgroundTasksSectionProps): React.ReactElement {
  return (
    <section aria-label="后台任务" className="shrink-0 border-b border-border/25 pb-2">
      <div className="flex h-9 items-center justify-between px-5 pt-1 text-[12px] font-medium text-popover-foreground/80">
        <span>后台任务</span>
        {tasks.length > 0 && <span className="tabular-nums text-muted-foreground">{tasks.length} 个运行中</span>}
      </div>
      {tasks.length === 0 ? (
        <p className="px-5 pb-1 text-[12px] text-muted-foreground/55">暂无运行中的后台任务</p>
      ) : (
        <ul>
          {tasks.map((task) => {
            const Icon = task.type === 'shell' ? Terminal : ListTodo
            return (
              <li key={task.toolUseId} className="flex min-w-0 items-center gap-2 px-5 py-1 text-[12px] text-muted-foreground/80">
                <Loader2 aria-label="运行中" className="size-3.5 shrink-0 animate-spin text-primary" />
                <Icon aria-hidden="true" className="size-3.5 shrink-0" />
                <span className="min-w-0 truncate" title={task.intent || task.id}>
                  {task.intent || `${task.type === 'shell' ? 'Shell' : 'Agent'} 任务 ${task.id}`}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

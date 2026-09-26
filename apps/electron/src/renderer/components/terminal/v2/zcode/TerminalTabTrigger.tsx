import type * as React from 'react'
import type { TerminalStatus } from '@domi/shared'
import { X } from 'lucide-react'
import { TabsTrigger } from '@/components/ui/tabs.tsx'
import { Button } from '@/components/ui/button.tsx'
import { cn } from '@/lib/utils.ts'

interface TerminalTabTriggerProps {
  id: string
  title: string
  closeLabel: string
  active: boolean
  status: TerminalStatus
  onClose: (id: string) => void
}

/** ZCode terminal/TerminalTabTrigger 源码中的紧凑 tab 与关闭交互，替换数据类型为 Domi owner terminal。 */
export function TerminalTabTrigger({ id, title, closeLabel, active, status, onClose }: TerminalTabTriggerProps): React.ReactElement {
  return <TabsTrigger value={id} aria-label={`切换到${title}`} className={cn('group !h-7 max-w-[160px] min-w-16 flex-[0_1_160px] gap-1 !rounded-lg !border-transparent !bg-transparent px-1.5 pr-1 text-xs font-medium !shadow-none hover:!bg-accent/40 focus-visible:ring-2 data-[state=active]:!bg-accent/80 data-[state=active]:!text-foreground', !active && 'text-muted-foreground')}>
    <span className={cn('size-1.5 shrink-0 rounded-full', status === 'running' ? 'bg-emerald-500' : status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground/50')} aria-hidden="true" />
    <span data-terminal-tab-content="" className="flex min-w-0 flex-1 overflow-hidden whitespace-nowrap [mask-image:linear-gradient(to_right,black_calc(100%-0.5rem),transparent)]"><span className="truncate">{title}</span></span>
    <Button type="button" variant="ghost" size="icon" aria-label={closeLabel} className={cn('size-5 shrink-0 rounded-md', !active && 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100')} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onClose(id) }}><X className="size-3" /></Button>
  </TabsTrigger>
}

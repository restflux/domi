import { useAtomValue, useSetAtom } from 'jotai'
import { Code2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ReadonlyCodemodeUnavailableReason } from '@domi/shared'
import { readonlyCodemodeStateAtomFamily, updateReadonlyCodemodeAtom } from '@/atoms/readonly-codemode-atoms.ts'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface ReadonlyCodemodeButtonProps {
  enabled: boolean
  pending: boolean
  running: boolean
  unavailableReason?: ReadonlyCodemodeUnavailableReason
  onToggle(enabled: boolean): void
}

export function ReadonlyCodemodeButton({ enabled, pending, running, unavailableReason, onToggle }: ReadonlyCodemodeButtonProps) {
  const paused = enabled && unavailableReason === 'minimal-preset'
  const description = unavailableReason === 'minimal-preset'
    ? '极简预设不提供只读工具；切回标准预设后可用。'
    : '批量读取、搜索和汇总；每次工具调用仍遵循现有权限。'
  const label = `只读 Codemode：${paused ? '已暂停' : enabled ? '已开启' : '已关闭'}`
  return <Tooltip>
    <TooltipTrigger asChild>
      <span className="inline-flex">
        <Button type="button" variant="ghost" size="sm" aria-label={label} aria-pressed={enabled}
          title={`${description}${running ? ' 当前运行不变，修改在下次运行生效。' : ''}`}
          disabled={pending || (!enabled && unavailableReason !== undefined)}
          onClick={() => onToggle(!enabled)}
          className={cn('h-8 gap-1.5 rounded-md px-2 text-xs', enabled && !paused && 'bg-primary/10 text-primary hover:bg-primary/15')}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Code2 className="size-3.5" />}
          只读 Codemode<span className="text-[10px] opacity-70">{paused ? '暂停' : enabled ? '开' : '关'}</span>
        </Button>
      </span>
    </TooltipTrigger>
    <TooltipContent side="top"><p>{description}</p>{running && <p>当前运行不变，修改在下次运行生效。</p>}</TooltipContent>
  </Tooltip>
}

export function ReadonlyCodemodeToggle({ sessionId, running }: { sessionId: string; running: boolean }) {
  const state = useAtomValue(readonlyCodemodeStateAtomFamily(sessionId))
  const update = useSetAtom(updateReadonlyCodemodeAtom)
  if (state.unavailableReason === 'not-main-session') return null
  return <ReadonlyCodemodeButton {...state} running={running} onToggle={enabled => {
    void update({ sessionId, enabled }).catch(error => {
      toast.error('只读 Codemode 设置保存失败', { description: error instanceof Error ? error.message : String(error) })
    })
  }} />
}

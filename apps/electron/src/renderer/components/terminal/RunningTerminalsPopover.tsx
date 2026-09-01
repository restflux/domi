/**
 * RunningTerminalsPopover — 右上角长期服务浮层
 *
 * 这里只展示由 TerminalRun 托管、仍在运行的长期进程，以及从其输出中识别出的
 * localhost 服务入口。普通 Bash 工具和 Agent 自身运行状态不属于服务状态。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ExternalLink, PanelBottom, Square, Terminal } from 'lucide-react'
import { toast } from 'sonner'
import {
  terminalServiceUrlsMapAtom,
  terminalStateMapAtom,
} from '@/atoms/terminal-atoms.ts'
import { applyBrowserStateChange, browserStateMapAtom } from '@/atoms/browser-atoms.ts'
import {
  activateSessionRightWorkspaceTab,
  rightWorkspaceOpenAtom,
  rightWorkspaceSessionStateMapAtom,
} from '@/atoms/right-workspace-atoms.ts'
import { browserTabId } from '@/lib/right-workspace-model.ts'
import { Button } from '@/components/ui/button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { cn } from '@/lib/utils.ts'
import { formatElapsed, selectRunningAgentTerminals } from './running-terminals-model.ts'

export interface RunningTerminalsPopoverProps {
  ownerSessionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenTerminalPanel?: () => void
  icon: React.ReactNode
  tooltipLabel: string
  active?: boolean
  /** 是否有运行中服务（显示绿点角标）。 */
  hasRunningDot?: boolean
}

export function RunningTerminalsPopover({
  ownerSessionId,
  open,
  onOpenChange,
  onOpenTerminalPanel,
  icon,
  tooltipLabel,
  active = false,
  hasRunningDot,
}: RunningTerminalsPopoverProps): React.ReactElement | null {
  const terminalStates = useAtomValue(terminalStateMapAtom)
  const serviceUrls = useAtomValue(terminalServiceUrlsMapAtom)
  const setBrowserStates = useSetAtom(browserStateMapAtom)
  const setWorkspaceStates = useSetAtom(rightWorkspaceSessionStateMapAtom)
  const setWorkspaceOpen = useSetAtom(rightWorkspaceOpenAtom)
  const [now, setNow] = React.useState(() => Date.now())

  const terminals = React.useMemo(
    () => selectRunningAgentTerminals([...terminalStates.values()], ownerSessionId),
    [ownerSessionId, terminalStates],
  )

  React.useEffect(() => {
    if (!open || terminals.length === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [open, terminals.length])

  const stop = React.useCallback(async (terminalId: string) => {
    try {
      await window.electronAPI.terminal.interrupt({ ownerSessionId, terminalId })
    } catch {
      // 状态事件会同步最终结果；终端面板仍可继续处理失败场景。
    }
  }, [ownerSessionId])

  const openService = React.useCallback(async (url: string): Promise<void> => {
    try {
      const state = await window.electronAPI.browser.open({ ownerSessionId, url })
      setBrowserStates((current) => applyBrowserStateChange(current, state))
      setWorkspaceStates((current) => activateSessionRightWorkspaceTab(current, ownerSessionId, browserTabId(state.browserSessionId)))
      setWorkspaceOpen(true)
      onOpenChange(false)
    } catch (error) {
      toast.error('无法打开服务地址', {
        description: error instanceof Error ? error.message : '浏览器操作失败',
      })
    }
  }, [onOpenChange, ownerSessionId, setBrowserStates, setWorkspaceOpen, setWorkspaceStates])

  if (!ownerSessionId) return null

  const trigger = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        'relative h-7 w-7',
        active && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary',
      )}
      aria-label={tooltipLabel}
      aria-expanded={open}
    >
      {icon}
      {hasRunningDot && (
        <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-emerald-500 ring-1 ring-background" />
      )}
    </Button>
  )

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        </TooltipTrigger>
        {!open && (
          <TooltipContent side="bottom">
            <p>{tooltipLabel}</p>
          </TooltipContent>
        )}
      </Tooltip>

      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        className="z-[100] w-[340px] overflow-hidden border-border/70 bg-popover p-0 text-popover-foreground shadow-lg titlebar-no-drag"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div className="flex items-center justify-between border-b border-border/60 bg-muted/30 px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <Terminal className="size-3.5 text-muted-foreground" />
            运行中的服务
          </div>
          <span className="text-[11px] text-emerald-600 dark:text-emerald-400">
            {terminals.length} 个运行中
          </span>
        </div>

        {terminals.length > 0 ? (
          <ul className="max-h-72 overflow-y-auto py-1">
            {terminals.map((terminal) => {
              const urls = serviceUrls.get(terminal.terminalId) ?? []
              return (
                <li
                  key={terminal.terminalId}
                  className="flex items-start gap-2.5 px-3 py-2 transition-colors hover:bg-muted/40"
                >
                  <span className="mt-1.5 size-1.5 flex-none rounded-full bg-emerald-500" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{terminal.title}</p>
                    {urls.length > 0 ? (
                      <div className="mt-0.5 space-y-0.5">
                        {urls.slice(0, 3).map((url) => (
                          <button
                            key={url}
                            type="button"
                            className="flex max-w-full items-center gap-1 text-left text-[11px] text-primary hover:underline"
                            title={url}
                            onClick={() => void openService(url)}
                          >
                            <span className="truncate">{url}</span>
                            <ExternalLink className="size-2.5 flex-none" />
                          </button>
                        ))}
                        {urls.length > 3 && (
                          <p className="text-[10px] text-muted-foreground/80">另有 {urls.length - 3} 个地址</p>
                        )}
                      </div>
                    ) : (
                      <p className="mt-0.5 text-[10px] text-muted-foreground/80">等待服务输出本地地址</p>
                    )}
                    <p className="mt-0.5 text-[10px] text-muted-foreground/80">
                      已运行 {formatElapsed(terminal.startedAt, now)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 flex-none gap-1 px-1.5 text-[11px] text-foreground/70"
                    onClick={() => void stop(terminal.terminalId)}
                    aria-label={`停止 ${terminal.title}`}
                  >
                    <Square className="size-2.5" />
                    停止
                  </Button>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="px-3 py-3 text-center text-[11px] text-muted-foreground/80">
            暂无运行中的服务
          </p>
        )}

        {onOpenTerminalPanel && (
          <div className="border-t border-border/50 bg-muted/20">
            <button
              type="button"
              className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
              onClick={() => {
                onOpenChange(false)
                onOpenTerminalPanel()
              }}
            >
              <PanelBottom className="size-3" />
              打开终端面板
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

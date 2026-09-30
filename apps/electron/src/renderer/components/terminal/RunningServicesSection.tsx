/** 会话概览中的运行中服务列表。 */

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
import { browserTabId, terminalTabId } from '@/lib/right-workspace-model.ts'
import { Button } from '@/components/ui/button.tsx'
import { formatElapsed, selectRunningAgentTerminals } from './running-terminals-model.ts'

interface RunningServicesSectionProps {
  ownerSessionId: string
  onOpenTerminalPanel?: () => void
}

export function RunningServicesSection({
  ownerSessionId,
  onOpenTerminalPanel,
}: RunningServicesSectionProps): React.ReactElement {
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
    if (terminals.length === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [terminals.length])

  const stop = React.useCallback(async (terminalId: string): Promise<void> => {
    try {
      await window.electronAPI.terminal.interrupt({ ownerSessionId, terminalId })
    } catch {
      // 状态事件会同步最终结果；终端面板仍可继续处理失败场景。
    }
  }, [ownerSessionId])

  const openTerminal = React.useCallback((terminalId: string): void => {
    setWorkspaceStates((current) => activateSessionRightWorkspaceTab(current, ownerSessionId, terminalTabId(terminalId)))
    setWorkspaceOpen(true)
  }, [ownerSessionId, setWorkspaceOpen, setWorkspaceStates])

  const openService = React.useCallback(async (url: string): Promise<void> => {
    try {
      const state = await window.electronAPI.browser.open({ ownerSessionId, url })
      setBrowserStates((current) => applyBrowserStateChange(current, state))
      setWorkspaceStates((current) => activateSessionRightWorkspaceTab(current, ownerSessionId, browserTabId(state.browserSessionId)))
      setWorkspaceOpen(true)
    } catch (error) {
      toast.error('无法打开服务地址', {
        description: error instanceof Error ? error.message : '浏览器操作失败',
      })
    }
  }, [ownerSessionId, setBrowserStates, setWorkspaceOpen, setWorkspaceStates])

  return (
    <section className="border-t border-border/50 pt-1">
      <div className="flex h-9 items-center justify-between pl-5 pr-4 pt-1">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-popover-foreground/80">
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
              <li key={terminal.terminalId} className="flex items-start gap-2.5 px-5 py-2 transition-colors hover:bg-muted/40">
                <span className="mt-1.5 size-1.5 flex-none rounded-full bg-emerald-500" />
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    className="block max-w-full truncate text-left text-xs font-medium hover:text-primary"
                    onClick={() => openTerminal(terminal.terminalId)}
                  >
                    {terminal.title}
                  </button>
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
        <p className="px-5 py-3 text-[11px] text-muted-foreground/80">暂无运行中的服务</p>
      )}

      {onOpenTerminalPanel && (
        <div className="border-t border-border/50 bg-muted/20">
          <button
            type="button"
            className="flex w-full items-center gap-1.5 px-5 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            onClick={onOpenTerminalPanel}
          >
            <PanelBottom className="size-3" />
            打开手动终端
          </button>
        </div>
      )}
    </section>
  )
}

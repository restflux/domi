import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ChevronDown, ChevronUp, Plus, Square, SquareTerminal, X } from 'lucide-react'
import type { TerminalProfile, TerminalSessionView } from '@domi/shared'
import { Button } from '@/components/ui/button.tsx'
import {
  terminalActiveIdMapAtom,
  terminalDockOpenMapAtom,
  terminalStateMapAtom,
} from '@/atoms/terminal-atoms.ts'
import { countRunningTerminals, selectDockTerminals, terminalStatusLabel } from './terminal-dock-model.ts'
import { TerminalPane } from './TerminalPane.tsx'
import { cn } from '@/lib/utils.ts'

const MIN_HEIGHT = 150
const MAX_HEIGHT = 560

export function TerminalDock({ ownerSessionId }: { ownerSessionId: string }): React.ReactElement | null {
  const terminalStates = useAtomValue(terminalStateMapAtom)
  const terminals = React.useMemo(
    () => selectDockTerminals(terminalStates.values(), ownerSessionId),
    [ownerSessionId, terminalStates],
  )
  const setStates = useSetAtom(terminalStateMapAtom)
  const [openMap, setOpenMap] = useAtom(terminalDockOpenMapAtom)
  const [activeMap, setActiveMap] = useAtom(terminalActiveIdMapAtom)
  const [profile, setProfile] = React.useState<TerminalProfile>('default')
  const [height, setHeight] = React.useState(270)
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const open = openMap.get(ownerSessionId) ?? false
  const runningCount = countRunningTerminals(terminals)
  const activeId = activeMap.get(ownerSessionId)
  const active = terminals.find((terminal) => terminal.terminalId === activeId) ?? terminals[0]

  React.useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      void window.electronAPI.terminal.list({ ownerSessionId }).then((listed) => {
        if (cancelled) return
        setStates((current) => {
          const next = new Map(current)
          for (const [terminalId, terminal] of next) {
            if (terminal.ownerSessionId === ownerSessionId) next.delete(terminalId)
          }
          for (const terminal of listed) next.set(terminal.terminalId, terminal)
          return next
        })
        setActiveMap((current) => {
          const currentId = current.get(ownerSessionId)
          const manualTerminals = selectDockTerminals(listed, ownerSessionId)
          if (currentId && manualTerminals.some((terminal) => terminal.terminalId === currentId)) return current
          const next = new Map(current)
          if (manualTerminals[0]) next.set(ownerSessionId, manualTerminals[0].terminalId)
          else next.delete(ownerSessionId)
          return next
        })
      }).catch(() => {
        // Session 可能正在切换或被删除；全局 state event 会在可用时重新投影。
      })
    }
    refresh()
    const timer = setInterval(refresh, 5_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [ownerSessionId, setStates, setActiveMap])

  const createTerminal = React.useCallback(async () => {
    if (creating) return
    setCreating(true)
    setError(null)
    try {
      const terminal = await window.electronAPI.terminal.create({
        ownerSessionId,
        profile,
        presentation: 'dock',
        cols: 100,
        rows: 28,
      })
      setStates((current) => new Map(current).set(terminal.terminalId, terminal))
      setActiveMap((current) => new Map(current).set(ownerSessionId, terminal.terminalId))
      setOpenMap((current) => new Map(current).set(ownerSessionId, true))
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : '终端创建失败。')
    } finally {
      setCreating(false)
    }
  }, [creating, ownerSessionId, profile, setActiveMap, setOpenMap, setStates])

  const closeTerminal = React.useCallback(async (terminal: TerminalSessionView) => {
    await window.electronAPI.terminal.close({ ownerSessionId, terminalId: terminal.terminalId })
  }, [ownerSessionId])

  const startResize = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = height
    const move = (pointer: PointerEvent): void => {
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + startY - pointer.clientY)))
    }
    const up = (): void => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'row-resize'
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  }, [height])

  if (!open && terminals.length === 0) return null

  return (
    <section
      className="relative flex flex-shrink-0 flex-col border-t border-border/60 bg-background/95 titlebar-no-drag"
      style={{ height: open ? height : 34 }}
      aria-label="内置终端"
    >
      {open && (
        <div
          className="absolute -top-1 left-0 right-0 z-10 h-2 cursor-row-resize"
          onPointerDown={startResize}
        />
      )}
      <header className="flex h-[34px] flex-shrink-0 items-center gap-1 border-b border-border/50 px-2">
        <SquareTerminal className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">终端</span>
        {runningCount > 0 && <span className="text-[11px] text-emerald-600 dark:text-emerald-400">{runningCount} 个运行中</span>}
        <div className="ml-2 flex min-w-0 flex-1 items-end self-stretch overflow-x-auto">
          {open && terminals.map((terminal) => (
            <button
              key={terminal.terminalId}
              type="button"
              className={cn(
                'group flex h-full max-w-52 items-center gap-1.5 border-b-2 px-2 text-xs',
                active?.terminalId === terminal.terminalId
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setActiveMap((current) => new Map(current).set(ownerSessionId, terminal.terminalId))}
            >
              <span className={cn('size-1.5 rounded-full', terminal.status === 'running' ? 'bg-emerald-500' : terminal.status === 'failed' ? 'bg-destructive' : 'bg-muted-foreground/50')} />
              <span className="truncate">{terminal.title}</span>
              <span className="text-[10px] opacity-60">{terminalStatusLabel(terminal)}</span>
              <X
                className="size-3 opacity-0 group-hover:opacity-70 hover:!opacity-100"
                onClick={(event) => { event.stopPropagation(); void closeTerminal(terminal) }}
              />
            </button>
          ))}
        </div>
        {open && (
          <>
            <select
              value={profile}
              onChange={(event) => setProfile(event.target.value as TerminalProfile)}
              className="h-6 rounded-md bg-muted/50 px-1 text-[11px] text-muted-foreground outline-none"
              aria-label="新终端 Shell"
            >
              <option value="default">默认 Shell</option>
              {navigator.platform.toLowerCase().includes('win') ? (
                <>
                  <option value="pwsh">PowerShell 7</option>
                  <option value="powershell">Windows PowerShell</option>
                  <option value="cmd">Command Prompt</option>
                  <option value="git-bash">Git Bash</option>
                  <option value="wsl">WSL</option>
                </>
              ) : (
                <>
                  <option value="bash">Bash</option>
                  <option value="zsh">Zsh</option>
                </>
              )}
            </select>
            <Button type="button" variant="ghost" size="icon" className="h-6 w-6" disabled={creating} onClick={() => void createTerminal()} aria-label="新建终端">
              <Plus className="size-3.5" />
            </Button>
            {active?.status === 'running' && (
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={() => void window.electronAPI.terminal.interrupt({ ownerSessionId, terminalId: active.terminalId })} aria-label="中断当前终端">
                <Square className="size-3" />
              </Button>
            )}
          </>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setOpenMap((current) => new Map(current).set(ownerSessionId, !open))}
          aria-label={open ? '折叠终端' : '展开终端'}
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
        </Button>
      </header>
      {open && error && (
        <div className="flex-shrink-0 bg-destructive/10 px-3 py-1 text-[11px] text-destructive">{error}</div>
      )}
      {open && (
        <div className="min-h-0 flex-1 bg-[#111318]">
          {active ? (
            <TerminalPane terminal={active} />
          ) : (
            <button type="button" className="flex h-full w-full items-center justify-center text-xs text-muted-foreground hover:text-foreground" onClick={() => void createTerminal()}>
              <Plus className="mr-1.5 size-3.5" />新建终端
            </button>
          )}
        </div>
      )}
    </section>
  )
}

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ChevronDown, ChevronUp, Plus, Square, X } from 'lucide-react'
import type { TerminalProfile, TerminalSessionView } from '@domi/shared'
import { Button } from '@/components/ui/button.tsx'
import {
  terminalActiveIdMapAtom,
  terminalDockHeightMapAtom,
  terminalDockOpenMapAtom,
  terminalDockProfileMapAtom,
  terminalShellLabelMapAtom,
  terminalStateMapAtom,
} from '@/atoms/terminal-atoms.ts'
import { getDockTerminalCloseAction, getZCodeTerminalTabTitle, selectDockTerminals, buildZCodeDockTerminalInput } from '../terminal-dock-model.ts'

// 保留旧导出路径，终端 Dock 测试继续从这里导入创建请求构建器。
export { buildZCodeDockTerminalInput }
import { ZCodeTerminalSurface } from './zcode/ZCodeTerminalSurface.tsx'
import { TerminalTabTrigger } from './zcode/TerminalTabTrigger.tsx'
import { getDockPanelState, reduceTerminalPanelState } from './terminal-panel-state.ts'
import { Tabs, TabsList, TabsContent } from '@/components/ui/tabs.tsx'
import { cn } from '@/lib/utils.ts'

const MIN_HEIGHT = 150
const MAX_HEIGHT = 560

export function TerminalDockV2({ ownerSessionId }: { ownerSessionId: string }): React.ReactElement | null {
  const { t } = useTranslation('workspace', { i18n })
  const terminalStates = useAtomValue(terminalStateMapAtom)
  const shellLabels = useAtomValue(terminalShellLabelMapAtom)
  const terminals = React.useMemo(
    () => selectDockTerminals(terminalStates.values(), ownerSessionId),
    [ownerSessionId, terminalStates],
  )
  const setStates = useSetAtom(terminalStateMapAtom)
  const [openMap, setOpenMap] = useAtom(terminalDockOpenMapAtom)
  const [activeMap, setActiveMap] = useAtom(terminalActiveIdMapAtom)
  const [heightMap, setHeightMap] = useAtom(terminalDockHeightMapAtom)
  const [profileMap, setProfileMap] = useAtom(terminalDockProfileMapAtom)
  const profile = profileMap.get(ownerSessionId) ?? 'default'
  const height = heightMap.get(ownerSessionId) ?? 270
  const [creating, setCreating] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const open = openMap.get(ownerSessionId) ?? false
  const activeId = activeMap.get(ownerSessionId)
  const panelState = getDockPanelState({ open, activeTerminalId: activeId }, terminals, ownerSessionId)
  const active = terminals.find((terminal) => terminal.terminalId === panelState.activeTerminalId)
  const activeShellLabel = active ? shellLabels.get(active.terminalId)?.trim() : undefined

  React.useEffect(() => {
    if (panelState.activeTerminalId === activeId) return
    setActiveMap((current) => {
      const next = new Map(current)
      if (panelState.activeTerminalId) next.set(ownerSessionId, panelState.activeTerminalId)
      else next.delete(ownerSessionId)
      return next
    })
  }, [activeId, ownerSessionId, panelState.activeTerminalId, setActiveMap])

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
    // ZCode 的 panelState 只在挂载时同步服务端快照，后续由全局 terminal.onStateChanged
    // 投影驱动。避免每个 Dock 各自轮询，多个 Work Session 同时打开时会产生周期性 IPC 峰值。
    refresh()
    return () => {
      cancelled = true
    }
  }, [ownerSessionId, setStates, setActiveMap])

  const createTerminal = React.useCallback(async () => {
    if (creating) return
    setCreating(true)
    setError(null)
    try {
      const terminal = await window.electronAPI.terminal.create(buildZCodeDockTerminalInput(ownerSessionId, profile))
      setStates((current) => new Map(current).set(terminal.terminalId, terminal))
      const nextPanelState = reduceTerminalPanelState(
        { open: openMap.get(ownerSessionId) ?? false, activeTerminalId: activeMap.get(ownerSessionId) },
        { type: 'create', terminalId: terminal.terminalId },
      )
      setActiveMap((current) => new Map(current).set(ownerSessionId, nextPanelState.activeTerminalId!))
      setOpenMap((current) => new Map(current).set(ownerSessionId, nextPanelState.open))
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t('terminalCreateFailed'))
    } finally {
      setCreating(false)
    }
  }, [activeMap, creating, openMap, ownerSessionId, profile, setActiveMap, setOpenMap, setStates])

  const closeTerminal = React.useCallback(async (terminal: TerminalSessionView) => {
    const action = getDockTerminalCloseAction(terminals, terminal.terminalId)
    if (action === 'none') return
    if (action === 'close-panel') {
      // ZCode 关闭最后一个 tab 时只收起面板，保留 PTY/session 供再次打开时复用。
      setOpenMap((current) => new Map(current).set(ownerSessionId, false))
      return
    }
    const remaining = terminals.filter((item) => item.terminalId !== terminal.terminalId).map((item) => item.terminalId)
    const nextPanelState = reduceTerminalPanelState(
      { open, activeTerminalId: activeId },
      { type: 'close-session', terminalId: terminal.terminalId, previousIds: terminals.map((item) => item.terminalId), remainingIds: remaining },
    )
    await window.electronAPI.terminal.close({ ownerSessionId, terminalId: terminal.terminalId })
    setActiveMap((current) => {
      const next = new Map(current)
      if (nextPanelState.activeTerminalId) next.set(ownerSessionId, nextPanelState.activeTerminalId)
      else next.delete(ownerSessionId)
      return next
    })
  }, [activeId, open, ownerSessionId, setActiveMap, setOpenMap, terminals])

  const updateHeight = React.useCallback((nextHeight: number): void => {
    setHeightMap((current) => new Map(current).set(ownerSessionId, nextHeight))
  }, [ownerSessionId, setHeightMap])

  const updateProfile = React.useCallback((nextProfile: TerminalProfile): void => {
    setProfileMap((current) => new Map(current).set(ownerSessionId, nextProfile))
  }, [ownerSessionId, setProfileMap])

  const startResize = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = height
    const move = (pointer: PointerEvent): void => {
      updateHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + startY - pointer.clientY)))
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
  }, [height, updateHeight])

  if (!open && terminals.length === 0) return null

  // ZCode Terminal 的 TabsContent forceMount：收起或切 tab 不释放 xterm / PTY。
  // Domi 的 terminal state 与 owner/target IPC 仍是唯一资源事实源。
  return (
    <section className="relative flex shrink-0 flex-col overflow-hidden border-t border-border/60 bg-background p-2 pb-1 titlebar-no-drag" style={{ height: open ? height : 46 }} aria-label={t('terminalPanel')} data-zcode-terminal-dock="">
      {open && <div className="absolute -top-1 left-0 right-0 z-10 h-2 cursor-row-resize" onPointerDown={startResize} />}
      <Tabs value={active?.terminalId ?? ''} onValueChange={(terminalId) => {
          const nextPanelState = reduceTerminalPanelState({ open, activeTerminalId: activeId }, { type: 'select', terminalId })
          setActiveMap((current) => new Map(current).set(ownerSessionId, nextPanelState.activeTerminalId!))
        }} className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex h-8 shrink-0 items-center gap-2">
          <div className="shrink-0 truncate text-xs font-medium">{t('terminal')}</div>
          {open && activeShellLabel && <span className="shrink-0 text-[11px] text-muted-foreground">{activeShellLabel}</span>}
          <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <TabsList className="flex !h-7 w-max justify-start gap-1 rounded-none bg-transparent p-0">
              {terminals.map((terminal, index) => { const title = getZCodeTerminalTabTitle(terminal, index + 1); return <TerminalTabTrigger key={terminal.terminalId} id={terminal.terminalId} title={title} closeLabel={`${t('close')}${title}`} active={active?.terminalId === terminal.terminalId} status={terminal.status} onClose={(id) => { if (id === terminal.terminalId) void closeTerminal(terminal) }} /> })}
            </TabsList>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {open && <select value={profile} onChange={(event) => updateProfile(event.target.value as TerminalProfile)} aria-label={t('newTerminal') + ' Shell'} className="h-7 rounded-md bg-accent/50 px-1 text-[11px] text-muted-foreground">
              <option value="default">{t('defaultShell')}</option>
              {navigator.platform.toLowerCase().includes('win') ? <><option value="powershell">PowerShell</option><option value="cmd">Command Prompt</option><option value="git-bash">Git Bash</option><option value="wsl">WSL</option></> : <><option value="bash">Bash</option><option value="zsh">Zsh</option></>}
            </select>}
            {open && <Button type="button" variant="ghost" size="icon" className="size-7" disabled={creating} onClick={() => void createTerminal()} aria-label={t('newTerminal')}><Plus className="size-4" /></Button>}
            {open && active?.status === 'running' && <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => void window.electronAPI.terminal.interrupt({ ownerSessionId, terminalId: active.terminalId })} aria-label={t('interruptTerminal')}><Square className="size-3" /></Button>}
            {open && <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => {
              const nextPanelState = reduceTerminalPanelState({ open, activeTerminalId: activeId }, { type: 'close-panel' })
              setOpenMap((current) => new Map(current).set(ownerSessionId, nextPanelState.open))
            }} aria-label={`${t('close')}${t('terminal')}`} data-zcode-terminal-close="true"><X className="size-4" /></Button>}
            <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => {
              if (open) {
                const nextPanelState = reduceTerminalPanelState({ open, activeTerminalId: activeId }, { type: 'close-panel' })
                setOpenMap((current) => new Map(current).set(ownerSessionId, nextPanelState.open))
                return
              }
              // ZCode ensureWorkspaceTerminalState：面板重新可见但还没有终端时懒创建第一个终端。
              if (terminals.length === 0) {
                void createTerminal()
                return
              }
              const nextPanelState = reduceTerminalPanelState({ open, activeTerminalId: activeId }, { type: 'open' })
              setOpenMap((current) => new Map(current).set(ownerSessionId, nextPanelState.open))
            }} aria-label={open ? t('collapseTerminal') : t('expandTerminal')}>{open ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}</Button>
          </div>
        </div>
        {open && error && <div className="shrink-0 bg-destructive/10 px-3 py-1 text-xs text-destructive">{error}</div>}
        <div className={cn('min-h-0 flex-1 overflow-hidden rounded-lg bg-[var(--color-terminal-bg)]', !open && 'hidden')}>
          {terminals.length ? terminals.map((terminal) => <TabsContent key={terminal.terminalId} value={terminal.terminalId} forceMount className="!m-0 h-full min-h-0 flex-1 data-[state=inactive]:hidden"><ZCodeTerminalSurface terminal={terminal} visible={open && active?.terminalId === terminal.terminalId} /></TabsContent>) : <button type="button" className="flex h-full w-full items-center justify-center text-xs text-muted-foreground hover:text-foreground" onClick={() => void createTerminal()}><Plus className="mr-1 size-4" />{t('newTerminal')}</button>}
        </div>
      </Tabs>
    </section>
  )
}

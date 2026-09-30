import * as React from 'react'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import type { TerminalSessionView } from '@domi/shared'
import { applyBrowserStateChange, browserStateMapAtom } from '@/atoms/browser-atoms.ts'
import { activateSessionRightWorkspaceTab, rightWorkspaceOpenAtom, rightWorkspaceSessionStateMapAtom } from '@/atoms/right-workspace-atoms.ts'
import { browserTabId } from '@/lib/right-workspace-model.ts'
import { TerminalSession } from './ZCodeTerminalSession.tsx'
import { createZCodeTerminalPort } from './zcode-terminal-port.ts'
import '@xterm/xterm/css/xterm.css'

interface ZCodeTerminalSurfaceProps {
  terminal: TerminalSessionView
  visible: boolean
  resizing?: boolean
}

/** ZCode 原生 xterm 组件与 Domi 经 Main 核验的 PTY 之间的薄适配。 */
export function ZCodeTerminalSurface({ terminal, visible, resizing = false }: ZCodeTerminalSurfaceProps): React.ReactElement {
  const setBrowserStates = useSetAtom(browserStateMapAtom)
  const setWorkspaceStates = useSetAtom(rightWorkspaceSessionStateMapAtom)
  const setWorkspaceOpen = useSetAtom(rightWorkspaceOpenAtom)
  const services = React.useMemo(() => typeof window !== 'undefined'
    ? { terminalService: createZCodeTerminalPort(terminal, window.electronAPI.terminal) }
    : null, [terminal.ownerSessionId, terminal.terminalId])

  const onShellLabelChange = React.useCallback(() => {
    // 宿主标题由 TerminalSessionView 维护。保持函数引用稳定，避免状态更新时重启 PTY effect。
  }, [])

  const openLink = React.useCallback(async (url: string): Promise<void> => {
    try {
      // 终端 URL 仍由宿主按用户交互处理，不允许 xterm 直接触发 guest 导航。
      const state = await window.electronAPI.browser.open({ ownerSessionId: terminal.ownerSessionId, url, disposition: 'new-tab' })
      setBrowserStates((current) => applyBrowserStateChange(current, state))
      setWorkspaceStates((current) => activateSessionRightWorkspaceTab(current, terminal.ownerSessionId, browserTabId(state.browserSessionId)))
      setWorkspaceOpen(true)
    } catch (error) {
      toast.error('无法打开终端链接', { description: error instanceof Error ? error.message : '链接不可用' })
    }
  }, [terminal.ownerSessionId, setBrowserStates, setWorkspaceStates, setWorkspaceOpen])

  if (!services) return <div className="terminal-xterm-shell h-full w-full" />
  return <TerminalSession
    sessionId={terminal.terminalId}
    services={services}
    cwd={terminal.cwd}
    isVisible={visible}
    isPanelResizing={resizing}
    isWindowsDesktop={navigator.platform.toLowerCase().includes('win')}
    onShellLabelChange={onShellLabelChange}
    onOpenBrowserUrl={openLink}
    persistentKey={JSON.stringify([terminal.ownerSessionId, terminal.terminalId])}
    workspaceKey={terminal.ownerSessionId}
  />
}

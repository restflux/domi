import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { ManagedBrowserLinkProvider } from '@/components/ai-elements/message'
import { applyBrowserStateChange, browserStateMapAtom } from '@/atoms/browser-atoms'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import {
  activateSessionRightWorkspaceTab,
  rightWorkspaceOpenAtom,
  rightWorkspaceSessionStateMapAtom,
} from '@/atoms/right-workspace-atoms'
import { browserTabId } from '@/lib/right-workspace-model'

interface AgentBrowserLinkProviderProps {
  sessionId: string
  children: React.ReactNode
}

/** Work 消息链接复用当前会话的可见浏览器；浏览器 control 冲突由 Main fail closed。 */
export function AgentBrowserLinkProvider({ sessionId, children }: AgentBrowserLinkProviderProps): React.ReactElement {
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const setBrowserStates = useSetAtom(browserStateMapAtom)
  const setWorkspaceStates = useSetAtom(rightWorkspaceSessionStateMapAtom)
  const setWorkspaceOpen = useSetAtom(rightWorkspaceOpenAtom)

  const openLink = React.useCallback(async (url: string): Promise<void> => {
    try {
      const state = await window.electronAPI.browser.open({ ownerSessionId: sessionId, url })
      setBrowserStates((current) => applyBrowserStateChange(current, state))
      setWorkspaceStates((current) => activateSessionRightWorkspaceTab(current, sessionId, browserTabId(state.browserSessionId)))
      if (currentSessionId === sessionId) setWorkspaceOpen(true)
    } catch (error) {
      toast.error('无法在内置浏览器打开链接', {
        description: error instanceof Error ? error.message : '浏览器操作失败',
      })
    }
  }, [currentSessionId, sessionId, setBrowserStates, setWorkspaceOpen, setWorkspaceStates])

  return <ManagedBrowserLinkProvider onOpen={openLink}>{children}</ManagedBrowserLinkProvider>
}

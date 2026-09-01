import * as React from 'react'
import { useStore } from 'jotai'
import {
  applyBrowserStateChange,
  browserStateMapAtom,
  shouldAutoOpenBrowserPanel,
} from '@/atoms/browser-atoms'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import {
  activateSessionRightWorkspaceTab,
  rightWorkspaceOpenAtom,
  rightWorkspaceSessionStateMapAtom,
} from '@/atoms/right-workspace-atoms'
import { browserTabId } from '@/lib/right-workspace-model'

/**
 * Browser state 由主窗口全局接收，避免 BrowserPanel 未挂载时丢失 Agent 控制状态。
 * 页面与 Profile 生命周期继续由 Main 持有；这里把 Agent 控制投影到 Right Workspace。
 */
export function useGlobalBrowserListeners(): void {
  const store = useStore()

  React.useEffect(() => window.electronAPI.browser.onStateChanged((change) => {
    store.set(browserStateMapAtom, (current) => applyBrowserStateChange(current, change))

    if ('closed' in change) {
      store.set(rightWorkspaceSessionStateMapAtom, (current) => {
        if (current.get(change.ownerSessionId)?.activeTabId !== browserTabId(change.browserSessionId)) return current
        const fallback = [...store.get(browserStateMapAtom).values()]
          .filter((state) => state.ownerSessionId === change.ownerSessionId)
          .at(-1)
        return activateSessionRightWorkspaceTab(
          current,
          change.ownerSessionId,
          fallback ? browserTabId(fallback.browserSessionId) : 'files',
        )
      })
      return
    }

    if (!shouldAutoOpenBrowserPanel(change)) return
    store.set(rightWorkspaceSessionStateMapAtom, (current) => (
      activateSessionRightWorkspaceTab(current, change.ownerSessionId, browserTabId(change.browserSessionId))
    ))
    if (store.get(currentAgentSessionIdAtom) === change.ownerSessionId) {
      store.set(rightWorkspaceOpenAtom, true)
    }
  }), [store])
}

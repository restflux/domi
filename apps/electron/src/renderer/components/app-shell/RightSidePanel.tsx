/**
 * RightSidePanel — Work 会话的统一右侧工作区。
 *
 * 顶部按实例渲染真实标签；Browser 原生页面仍由 Main 持有，Renderer 只切换活动实例。
 * Agent Run 与右侧菜单创建的手动 Shell 按实例进入这里；顶部入口创建的 Shell 留在底部 Dock。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { appModeAtom } from '@/atoms/app-mode'
import {
  agentDiffPanelTabAtom,
  agentDiffUnseenChangesAtom,
  agentFileSourceFilterMapAtom,
  agentSessionPathMapAtom,
  currentAgentSessionIdAtom,
  type AgentFileSourceFilter,
  type AgentSidePanelTab,
} from '@/atoms/agent-atoms'
import { applyBrowserStateChange, browserStateMapAtom, getOwnerBrowserStates } from '@/atoms/browser-atoms'
import { agentSideChatMapAtom } from '@/atoms/chat-atoms'
import {
  activateSessionRightWorkspaceTab,
  resolveBrowserFocusEscape,
  resolveRightWorkspaceFocus,
  rightWorkspaceFocusAtom,
  rightWorkspaceSessionStateMapAtom,
  toggleRightWorkspaceFocus,
} from '@/atoms/right-workspace-atoms'
import { previewFileMapAtom } from '@/atoms/preview-atoms'
import { scratchPadSaveStateAtom } from '@/atoms/tab-atoms'
import { terminalStateMapAtom } from '@/atoms/terminal-atoms.ts'
import {
  browserSessionIdFromTab,
  browserTabId,
  resolveClosedTabFallback,
  terminalIdFromTab,
  terminalTabId,
  toolFromRightWorkspaceTab,
  type RightWorkspaceSessionState,
  type RightWorkspaceTabId,
  type RightWorkspaceTool,
} from '@/lib/right-workspace-model'
import { detectIsWindows } from '@/lib/platform'
import { createManualTerminal, type ManualTerminalCreationGuard } from '@/lib/manual-terminal-creation.ts'
import { SidePanel } from '@/components/agent/SidePanel'
import { BrowserPanel } from '@/components/browser/BrowserPanel'
import { TerminalPane } from '@/components/terminal/TerminalPane.tsx'
import { selectWorkspaceTerminals } from '@/components/terminal/terminal-dock-model.ts'
import { PreviewTabContent } from '@/components/diff/PreviewTabContent'
import { ScratchPadWorkspace } from '@/components/scratch-pad/ScratchPadView'
import { RightWorkspaceHeader } from '@/components/right-workspace/RightWorkspaceHeader'
import { RightWorkspaceToolbar, type RightWorkspaceToolbarTab } from '@/components/right-workspace/RightWorkspaceToolbar'
import { RightWorkspaceTitlebarDragRegion } from '@/components/right-workspace/RightWorkspaceTitlebarDragRegion'

function getPreviewTitle(filePath: string | undefined): string | undefined {
  return filePath?.split(/[\\/]/).filter(Boolean).pop()
}

function toLegacyTab(tool: RightWorkspaceTool): AgentSidePanelTab | null {
  if (tool === 'files' || tool === 'changes') return tool
  if (tool === 'side-chat') return 'chat'
  return null
}

function fromLegacyTab(tab: AgentSidePanelTab): RightWorkspaceTool {
  return tab === 'chat' ? 'side-chat' : tab
}

function resolveAvailableTabId(
  state: RightWorkspaceSessionState,
  tabs: RightWorkspaceToolbarTab[],
): RightWorkspaceTabId {
  const requested = state.activeTabId ?? state.activeTool
  if (tabs.some((tab) => tab.id === requested)) return requested
  if (state.previousTabId && tabs.some((tab) => tab.id === state.previousTabId)) return state.previousTabId
  return 'files'
}

export function RightSidePanel({ width }: { width?: number | string }): React.ReactElement | null {
  const appMode = useAtomValue(appModeAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  if (appMode !== 'agent' || !currentSessionId) return null
  return <ActiveRightSidePanel currentSessionId={currentSessionId} width={width} />
}

function ActiveRightSidePanel({
  currentSessionId,
  width,
}: {
  currentSessionId: string
  width?: number | string
}): React.ReactElement {
  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)
  const legacyTabMap = useAtomValue(agentDiffPanelTabAtom)
  const setLegacyTabMap = useSetAtom(agentDiffPanelTabAtom)
  const unseenChangesMap = useAtomValue(agentDiffUnseenChangesAtom)
  const setUnseenChangesMap = useSetAtom(agentDiffUnseenChangesAtom)
  const workspaceStateMap = useAtomValue(rightWorkspaceSessionStateMapAtom)
  const setWorkspaceStateMap = useSetAtom(rightWorkspaceSessionStateMapAtom)
  const previewFileMap = useAtomValue(previewFileMapAtom)
  const setPreviewFileMap = useSetAtom(previewFileMapAtom)
  const browserStateMap = useAtomValue(browserStateMapAtom)
  const setBrowserStateMap = useSetAtom(browserStateMapAtom)
  const sideChatMap = useAtomValue(agentSideChatMapAtom)
  const setSideChatMap = useSetAtom(agentSideChatMapAtom)
  const fileSourceFilterMap = useAtomValue(agentFileSourceFilterMapAtom)
  const setFileSourceFilterMap = useSetAtom(agentFileSourceFilterMapAtom)
  const scratchSaveState = useAtomValue(scratchPadSaveStateAtom)
  const terminalStates = useAtomValue(terminalStateMapAtom)
  const [workspaceFocus, setWorkspaceFocus] = useAtom(rightWorkspaceFocusAtom)
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const creatingTerminalRef = React.useRef<ManualTerminalCreationGuard>({ pending: false })

  const sessionPath = sessionPathMap.get(currentSessionId) ?? null
  const previewFile = previewFileMap.get(currentSessionId) ?? null
  const sideChatConversationId = sideChatMap.get(currentSessionId) ?? null
  const browserStates = getOwnerBrowserStates(browserStateMap, currentSessionId)
  const workspaceTerminals = React.useMemo(
    () => selectWorkspaceTerminals(terminalStates.values(), currentSessionId),
    [currentSessionId, terminalStates],
  )
  const legacyTool = fromLegacyTab(legacyTabMap.get(currentSessionId) ?? 'files')
  const storedState = workspaceStateMap.get(currentSessionId)
  const state: RightWorkspaceSessionState = storedState ?? {
    activeTool: legacyTool,
    activeTabId: legacyTool,
    scratchVisible: false,
  }

  const tabs: RightWorkspaceToolbarTab[] = [
    { id: 'files', tool: 'files', label: '文件', closeable: false },
    { id: 'changes', tool: 'changes', label: '改动', closeable: false },
    ...(state.scratchVisible ? [{ id: 'scratch' as const, tool: 'scratch' as const, label: '草稿', closeable: true }] : []),
    ...workspaceTerminals.map((terminal) => ({
      id: terminalTabId(terminal.terminalId),
      tool: 'terminal' as const,
      label: terminal.title,
      closeable: true,
    })),
    ...browserStates.map((browser, index) => ({
      id: browserTabId(browser.browserSessionId),
      tool: 'browser' as const,
      label: browser.page?.title?.trim() || `浏览器 ${index + 1}`,
      closeable: true,
    })),
    ...(previewFile ? [{ id: 'preview' as const, tool: 'preview' as const, label: getPreviewTitle(previewFile.filePath) ?? '预览', closeable: true }] : []),
    ...(sideChatConversationId ? [{ id: 'side-chat' as const, tool: 'side-chat' as const, label: '问答', closeable: true }] : []),
  ]
  const activeTabId = resolveAvailableTabId(state, tabs)
  const activeTool = toolFromRightWorkspaceTab(activeTabId)
  const activeBrowserSessionId = browserSessionIdFromTab(activeTabId)
  const activeTerminalId = terminalIdFromTab(activeTabId)
  const activeTerminal = activeTerminalId ? terminalStates.get(activeTerminalId) : undefined
  const activeTabExpanded = resolveRightWorkspaceFocus(workspaceFocus, currentSessionId, activeTabId)
  const fileSourceFilter = fileSourceFilterMap[currentSessionId] ?? 'session'

  React.useEffect(() => {
    if (workspaceFocus?.sessionId !== currentSessionId || (workspaceFocus.tabId ?? workspaceFocus.tool) === activeTabId) return
    setWorkspaceFocus(null)
  }, [activeTabId, currentSessionId, setWorkspaceFocus, workspaceFocus])

  React.useEffect(() => {
    if (workspaceFocus?.sessionId !== currentSessionId) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      setWorkspaceFocus(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [currentSessionId, setWorkspaceFocus, workspaceFocus])

  React.useEffect(() => window.electronAPI.browser.onFocusEscapeRequested((request) => {
    if (request.ownerSessionId !== currentSessionId) return
    setWorkspaceFocus((current) => resolveBrowserFocusEscape(current, request.ownerSessionId, request.browserSessionId))
  }), [currentSessionId, setWorkspaceFocus])

  const setActiveTab = (tabId: RightWorkspaceTabId): void => {
    const tool = toolFromRightWorkspaceTab(tabId)
    if (workspaceFocus?.sessionId === currentSessionId && (workspaceFocus.tabId ?? workspaceFocus.tool) !== tabId) setWorkspaceFocus(null)
    if (tool === 'changes') {
      setUnseenChangesMap((current) => {
        if (current.get(currentSessionId) === false) return current
        const next = new Map(current)
        next.set(currentSessionId, false)
        return next
      })
    }
    setWorkspaceStateMap((current) => activateSessionRightWorkspaceTab(current, currentSessionId, tabId))
    const legacyTab = toLegacyTab(tool) ?? 'files'
    setLegacyTabMap((current) => new Map(current).set(currentSessionId, legacyTab))
    const browserSessionId = browserSessionIdFromTab(tabId)
    if (browserSessionId) {
      void window.electronAPI.browser.activate({ ownerSessionId: currentSessionId, browserSessionId })
        .then((next) => setBrowserStateMap((current) => applyBrowserStateChange(current, next)))
        .catch((error: unknown) => console.error('[RightSidePanel] 激活浏览器失败:', error))
    }
  }

  const setActiveTool = (tool: RightWorkspaceTool): void => {
    if (tool === 'browser') {
      const browser = browserStates.at(-1)
      if (browser) setActiveTab(browserTabId(browser.browserSessionId))
      return
    }
    setActiveTab(tool)
  }

  const setFileSourceFilter = (filter: AgentFileSourceFilter): void => {
    setFileSourceFilterMap((current) => ({ ...current, [currentSessionId]: filter }))
  }

  const createWorkspaceTerminal = React.useCallback(async (): Promise<void> => {
    await createManualTerminal(creatingTerminalRef.current, {
      create: (input) => window.electronAPI.terminal.create(input),
      onError: (error) => {
        console.error('[RightSidePanel] 创建终端失败:', error)
        toast.error('创建终端失败')
      },
    }, {
      ownerSessionId: currentSessionId,
      presentation: 'workspace',
      cols: 80,
      rows: 28,
    })
  }, [currentSessionId])

  const addBrowser = (): void => {
    void window.electronAPI.browser.open({ ownerSessionId: currentSessionId, disposition: 'new-tab' })
      .then((next) => {
        setBrowserStateMap((current) => applyBrowserStateChange(current, next))
        setActiveTab(browserTabId(next.browserSessionId))
      })
      .catch((error: unknown) => {
        console.error('[RightSidePanel] 新建浏览器失败:', error)
        toast.error('新建浏览器失败')
      })
  }

  const showScratch = (): void => {
    setWorkspaceStateMap((current) => {
      const next = activateSessionRightWorkspaceTab(current, currentSessionId, 'scratch')
      const sessionState = next.get(currentSessionId)
      if (sessionState) next.set(currentSessionId, { ...sessionState, scratchVisible: true })
      return next
    })
  }

  const closeTab = (tabId: RightWorkspaceTabId): void => {
    if (workspaceFocus?.sessionId === currentSessionId && (workspaceFocus.tabId ?? workspaceFocus.tool) === tabId) setWorkspaceFocus(null)
    const fallbackTabId = resolveClosedTabFallback(tabs.map((tab) => tab.id), tabId, state.previousTabId)
    const terminalId = terminalIdFromTab(tabId)
    if (terminalId) {
      if (activeTabId === tabId) setActiveTab(fallbackTabId)
      void window.electronAPI.terminal.close({ ownerSessionId: currentSessionId, terminalId })
        .catch((error: unknown) => {
          console.error('[RightSidePanel] 关闭 Agent 终端失败:', error)
          toast.error('关闭 Agent 终端失败')
        })
      return
    }

    const browserSessionId = browserSessionIdFromTab(tabId)
    if (browserSessionId) {
      if (activeTabId === tabId) setActiveTab(fallbackTabId)
      void window.electronAPI.browser.close({ ownerSessionId: currentSessionId, browserSessionId })
        .catch((error: unknown) => {
          console.error('[RightSidePanel] 关闭浏览器失败:', error)
          toast.error('关闭浏览器失败')
        })
      return
    }

    if (tabId === 'scratch') {
      setWorkspaceStateMap((current) => {
        const next = new Map(current)
        const currentState = next.get(currentSessionId) ?? state
        next.set(currentSessionId, {
          ...currentState,
          scratchVisible: false,
          ...(activeTabId === 'scratch' ? {
            activeTool: toolFromRightWorkspaceTab(fallbackTabId),
            activeTabId: fallbackTabId,
          } : {}),
        })
        return next
      })
      return
    }
    if (tabId === 'preview') setPreviewFileMap((current) => { const next = new Map(current); next.delete(currentSessionId); return next })
    if (tabId === 'side-chat') setSideChatMap((current) => { const next = new Map(current); next.delete(currentSessionId); return next })
    if (activeTabId === tabId) setActiveTab(fallbackTabId)
  }

  const sidePanelTab: AgentSidePanelTab = activeTool === 'side-chat' ? 'chat' : activeTool === 'changes' ? 'changes' : 'files'

  return (
    <div className="relative flex h-full min-w-0 shrink-0 overflow-hidden bg-content-area titlebar-no-drag" style={width ? { width } : undefined}>
      <RightWorkspaceTitlebarDragRegion isWindows={isWindows} />
      <div className={isWindows ? 'flex h-full min-w-0 flex-1 flex-col pt-[34px]' : 'flex h-full min-w-0 flex-1 flex-col'}>
        <RightWorkspaceToolbar
          tabs={tabs}
          activeTabId={activeTabId}
          scratchVisible={state.scratchVisible ?? false}
          hasUnseenChanges={unseenChangesMap.get(currentSessionId) ?? false}
          expandAvailable
          expanded={activeTabExpanded}
          onTabChange={setActiveTab}
          onCloseTab={closeTab}
          onAddBrowser={addBrowser}
          onOpenTerminal={() => void createWorkspaceTerminal()}
          onShowScratch={showScratch}
          onToggleExpand={() => setWorkspaceFocus((current) => toggleRightWorkspaceFocus(current, currentSessionId, activeTabId))}
        />
        <RightWorkspaceHeader activeTool={activeTool} previewTitle={getPreviewTitle(previewFile?.filePath)} fileSourceFilter={fileSourceFilter} scratchSaveState={scratchSaveState} onFileSourceFilterChange={setFileSourceFilter} />
        <div className="min-h-0 flex-1 overflow-hidden titlebar-no-drag">
          {activeTool === 'browser' && activeBrowserSessionId ? (
            <BrowserPanel ownerSessionId={currentSessionId} browserSessionId={activeBrowserSessionId} />
          ) : activeTool === 'terminal' && activeTerminal ? (
            <TerminalPane terminal={activeTerminal} />
          ) : activeTool === 'preview' ? (
            <PreviewTabContent sessionId={currentSessionId} mode="workspace" />
          ) : activeTool === 'scratch' ? (
            <ScratchPadWorkspace />
          ) : (
            <SidePanel sessionId={currentSessionId} sessionPath={sessionPath} activeTab={sidePanelTab} onTabChange={(tab) => setActiveTool(fromLegacyTab(tab))} embedded hideTabBar />
          )}
        </div>
      </div>
    </div>
  )
}

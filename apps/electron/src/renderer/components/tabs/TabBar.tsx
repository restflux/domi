/**
 * TabBar — 顶部标签栏
 *
 * 显示所有打开的标签页，支持：
 * - 点击切换标签
 * - 中键关闭可关闭标签
 * - 拖拽重排序
 * - Chrome 风格等分宽度（溢出时可横向滚动）
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Keyboard, PanelRight, PanelRightClose, SquareTerminal } from 'lucide-react'
import {
  tabsAtom,
  activeTabIdAtom,
  tabIndicatorMapAtom,
} from '@/atoms/tab-atoms'
import type { TabItem } from '@/atoms/tab-atoms'
import type { SessionIndicatorStatus } from '@/atoms/agent-atoms'
import { currentConversationIdAtom } from '@/atoms/chat-atoms'
import {
  agentSessionsAtom,
  agentWorkspacesAtom,
  currentAgentSessionIdAtom,
  currentAgentWorkspaceIdAtom,
  unviewedCompletedSessionIdsAtom,
} from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TabBarItem } from './TabBarItem'
import { useCloseTab } from '@/hooks/useCloseTab'
import { detectIsWindows, WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'
import { registerShortcut } from '@/lib/shortcut-registry'
import { cn } from '@/lib/utils'
import { shortcutGuideOpenAtom } from '@/atoms/shortcut-guide'
import { rightWorkspaceOpenAtom } from '@/atoms/right-workspace-atoms'
import { terminalDockOpenMapAtom, terminalStateMapAtom } from '@/atoms/terminal-atoms.ts'
import { selectRunningAgentTerminals } from '@/components/terminal/running-terminals-model.ts'
import { RunningTerminalsPopover } from '@/components/terminal/RunningTerminalsPopover.tsx'
import { canCloseMainTab } from '@/lib/tab-close-policy.ts'

export function TabBar(): React.ReactElement {
  const tabs = useAtomValue(tabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom)
  const indicatorMap = useAtomValue(tabIndicatorMapAtom)

  // Tab 切换时同步 sidebar 状态
  const appMode = useAtomValue(appModeAtom)
  const setAppMode = useSetAtom(appModeAtom)
  const setCurrentConversationId = useSetAtom(currentConversationIdAtom)
  const setCurrentAgentSessionId = useSetAtom(currentAgentSessionIdAtom)
  const agentSessions = useAtomValue(agentSessionsAtom)
  const agentWorkspaces = useAtomValue(agentWorkspacesAtom)
  const setCurrentAgentWorkspaceId = useSetAtom(currentAgentWorkspaceIdAtom)
  const setUnviewedCompleted = useSetAtom(unviewedCompletedSessionIdsAtom)
  const setAutomationForm = useSetAtom(automationFormAtom)

  // 统一关闭逻辑：关闭当前会话入口，不停止后台 Agent。
  const { requestClose } = useCloseTab()

  const workspaceNameBySessionId = React.useMemo(() => {
    const workspaceNameMap = new Map(agentWorkspaces.map((workspace) => [workspace.id, workspace.name]))
    const sessionWorkspaceNameMap = new Map<string, string>()
    for (const session of agentSessions) {
      if (!session.workspaceId) continue
      const workspaceName = workspaceNameMap.get(session.workspaceId)
      if (workspaceName) sessionWorkspaceNameMap.set(session.id, workspaceName)
    }
    return sessionWorkspaceNameMap
  }, [agentSessions, agentWorkspaces])

  const automationSessionIds = React.useMemo(() => {
    const ids = new Set<string>()
    for (const s of agentSessions) {
      if (s.sourceAutomationId && !s.sourceDelegationId) ids.add(s.id)
    }
    return ids
  }, [agentSessions])

  const delegationSessionIds = React.useMemo(() => {
    const ids = new Set<string>()
    for (const s of agentSessions) {
      if (s.sourceDelegationId) ids.add(s.id)
    }
    return ids
  }, [agentSessions])

  // 拖拽状态
  const dragState = React.useRef<{
    dragging: boolean
    tabId: string
    startX: number
    startIndex: number
  } | null>(null)

  const handleActivate = React.useCallback((tabId: string) => {
    setActiveTabId(tabId)
    // 点击任意 tab 都关闭定时任务编辑表单（overlay 否则会盖在内容区上）
    setAutomationForm({ open: false, draft: null })

    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return

    if (tab.type === 'chat') {
      setAppMode('chat')
      setCurrentConversationId(tab.sessionId)
    } else if (tab.type === 'agent' || tab.type === 'preview') {
      setAppMode('agent')
      setCurrentAgentSessionId(tab.sessionId)

      // 用户打开查看后只清除未读角标；是否完成由用户通过对勾确认。
      setUnviewedCompleted((prev) => {
        if (!prev.has(tab.sessionId)) return prev
        const next = new Set(prev)
        next.delete(tab.sessionId)
        return next
      })

      const session = agentSessions.find((s) => s.id === tab.sessionId)
      if (session?.workspaceId) {
        setCurrentAgentWorkspaceId(session.workspaceId)
        window.electronAPI.updateSettings({
          agentWorkspaceId: session.workspaceId,
        }).catch(console.error)
      }
    } else if (tab.type === 'scratch' || tab.type === 'tutorial') {
      setCurrentConversationId(null)
      if (appMode !== 'agent') {
        setCurrentAgentSessionId(null)
      }
    }
  }, [setActiveTabId, setAutomationForm, tabs, agentSessions, appMode, setAppMode, setCurrentConversationId, setCurrentAgentSessionId, setCurrentAgentWorkspaceId, setUnviewedCompleted])

  const handleDragStart = React.useCallback((tabId: string, e: React.PointerEvent) => {
    if (e.button !== 0) return // 只处理左键
    const idx = tabs.findIndex((t) => t.id === tabId)
    if (idx === -1) return

    dragState.current = {
      dragging: false,
      tabId,
      startX: e.clientX,
      startIndex: idx,
    }

    const handleMove = (me: PointerEvent): void => {
      if (!dragState.current) return
      const dx = Math.abs(me.clientX - dragState.current.startX)
      if (dx > 5) dragState.current.dragging = true
    }

    const handleUp = (): void => {
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
      dragState.current = null
    }

    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
  }, [tabs])

  if (tabs.length === 0) return <div className="h-[34px] titlebar-drag-region" />

  return (
    <>
      <TabBarInner
        tabs={tabs}
        activeTabId={activeTabId}
        streamingMap={indicatorMap}
        workspaceNameBySessionId={workspaceNameBySessionId}
        automationSessionIds={automationSessionIds}
        delegationSessionIds={delegationSessionIds}
        onActivate={handleActivate}
        onClose={requestClose}
        onDragStart={handleDragStart}
      />
    </>
  )
}

/** 内部组件：管理全局 hover 状态，确保同一时刻只有一个预览面板 */
function TabBarInner({
  tabs,
  activeTabId,
  streamingMap,
  workspaceNameBySessionId,
  automationSessionIds,
  delegationSessionIds,
  onActivate,
  onClose,
  onDragStart,
}: {
  tabs: TabItem[]
  activeTabId: string | null
  streamingMap: Map<string, SessionIndicatorStatus>
  workspaceNameBySessionId: Map<string, string>
  automationSessionIds: Set<string>
  delegationSessionIds: Set<string>
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onDragStart: (tabId: string, e: React.PointerEvent) => void
}): React.ReactElement {
  const [hoveredTabId, setHoveredTabId] = React.useState<string | null>(null)
  const [isLeaving, setIsLeaving] = React.useState(false)
  const enterTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const leaveTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const fadeTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const isWindows = React.useMemo(() => detectIsWindows(), [])

  // Right Workspace 开关固定在中间主区域的右上角。
  const [isPanelOpen, setSidePanelOpen] = useAtom(rightWorkspaceOpenAtom)
  const setShortcutGuideOpen = useSetAtom(shortcutGuideOpenAtom)
  const activeTab = React.useMemo(() => tabs.find((t) => t.id === activeTabId), [tabs, activeTabId])
  const showPanelButton = activeTab?.type === 'agent'
  const activeAgentSessionId = activeTab?.type === 'agent' ? activeTab.sessionId : null
  const [terminalOpenMap, setTerminalOpenMap] = useAtom(terminalDockOpenMapAtom)
  const terminalStates = useAtomValue(terminalStateMapAtom)
  const isTerminalOpen = activeAgentSessionId
    ? terminalOpenMap.get(activeAgentSessionId) ?? false
    : false

  // 只有 TerminalRun 托管的长期进程代表可监控服务；Agent/Bash 运行状态不占用服务入口。
  const hasRunningServiceTerminal = React.useMemo(() => {
    if (!activeAgentSessionId) return false
    return selectRunningAgentTerminals([...terminalStates.values()], activeAgentSessionId).length > 0
  }, [activeAgentSessionId, terminalStates])

  const togglePanel = React.useCallback(() => {
    if (activeTab?.type !== 'agent') return
    setSidePanelOpen((v) => !v)
  }, [setSidePanelOpen, activeTab])

  const toggleTerminal = React.useCallback(() => {
    if (!activeAgentSessionId) return
    setTerminalOpenMap((current) => new Map(current).set(
      activeAgentSessionId,
      !(current.get(activeAgentSessionId) ?? false),
    ))
  }, [activeAgentSessionId, setTerminalOpenMap])

  // 右上角终端按钮展开“运行中服务”浮层（Radix Popover 受控，外点收起由 Radix 处理）
  const [runningPopoverOpen, setRunningPopoverOpen] = React.useState(false)

  // 切换标签/会话，或服务进程全部结束时收起浮层，避免残留
  React.useEffect(() => {
    setRunningPopoverOpen(false)
  }, [activeAgentSessionId, hasRunningServiceTerminal])

  const openShortcutGuide = React.useCallback(() => {
    setShortcutGuideOpen(true)
  }, [setShortcutGuideOpen])

  React.useEffect(() => {
    return registerShortcut('toggle-right-panel', togglePanel)
  }, [togglePanel])

  // 滚动容器 ref
  const scrollRef = React.useRef<HTMLDivElement>(null)

  // 顶部仅承载会话入口，普通拖拽只用于排序。

  // 鼠标滚轮横向滚动（使用原生事件监听器以支持 preventDefault）
  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      el.scrollLeft += e.deltaY || e.deltaX
    }

    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [])

  // 新增 tab 时自动滚动到最右
  const prevTabCount = React.useRef(tabs.length)
  React.useEffect(() => {
    if (tabs.length > prevTabCount.current && scrollRef.current) {
      scrollRef.current.scrollTo({ left: scrollRef.current.scrollWidth, behavior: 'smooth' })
    }
    prevTabCount.current = tabs.length
  }, [tabs.length])

  React.useEffect(() => {
    return () => {
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
      if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    }
  }, [])

  const handleTabHoverEnter = React.useCallback((tabId: string) => {
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
    setIsLeaving(false)

    // 如果已经有面板打开（从一个 Tab 滑到另一个），立即切换
    if (hoveredTabId) {
      setHoveredTabId(tabId)
    } else {
      // 首次 hover，延迟 300ms
      enterTimerRef.current = setTimeout(() => setHoveredTabId(tabId), 300)
    }
  }, [hoveredTabId])

  const handleTabHoverLeave = React.useCallback(() => {
    if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
    leaveTimerRef.current = setTimeout(() => {
      setIsLeaving(true)
      fadeTimerRef.current = setTimeout(() => {
        setHoveredTabId(null)
        setIsLeaving(false)
      }, 80)
    }, 200)
  }, [])

  // 面板的 hover 进入（阻止关闭）
  const handlePanelHoverEnter = React.useCallback(() => {
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current)
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
    setIsLeaving(false)
  }, [])

  return (
    <div className="chrome-tabbar main-tabbar flex items-end h-[34px] tabbar-bg relative">
      {/* 顶部 TabBar 的空白区域必须保持可拖拽，尤其是 macOS/Windows 自定义标题栏。
          注意：不要把 titlebar-no-drag 加到下面的整条 flex 容器上，否则标签右侧空白会再次失去拖拽能力。
          Windows 上背景拖拽层避开右上角 WindowControls 区域（126px），防止 hitmask 重叠。
          需要交互的单个 Tab 会在 TabBarItem 内部自己声明 titlebar-no-drag。 */}
      <div className={cn("absolute inset-0 titlebar-drag-region", isWindows && WINDOW_CONTROLS_INSET_RIGHT)} />

      <div
        ref={scrollRef}
        className={cn(
          "main-tabbar-track relative flex items-end flex-1 min-w-0 overflow-x-auto scrollbar-none",
          // 为固定在标签栏右侧的全局按钮预留空间；Windows 面板关闭时还需避开 WindowControls（~126px）。
          isWindows && (showPanelButton
            ? (isPanelOpen ? "pr-28" : "pr-[226px]")
            : "pr-[162px]"),
          !isWindows && (showPanelButton ? "pr-28" : "pr-10"),
        )}
      >
        {tabs.map((tab) => (
          <TabBarItem
            key={tab.id}
            id={tab.id}
            type={tab.type}
            title={tab.title}
            workspaceName={tab.type === 'agent' ? workspaceNameBySessionId.get(tab.sessionId) : undefined}
            isAutomation={tab.type === 'agent' && automationSessionIds.has(tab.sessionId)}
            isDelegation={tab.type === 'agent' && delegationSessionIds.has(tab.sessionId)}
            isActive={tab.id === activeTabId}
            closable={canCloseMainTab(tab, activeTabId)}
            isStreaming={streamingMap.get(tab.id) ?? 'idle'}
            isHovered={hoveredTabId === tab.id}
            isLeaving={hoveredTabId === tab.id && isLeaving}
            isTearingOff={false}
            onActivate={() => onActivate(tab.id)}
            onClose={() => onClose(tab.id)}
            onMiddleClick={() => onClose(tab.id)}
            onDragStart={(e) => onDragStart(tab.id, e)}
            onHoverEnter={() => handleTabHoverEnter(tab.id)}
            onHoverLeave={handleTabHoverLeave}
            onPanelHoverEnter={handlePanelHoverEnter}
            onPanelHoverLeave={handleTabHoverLeave}
          />
        ))}
      </div>

      <TabBarActions
        isWindows={isWindows}
        showPanelButton={showPanelButton}
        isPanelOpen={isPanelOpen}
        isTerminalOpen={isTerminalOpen}
        activeAgentSessionId={activeAgentSessionId}
        runningPopoverOpen={runningPopoverOpen}
        hasRunningServiceTerminal={hasRunningServiceTerminal}
        onOpenShortcutGuide={openShortcutGuide}
        onToggleTerminal={toggleTerminal}
        onTogglePanel={togglePanel}
        onSetRunningPopoverOpen={setRunningPopoverOpen}
      />
    </div>
  )
}

/** 顶部标签栏右侧的全局操作区；Windows 主区铺满时避开窗口控制按钮。 */
function TabBarActions({
  isWindows,
  showPanelButton,
  isPanelOpen,
  isTerminalOpen,
  activeAgentSessionId,
  runningPopoverOpen,
  hasRunningServiceTerminal,
  onOpenShortcutGuide,
  onToggleTerminal,
  onTogglePanel,
  onSetRunningPopoverOpen,
}: {
  isWindows: boolean
  showPanelButton: boolean
  isPanelOpen: boolean
  isTerminalOpen: boolean
  activeAgentSessionId: string | null
  runningPopoverOpen: boolean
  hasRunningServiceTerminal: boolean
  onOpenShortcutGuide: () => void
  onToggleTerminal: () => void
  onTogglePanel: () => void
  onSetRunningPopoverOpen: (open: boolean) => void
}): React.ReactElement {
  const panelActionLabel = isPanelOpen ? '折叠右侧工作区' : '打开右侧工作区'

  return (
    <div
      className={cn(
        "absolute inset-y-0 z-10 flex items-end gap-1 pb-[3px] titlebar-no-drag",
        isWindows && (!showPanelButton || !isPanelOpen) ? "right-[130px]" : "right-1",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onOpenShortcutGuide}
          >
            <Keyboard className="size-3.5" />
            <span className="sr-only">查看快捷键地图</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>查看快捷键地图</p>
        </TooltipContent>
      </Tooltip>

      {showPanelButton && (
        <RunningTerminalsPopover
          ownerSessionId={activeAgentSessionId ?? ''}
          open={runningPopoverOpen}
          onOpenChange={(nextOpen) => {
            if (nextOpen && !hasRunningServiceTerminal) {
              // 无运行中服务：不弹浮层，直接打开底部手动终端。
              onToggleTerminal()
              return
            }
            onSetRunningPopoverOpen(nextOpen)
          }}
          onOpenTerminalPanel={onToggleTerminal}
          icon={<SquareTerminal className="size-3.5" />}
          tooltipLabel={hasRunningServiceTerminal ? '查看运行中的服务' : '手动终端'}
          active={isTerminalOpen || runningPopoverOpen}
          hasRunningDot={hasRunningServiceTerminal}
        />
      )}

      {showPanelButton && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                'relative h-7 w-7',
                isPanelOpen && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary',
              )}
              aria-label={panelActionLabel}
              aria-pressed={isPanelOpen}
              onClick={onTogglePanel}
            >
              {isPanelOpen
                ? <PanelRightClose className="size-3.5" />
                : <PanelRight className="size-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>{panelActionLabel} ({navigator.platform.includes('Mac') ? '⌘⇧B' : 'Ctrl+Shift+B'})</p>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

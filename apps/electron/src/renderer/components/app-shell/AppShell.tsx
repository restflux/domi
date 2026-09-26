/**
 * AppShell - 应用主布局容器
 *
 * 布局结构：[LeftSidebar 可折叠] | [MainArea: TabBar + TabContent] | [RightSidePanel 可折叠]
 *
 * MainArea 支持多标签页，Settings 视图为独立覆盖。
 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { LeftSidebar } from './LeftSidebar'
import { WorkbenchSidebarV2 } from './v2/WorkbenchSidebarV2'

import { SidebarTitlebarToggle } from './SidebarTitlebarToggle'
import { SIDEBAR_PREVIEW_EXIT_MS, shouldCloseSidebarHoverPreview, shouldRenderSidebarHoverPreview } from './sidebar-hover-preview'
import { RightSidePanel } from './RightSidePanel'
import { CommandPalette } from './CommandPalette'
import { MainArea } from '@/components/tabs/MainArea'
import { AppShellProvider, type AppShellContextType } from '@/contexts/AppShellContext'
import { appModeAtom } from '@/atoms/app-mode'
import { agentSidePanelWidthAtom, currentAgentSessionIdAtom, currentSessionSidePanelOpenAtom } from '@/atoms/agent-atoms'
import { leftSidebarWidthAtom } from '@/atoms/sidebar-atoms'
import { sidebarCollapsedAtom } from '@/atoms/tab-atoms'
import { automationFormAtom } from '@/atoms/automation-atoms'
import { activeViewAtom } from '@/atoms/active-view'
import { interfaceVariantAtom } from '@/atoms/theme'
import { settingsOpenAtom } from '@/atoms/settings-tab'
import { WindowControls } from '@/components/WindowControls'
import { SettingsPanel } from '@/components/settings/SettingsPanel'
import { WorktreeManagerSheet } from '@/components/agent/worktree-manager/WorktreeManagerSheet.tsx'
import { detectIsMac, detectIsWindows, WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'
import { cn } from '@/lib/utils'
import {
  clampRightWorkspaceWidth,
  resolveRightWorkspaceActivation,
  resolveRightWorkspaceAutoWidthActivation,
  shouldShowRightWorkspace,
} from '@/lib/right-workspace-model'
import {
  ensureRightWorkspaceToolWidthAtom,
  rightWorkspaceFocusAtom,
  rightWorkspaceSessionStateMapAtom,
} from '@/atoms/right-workspace-atoms'

const MIN_LEFT_SIDEBAR_WIDTH = 300
const MAX_LEFT_SIDEBAR_WIDTH = 420

function clampLeftSidebarWidth(width: number): number {
  return Math.max(MIN_LEFT_SIDEBAR_WIDTH, Math.min(MAX_LEFT_SIDEBAR_WIDTH, width))
}

export interface AppShellProps {
  /** Context 值，用于传递给子组件 */
  contextValue: AppShellContextType
}

export function AppShell({ contextValue }: AppShellProps): React.ReactElement {
  const appMode = useAtomValue(appModeAtom)
  const currentSessionId = useAtomValue(currentAgentSessionIdAtom)
  const isPanelOpen = useAtomValue(currentSessionSidePanelOpenAtom)
  const automationForm = useAtomValue(automationFormAtom)
  const interfaceVariant = useAtomValue(interfaceVariantAtom)
  const settingsOpen = useAtomValue(settingsOpenAtom)
  const setSettingsOpen = useSetAtom(settingsOpenAtom)
  const isClassic = interfaceVariant === 'classic'
  const isWorkbenchV2 = interfaceVariant === 'workbench-v2'
  // 定时任务表单打开时隐藏右侧文件面板，让中间区域扩展到全宽（表单内含自己的右栏配置）
  const activeView = useAtomValue(activeViewAtom)
  const showRightPanel = shouldShowRightWorkspace({
    appMode,
    hasSession: Boolean(currentSessionId),
    open: isPanelOpen,
    automationFormOpen: automationForm.open,
    activeView,
  })
  const rightWorkspaceFocus = useAtomValue(rightWorkspaceFocusAtom)
  const rightWorkspaceSessionStateMap = useAtomValue(rightWorkspaceSessionStateMapAtom)
  const ensureRightWorkspaceToolWidth = useSetAtom(ensureRightWorkspaceToolWidthAtom)
  const workspaceFocusActive = showRightPanel && rightWorkspaceFocus?.sessionId === currentSessionId
  const rightWorkspaceActivation = currentSessionId
    ? resolveRightWorkspaceActivation(currentSessionId, rightWorkspaceSessionStateMap.get(currentSessionId))
    : null
  const lastAutoWidthActivationRef = React.useRef<string | null>(null)
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const isMac = React.useMemo(() => detectIsMac(), [])

  React.useEffect(() => {
    const decision = resolveRightWorkspaceAutoWidthActivation(
      lastAutoWidthActivationRef.current,
      showRightPanel,
      rightWorkspaceActivation,
    )
    lastAutoWidthActivationRef.current = decision.nextKey
    if (decision.toolToEnsure) ensureRightWorkspaceToolWidth(decision.toolToEnsure)
  }, [ensureRightWorkspaceToolWidth, rightWorkspaceActivation, showRightPanel])

  // 左侧边栏可拖拽宽度
  const [leftSidebarWidth, setLeftSidebarWidth] = useAtom(leftSidebarWidthAtom)
  const [sidebarCollapsed, setSidebarCollapsed] = useAtom(sidebarCollapsedAtom)
  const [sidebarPreviewOpen, setSidebarPreviewOpen] = React.useState(false)
  const [previewMounted, setPreviewMounted] = React.useState(false)
  const [previewShown, setPreviewShown] = React.useState(false)
  const hoverTimerRef = React.useRef<number | null>(null)
  const closeTimerRef = React.useRef<number | null>(null)
  const lastPointerRef = React.useRef({ x: 0, y: 0 })
  const keyboardPreviewRef = React.useRef(false)
  const sidebarFrameRef = React.useRef<HTMLDivElement>(null)
  const previewActive = sidebarCollapsed && !isClassic && !isWorkbenchV2 && sidebarPreviewOpen && !settingsOpen
  const previewRendered = shouldRenderSidebarHoverPreview(previewActive, previewMounted, sidebarCollapsed, isClassic || isWorkbenchV2, settingsOpen)

  React.useEffect(() => {
    if (previewActive) {
      setPreviewMounted(true)
      return
    }
    if (!previewMounted) return
    if (!sidebarCollapsed || isClassic || settingsOpen) {
      setPreviewMounted(false)
      return
    }
    const timer = window.setTimeout(() => setPreviewMounted(false), SIDEBAR_PREVIEW_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [previewActive, previewMounted, sidebarCollapsed, isClassic, settingsOpen])
  React.useEffect(() => {
    if (!previewActive) {
      setPreviewShown(false)
      return
    }
    const frame = requestAnimationFrame(() => setPreviewShown(true))
    return () => cancelAnimationFrame(frame)
  }, [previewActive])
  const clearHoverTimer = React.useCallback(() => {
    if (hoverTimerRef.current !== null) window.clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = null
  }, [])
  const clearCloseTimer = React.useCallback(() => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])
  const schedulePreviewClose = (): void => {
    if (keyboardPreviewRef.current || closeTimerRef.current !== null) return
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      const preview = sidebarFrameRef.current?.querySelector('[data-sidebar-preview]')
      const bounds = preview?.getBoundingClientRect() ?? null
      const popupOpen = Boolean(document.querySelector('[data-radix-popper-content-wrapper] [role="menu"], [role="dialog"]'))
      if (shouldCloseSidebarHoverPreview(lastPointerRef.current, bounds, popupOpen, Boolean(preview?.contains(document.activeElement)))) {
        setSidebarPreviewOpen(false)
      }
    }, 160)
  }
  const scheduleSidebarHover = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!sidebarCollapsed || isClassic || settingsOpen || previewActive) return
    if (event.pointerType !== 'mouse' || (isMac && event.clientY < 50)) return
    // 轨道上的搜索/工作动态/设置仍是可点击控件，不能在按下前换成错位的浮层按钮。
    const button = event.target instanceof Element ? event.target.closest('button') : null
    if (button && button.getAttribute('aria-label') !== 'Domi，预览或固定展开侧边栏') {
      clearHoverTimer()
      return
    }
    if (hoverTimerRef.current !== null) return
    keyboardPreviewRef.current = false
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null
      setSidebarPreviewOpen(true)
    }, 140)
  }

  React.useEffect(() => () => {
    clearHoverTimer()
    clearCloseTimer()
  }, [clearHoverTimer, clearCloseTimer])
  React.useEffect(() => {
    if (!sidebarCollapsed || isClassic || settingsOpen) {
      clearHoverTimer()
      clearCloseTimer()
      setSidebarPreviewOpen(false)
      keyboardPreviewRef.current = false
    }
  }, [sidebarCollapsed, isClassic, settingsOpen, clearHoverTimer, clearCloseTimer])
  React.useEffect(() => {
    if (!previewActive || !keyboardPreviewRef.current) return
    const frame = requestAnimationFrame(() => {
      sidebarFrameRef.current?.querySelector<HTMLButtonElement>('[data-sidebar-preview] button')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [previewActive])
  React.useEffect(() => {
    if (!previewActive) return
    const handleOutsidePointer = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse' || keyboardPreviewRef.current || !(event.target instanceof Element)) return
      lastPointerRef.current = { x: event.clientX, y: event.clientY }
      if (sidebarFrameRef.current?.contains(event.target) || event.target.closest('[data-radix-popper-content-wrapper], [role="menu"], [role="dialog"]')) {
        clearCloseTimer()
        return
      }
      schedulePreviewClose()
    }
    const closeOnWindowBlur = (): void => {
      keyboardPreviewRef.current = false
      clearCloseTimer()
      setSidebarPreviewOpen(false)
    }
    document.addEventListener('pointermove', handleOutsidePointer)
    window.addEventListener('blur', closeOnWindowBlur)
    return () => {
      document.removeEventListener('pointermove', handleOutsidePointer)
      window.removeEventListener('blur', closeOnWindowBlur)
      clearCloseTimer()
    }
  }, [previewActive, clearCloseTimer])

  const leftDragging = React.useRef(false)
  const [isDraggingLeftSidebar, setIsDraggingLeftSidebar] = React.useState(false)
  const clampedLeftSidebarWidth = clampLeftSidebarWidth(leftSidebarWidth)

  React.useEffect(() => {
    if (clampedLeftSidebarWidth !== leftSidebarWidth) {
      setLeftSidebarWidth(clampedLeftSidebarWidth)
    }
  }, [clampedLeftSidebarWidth, leftSidebarWidth, setLeftSidebarWidth])

  const handleLeftSidebarMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    leftDragging.current = true
    setIsDraggingLeftSidebar(true)
    const startX = e.clientX
    const startWidth = clampedLeftSidebarWidth
    // 记录最新光标位置，rAF 回调读取它而非调度时捕获的旧事件，避免快拖时坐标滞后
    let latestClientX = startX
    let rafId = 0

    const applyWidth = () => {
      const delta = latestClientX - startX
      setLeftSidebarWidth(clampLeftSidebarWidth(startWidth + delta))
    }

    const onMouseMove = (ev: MouseEvent) => {
      if (!leftDragging.current) return
      latestClientX = ev.clientX
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        applyWidth()
      })
    }

    const onMouseUp = () => {
      leftDragging.current = false
      setIsDraggingLeftSidebar(false)
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      // 补一次最终 flush，保证落点停在光标实际位置而非上一帧
      applyWidth()
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [clampedLeftSidebarWidth, setLeftSidebarWidth])

  // 右侧面板可拖拽宽度
  const [rightPanelWidth, setRightPanelWidth] = useAtom(agentSidePanelWidthAtom)
  const dragging = React.useRef(false)
  const clampedRightPanelWidth = clampRightWorkspaceWidth(rightPanelWidth)

  React.useEffect(() => {
    if (clampedRightPanelWidth !== rightPanelWidth) {
      setRightPanelWidth(clampedRightPanelWidth)
    }
  }, [clampedRightPanelWidth, rightPanelWidth, setRightPanelWidth])

  const handleMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startWidth = clampedRightPanelWidth
    // 记录最新光标位置，rAF 回调读取它而非调度时捕获的旧事件，避免快拖时坐标滞后
    let latestClientX = startX
    let rafId = 0

    const applyWidth = () => {
      const delta = startX - latestClientX
      setRightPanelWidth(clampRightWorkspaceWidth(startWidth + delta))
    }

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      latestClientX = ev.clientX
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        rafId = 0
        applyWidth()
      })
    }

    const onMouseUp = () => {
      dragging.current = false
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      // 补一次最终 flush，保证落点停在光标实际位置而非上一帧
      applyWidth()
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [clampedRightPanelWidth, setRightPanelWidth])

  return (
    <AppShellProvider value={contextValue}>
      {/* 可拖动标题栏区域，用于窗口拖动。
          Windows 上必须避开右上角的 WindowControls 区域（buttons ~118px + 8px buffer = 126px），
          否则 drag-region 与按钮区的 hitmask 重叠会让 OS 把单击当成标题栏点击，
          表现为"按钮要双击才响应"。 */}
      <div
        className={cn(
          'titlebar-drag-region fixed top-0 h-[50px] z-50',
          isClassic ? 'left-0' : isMac ? 'left-[128px]' : 'left-[48px]',
          isWindows ? WINDOW_CONTROLS_INSET_RIGHT : 'right-0'
        )}
      />

      {!isClassic && !isWorkbenchV2 && !settingsOpen && (
        <SidebarTitlebarToggle
          isMac={isMac}
          collapsed={sidebarCollapsed}
          previewActive={previewActive}
          onToggle={() => {
            setSidebarPreviewOpen(false)
            setSidebarCollapsed(!sidebarCollapsed)
          }}
        />
      )}

      {!isClassic && !settingsOpen && <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-[45px] z-[75] h-px bg-border/35" />}

      {/* Windows 自定义窗口控制按钮（最小化/最大化/关闭） */}
      <WindowControls />

      <div className="shell-bg relative h-screen w-screen overflow-hidden">
        <div className={cn('flex h-full w-full', settingsOpen && 'hidden')} aria-hidden={settingsOpen}>
            {/* 左侧边栏：可折叠，可拖拽调整宽度 */}
            <div
              ref={sidebarFrameRef}
              className={cn(isClassic ? 'p-2 pr-0' : '', 'relative z-[60] crt-sidebar', previewRendered && 'z-[70] w-[52px] flex-none')}
              onPointerEnter={scheduleSidebarHover}
              onPointerMove={(event) => {
                lastPointerRef.current = { x: event.clientX, y: event.clientY }
                clearCloseTimer()
                scheduleSidebarHover(event)
              }}
              onPointerLeave={(event) => {
                clearHoverTimer()
                lastPointerRef.current = { x: event.clientX, y: event.clientY }
                schedulePreviewClose()
              }}
              onFocusCapture={(event) => {
                if (!sidebarCollapsed || isClassic || previewActive || !event.target.matches(':focus-visible')) return
                if (event.target.getAttribute('aria-label') !== 'Domi，预览或固定展开侧边栏') return
                clearHoverTimer()
                keyboardPreviewRef.current = true
                setSidebarPreviewOpen(true)
              }}
              onBlurCapture={(event) => {
                if (!previewActive) return
                const next = event.relatedTarget
                if (next instanceof Node && event.currentTarget.contains(next)) return
                if (next instanceof Element && next.closest('[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]')) return
                if (!keyboardPreviewRef.current) {
                  schedulePreviewClose()
                  return
                }
                requestAnimationFrame(() => {
                  if (!sidebarFrameRef.current?.contains(document.activeElement)) {
                    keyboardPreviewRef.current = false
                    setSidebarPreviewOpen(false)
                  }
                })
              }}
            >
              {!previewActive && (isWorkbenchV2 && appMode === 'agent'
                ? <WorkbenchSidebarV2 width={clampedLeftSidebarWidth} noTransition={isDraggingLeftSidebar} />
                : <LeftSidebar width={clampedLeftSidebarWidth} noTransition={isDraggingLeftSidebar} />)}
              {previewRendered && (
                <div
                  data-sidebar-preview="true"
                  aria-hidden={!previewActive}
                  ref={(element) => { if (element) element.inert = !previewActive }}
                  className={cn('absolute inset-y-0 left-0 z-30 w-max max-w-[calc(100vw-16px)]', !previewActive && 'pointer-events-none')}
                >
                  <div
                    data-state={previewActive && previewShown ? 'open' : 'closing'}
                    className="sidebar-hover-preview-surface h-full overflow-hidden rounded-r-xl border-r border-border/50 bg-[hsl(var(--sidebar-surface))] shadow-xl"
                  >
                    <LeftSidebar width={clampedLeftSidebarWidth} previewExpanded noTransition />
                  </div>
                </div>
              )}
              {/* 侧边栏展开时显示拖拽手柄，折叠态隐藏 */}
              {!sidebarCollapsed && (
                <div
                  className="shell-resize-handle absolute right-0 top-0 bottom-0 z-20 w-4 translate-x-1/2 cursor-col-resize transition-colors hover:bg-primary/5 active:bg-primary/50"
                  onMouseDown={handleLeftSidebarMouseDown}
                />
              )}
            </div>
            {!isClassic && (
              <div aria-hidden="true" className="shell-divider relative z-[61] w-px flex-shrink-0" />
            )}

            {/* 中间容器：relative z-[60] 使其在 z-50 拖动区域之上 */}
            <div
              className={cn(
                'min-w-0 relative z-[60]',
                workspaceFocusActive
                  ? 'invisible pointer-events-none w-0 flex-none overflow-hidden'
                  : 'flex-1',
                isClassic && !workspaceFocusActive && 'p-2',
              )}
              aria-hidden={workspaceFocusActive}
            >
              {/* 主内容区域（TabBar + TabContent） */}
              <MainArea />
            </div>

            {/* 右侧边栏：Agent 文件面板 */}
            {showRightPanel && (
              <div
                className={cn(
                  'relative z-[60] flex min-w-0 items-stretch crt-sidebar',
                  workspaceFocusActive ? 'flex-1' : 'shrink-0',
                  isClassic
                    ? 'transition-[padding] duration-300 ease-in-out'
                    : '',
                  isClassic && (isPanelOpen ? 'p-2 pl-0' : 'p-0')
                )}
              >
                {!isClassic && (
                  <div aria-hidden="true" className="shell-divider pointer-events-none absolute left-0 top-0 bottom-0 z-10 w-px" />
                )}
                {/* 拖拽手柄 */}
                {isPanelOpen && !workspaceFocusActive && (
                  <div
                    className={cn(
                      'shell-resize-handle absolute left-0 top-0 bottom-0 w-[8px] -translate-x-1/2 cursor-col-resize transition-colors hover:bg-primary/5 active:bg-primary/50',
                      isClassic ? 'z-10' : 'z-20'
                    )}
                    onMouseDown={handleMouseDown}
                  />
                )}
                <RightSidePanel width={workspaceFocusActive ? '100%' : clampedRightPanelWidth} />
              </div>
            )}
        </div>
        <WorktreeManagerSheet />
        <CommandPalette />
        {settingsOpen && (
          <div className="absolute inset-0 z-[60]">
            <SettingsPanel onClose={() => setSettingsOpen(false)} />
          </div>
        )}
      </div>
    </AppShellProvider>
  )
}

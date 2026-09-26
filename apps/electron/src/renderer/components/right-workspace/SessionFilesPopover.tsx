/**
 * SessionFilesPopover — 顶部常驻入口与右上角的会话文件浮窗。
 *
 * 使用轻量的输出／来源清单；完整文件树只在用户显式查看全部时打开。
 * 用户按需点击入口展开，点击卡片外层或按 Escape 关闭。
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useAtomValue, useSetAtom } from 'jotai'
import { agentFileSourceFilterMapAtom, agentSessionPathMapAtom } from '@/atoms/agent-atoms'
import {
  activateSessionRightWorkspaceTool,
  rightWorkspaceOpenAtom,
  rightWorkspaceSessionStateMapAtom,
  sessionFilesPopoverReservationMapAtom,
} from '@/atoms/right-workspace-atoms'
import { SessionFilesCard } from './SessionFilesCard'
import { Button } from '@/components/ui/button'
import {
  DEFAULT_SESSION_FILES_POPOVER_OPEN,
  positionSessionFilesPopover,
  resolveRightWorkspaceToolAfterSessionFilesClose,
  resolveSessionFilesConversationReservation,
  shouldCloseSessionFilesPopoverOnPointerDown,
} from './session-files-popover-model'

interface SessionFilesPopoverProps {
  sessionId: string
  rightWorkspaceOpen: boolean
}

export function SessionFilesPopover({ sessionId, rightWorkspaceOpen }: SessionFilesPopoverProps): React.ReactElement | null {
  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)
  const sessionPath = sessionPathMap.get(sessionId) ?? null
  const setRightWorkspaceSessionStateMap = useSetAtom(rightWorkspaceSessionStateMapAtom)
  const setRightWorkspaceOpen = useSetAtom(rightWorkspaceOpenAtom)
  const setFileSourceFilterMap = useSetAtom(agentFileSourceFilterMapAtom)
  const setReservationMap = useSetAtom(sessionFilesPopoverReservationMapAtom)
  const viewAllRef = React.useRef(false)
  const [open, setOpen] = React.useState(DEFAULT_SESSION_FILES_POPOVER_OPEN)
  const [position, setPosition] = React.useState<ReturnType<typeof positionSessionFilesPopover> | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    setOpen(rightWorkspaceOpen ? false : DEFAULT_SESSION_FILES_POPOVER_OPEN)
  }, [sessionId])

  React.useEffect(() => {
    if (!rightWorkspaceOpen) return
    setOpen(false)
    // 只有显式“查看全部”才进入文件工具；普通开栏仍不自动恢复会话文件。
    if (viewAllRef.current) {
      viewAllRef.current = false
      return
    }
    setRightWorkspaceSessionStateMap((current) => {
      const currentState = current.get(sessionId)
      const nextTool = resolveRightWorkspaceToolAfterSessionFilesClose(currentState?.activeTool)
      if (currentState?.activeTool === nextTool) return current
      return activateSessionRightWorkspaceTool(current, sessionId, nextTool)
    })
  }, [rightWorkspaceOpen, sessionId, setRightWorkspaceSessionStateMap])

  React.useEffect(() => {
    const updateReservation = (width: number): void => {
      setReservationMap((current) => {
        if ((current.get(sessionId) ?? 0) === width) return current
        const next = new Map(current)
        if (width > 0) next.set(sessionId, width)
        else next.delete(sessionId)
        return next
      })
    }
    if (!open) {
      setPosition(null)
      updateReservation(0)
      return
    }

    const trigger = triggerRef.current
    const main = trigger?.closest('.main-tabbar')
    if (!trigger || !main) {
      setPosition(null)
      updateReservation(0)
      return
    }
    const updatePosition = (): void => {
      const triggerRect = trigger.getBoundingClientRect()
      const mainRect = main.getBoundingClientRect()
      const next = positionSessionFilesPopover({
        viewportWidth: window.innerWidth,
        mainLeft: mainRect.left,
        mainRight: mainRect.right,
        mainBottom: mainRect.bottom,
        triggerRight: triggerRect.right,
        triggerBottom: triggerRect.bottom,
      })
      setPosition((previous) => previous?.top === next.top && previous.right === next.right && previous.width === next.width
        ? previous : next)
      const cardRightInset = Math.max(0, mainRect.right - (window.innerWidth - next.right))
      updateReservation(resolveSessionFilesConversationReservation(mainRect.width, next.width, cardRightInset, rightWorkspaceOpen))
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition)
    observer?.observe(main)
    observer?.observe(trigger)
    return () => {
      window.removeEventListener('resize', updatePosition)
      observer?.disconnect()
    }
  }, [open, rightWorkspaceOpen, sessionId, setReservationMap])

  React.useEffect(() => () => {
    setReservationMap((current) => {
      if (!current.has(sessionId)) return current
      const next = new Map(current)
      next.delete(sessionId)
      return next
    })
  }, [sessionId, setReservationMap])

  React.useEffect(() => {
    if (!open) return

    const handlePointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      const shouldClose = shouldCloseSessionFilesPopoverOnPointerDown({
        rightWorkspaceOpen,
        insideTrigger: triggerRef.current?.contains(event.target) ?? false,
        insidePanel: panelRef.current?.contains(event.target) ?? false,
        insideOverlay: event.target instanceof Element && Boolean(event.target.closest(
          '[data-radix-popper-content-wrapper], [role="dialog"]',
        )),
      })
      if (shouldClose) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, rightWorkspaceOpen])

  const viewAll = (): void => {
    viewAllRef.current = !rightWorkspaceOpen
    setOpen(false)
    setFileSourceFilterMap((current) => ({ ...current, [sessionId]: 'session' }))
    setRightWorkspaceSessionStateMap((current) => activateSessionRightWorkspaceTool(current, sessionId, 'files'))
    setRightWorkspaceOpen(true)
  }

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        className={open
          ? 'relative h-7 w-7 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary'
          : 'relative h-7 w-7'}
        aria-label={open ? '关闭会话文件浮窗' : '查看会话文件'}
        aria-expanded={open}
        title="会话文件"
        onClick={() => setOpen((current) => !current)}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="size-3.5">
          <circle cx="5" cy="7" r="1.2" />
          <path d="M9 7h10" />
          <circle cx="5" cy="16" r="1.2" />
          <path d="M9 16h10" />
        </svg>
      </Button>

      {open && position && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          data-session-files-popover
          style={{ top: position.top, right: position.right, width: position.width }}
          className="titlebar-no-drag fixed z-[100] flex max-h-[min(244px,calc(100vh-74px))] flex-col overflow-hidden rounded-[22px] border border-border/25 bg-popover/98 shadow-[0_8px_28px_rgba(0,0,0,0.10)] backdrop-blur-xl animate-in fade-in-0 zoom-in-95 duration-150"
        >
          <SessionFilesCard sessionId={sessionId} sessionPath={sessionPath} onViewAll={viewAll} />
        </div>,
        document.body,
      )}
    </>
  )
}

/**
 * SessionFilesPopover — 右侧工作区收起时固定在右上角的会话文件卡片。
 *
 * 使用轻量的输出／来源清单；完整文件树只在用户显式查看全部时打开。
 * 用户按需点击入口展开，点击卡片外层或按 Escape 关闭。
 */

import * as React from 'react'
import { createPortal } from 'react-dom'
import { useAtomValue, useSetAtom } from 'jotai'
import { FolderOpen } from 'lucide-react'
import { agentFileSourceFilterMapAtom, agentSessionPathMapAtom } from '@/atoms/agent-atoms'
import {
  activateSessionRightWorkspaceTool,
  rightWorkspaceOpenAtom,
  rightWorkspaceSessionStateMapAtom,
} from '@/atoms/right-workspace-atoms'
import { SessionFilesCard } from './SessionFilesCard'
import { Button } from '@/components/ui/button'
import {
  DEFAULT_SESSION_FILES_POPOVER_OPEN,
  resolveRightWorkspaceToolAfterSessionFilesClose,
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
  const viewAllRef = React.useRef(false)
  const [open, setOpen] = React.useState(DEFAULT_SESSION_FILES_POPOVER_OPEN)
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
    if (!open || rightWorkspaceOpen) return

    const handlePointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return
      const shouldClose = shouldCloseSessionFilesPopoverOnPointerDown({
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
  }, [open])

  const viewAll = (): void => {
    viewAllRef.current = true
    setOpen(false)
    setFileSourceFilterMap((current) => ({ ...current, [sessionId]: 'session' }))
    setRightWorkspaceSessionStateMap((current) => activateSessionRightWorkspaceTool(current, sessionId, 'files'))
    setRightWorkspaceOpen(true)
  }

  if (rightWorkspaceOpen) return null

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
        <FolderOpen className="size-3.5" />
      </Button>

      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          data-session-files-popover
          className="titlebar-no-drag fixed right-4 top-[58px] z-[100] flex max-h-[min(244px,calc(100vh-74px))] w-[min(300px,calc(100vw-24px))] flex-col overflow-hidden rounded-[22px] border border-border/25 bg-popover/98 shadow-[0_8px_28px_rgba(0,0,0,0.10)] backdrop-blur-xl animate-in fade-in-0 zoom-in-95 duration-150"
        >
          <SessionFilesCard sessionId={sessionId} sessionPath={sessionPath} onViewAll={viewAll} />
        </div>,
        document.body,
      )}
    </>
  )
}

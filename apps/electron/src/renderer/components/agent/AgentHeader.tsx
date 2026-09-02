/**
 * AgentHeader — Agent 会话工具栏
 *
 * 会话标题只在顶部标签页显示；本工具栏保留会话树、Session Target
 * 与当前会话操作，避免在相邻两层重复呈现同一个标题。
 */

import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Images, Share2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  agentSessionIndicatorMapAtom,
  agentSessionPathMapAtom,
  agentSessionsAtom,
  agentWorkspacesAtom,
} from '@/atoms/agent-atoms'
import { sessionHeaderCommandAtom } from '@/atoms/session-header-actions'
import { tabsAtom, updateTabTitle } from '@/atoms/tab-atoms'
import { SessionHeaderMenu, SessionRenameDialog } from '@/components/SessionHeaderMenu.tsx'
import { GeneratedGalleryDrawer } from '@/components/gallery/GeneratedGalleryDrawer'
import { buildAgentSessionHeaderMenu, type SessionHeaderMenuAction } from '@/components/session-header-menu-model.ts'
import { copyTextToClipboard } from '@/lib/clipboard'
import { replaceAgentSessionInFreshnessOrder } from '@/lib/agent-session-list'
import { detectIsWindows, WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { AgentSessionTargetBadge } from './AgentSessionTarget.tsx'

interface AgentHeaderProps {
  sessionId: string
  branchCount?: number
  onToggleSessionTree?: () => void
  sessionTreeOpen?: boolean
}

export function AgentHeader({
  sessionId,
  branchCount = 0,
  onToggleSessionTree,
  sessionTreeOpen = false,
}: AgentHeaderProps): React.ReactElement | null {
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const sessions = useAtomValue(agentSessionsAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const indicatorMap = useAtomValue(agentSessionIndicatorMapAtom)
  const sessionPathMap = useAtomValue(agentSessionPathMapAtom)
  const session = sessions.find((item) => item.id === sessionId) ?? null
  const setAgentSessions = useSetAtom(agentSessionsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setSessionCommand = useSetAtom(sessionHeaderCommandAtom)
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [galleryOpen, setGalleryOpen] = React.useState(false)

  if (!session) return null

  const workspace = workspaces.find((item) => item.id === session.workspaceId)
  const sessionPath = sessionPathMap.get(session.id) ?? null
  const indicatorStatus = indicatorMap.get(session.id) ?? 'idle'
  const canOpenProjectFolder = Boolean(
    workspace
    && (!workspace.projectRootPath || !workspace.projectRootStatus || workspace.projectRootStatus === 'available'),
  )
  const canTransfer = indicatorStatus === 'idle' || indicatorStatus === 'completed'
  const menuEntries = buildAgentSessionHeaderMenu({
    pinned: !!session.pinned,
    needsFollowUp: !!session.needsFollowUp,
    archived: !!session.archived,
    canTransfer,
    isDraft: session.sessionTarget?.kind === 'unselected',
    canOpenProjectFolder,
    hasSessionPath: !!sessionPath,
  })

  const rename = async (title: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.updateAgentSessionTitle(session.id, title)
      setTabs((previous) => updateTabTitle(previous, updated.id, updated.title))
      setAgentSessions((previous) => replaceAgentSessionInFreshnessOrder(previous, updated))
    } catch (error) {
      console.error('[AgentHeader] 更新标题失败:', error)
      toast.error('重命名失败', {
        description: error instanceof Error ? error.message : '无法更新会话标题',
      })
      throw error
    }
  }

  const copy = async (value: string, success: string): Promise<void> => {
    try {
      await copyTextToClipboard(value)
      toast.success(success)
    } catch (error) {
      toast.error('复制失败', {
        description: error instanceof Error ? error.message : '无法写入剪贴板',
      })
    }
  }

  const handleMenuAction = (action: SessionHeaderMenuAction): void => {
    if (action === 'rename') {
      setRenameOpen(true)
      return
    }
    if (action === 'copyId') {
      void copy(session.id, '已复制会话 ID')
      return
    }
    if (action === 'copyPath' && sessionPath) {
      void copy(sessionPath, '已复制会话目录')
      return
    }
    if (action === 'openProject' && workspace) {
      void window.electronAPI.openAgentWorkspaceProjectFolder(workspace.id)
        .catch((error) => {
          toast.error('无法打开项目文件夹', {
            description: error instanceof Error ? error.message : undefined,
          })
        })
      return
    }
    if (action === 'pin' || action === 'followUp' || action === 'archive' || action === 'move' || action === 'delete') {
      setSessionCommand({ sessionType: 'agent', sessionId: session.id, action })
    }
  }

  return (
    <>
      <div
        data-session-toolbar="agent"
        className="relative z-[51] flex h-10 items-center gap-2 px-4"
      >
        <div className={cn('absolute inset-0 titlebar-drag-region pointer-events-none', isWindows && WINDOW_CONTROLS_INSET_RIGHT)} />
        <div className="relative ml-auto flex min-w-0 items-center gap-1 titlebar-no-drag">
          <button
            type="button"
            onClick={() => setGalleryOpen(true)}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            aria-label="打开生成图片画廊"
            title="生成图片"
          >
            <Images className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onToggleSessionTree}
            className={cn(
              'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
              sessionTreeOpen && 'bg-primary/10 text-primary',
            )}
            aria-label={branchCount > 1 ? `打开会话树（${branchCount} 条分支）` : '打开会话树'}
            title={branchCount > 1 ? `会话树（${branchCount} 条分支）` : '会话树'}
          >
            <Share2 className="size-3.5" />
          </button>
          <AgentSessionTargetBadge
            sessionId={session.id}
            projectName={workspace?.name ?? '当前项目'}
          />
          <SessionHeaderMenu entries={menuEntries} onAction={handleMenuAction} />
        </div>
      </div>
      <SessionRenameDialog
        open={renameOpen}
        title={session.title}
        noun="会话"
        onOpenChange={setRenameOpen}
        onRename={rename}
      />
      <GeneratedGalleryDrawer
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        request={{ kind: 'agent', sessionId: session.id }}
      />
    </>
  )
}

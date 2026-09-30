/**
 * AgentHeader — Agent 会话工具栏
 *
 * 会话标题只在顶部标签页显示。现代界面将会话操作放进同一标签栏，
 * 经典界面保留独立工具栏。
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import '@/i18n'
import { createPortal } from 'react-dom'
import { useAtomValue, useSetAtom } from 'jotai'
import { Images, Share2 } from 'lucide-react'
import type { SDKSystemMessage } from '@domi/shared'
import { toast } from 'sonner'
import {
  agentSessionIndicatorMapAtom,
  agentSessionPathMapAtom,
  agentSessionsAtom,
  agentWorkspacesAtom,
} from '@/atoms/agent-atoms'
import { sessionHeaderCommandAtom } from '@/atoms/session-header-actions'
import { tabsAtom, updateTabTitle } from '@/atoms/tab-atoms'
import { interfaceVariantAtom } from '@/atoms/theme'
import { SessionHeaderMenu, SessionRenameDialog } from '@/components/SessionHeaderMenu.tsx'
import { GeneratedGalleryDrawer } from '@/components/gallery/GeneratedGalleryDrawer'
import { buildAgentSessionHeaderMenu, type SessionHeaderMenuAction } from '@/components/session-header-menu-model.ts'
import { FILE_MANAGER_OPENER_ID, type ProjectFolderOpener } from '@domi/shared'
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
  currentIterationRequest?: SDKSystemMessage | null
}

export function AgentHeader({
  sessionId,
  branchCount = 0,
  onToggleSessionTree,
  sessionTreeOpen = false,
  currentIterationRequest = null,
}: AgentHeaderProps): React.ReactElement | null {
  const { t } = useTranslation('work')
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const isModern = useAtomValue(interfaceVariantAtom) !== 'classic'
  const [tabBarSlot, setTabBarSlot] = React.useState<HTMLElement | null>(null)
  React.useEffect(() => {
    setTabBarSlot(isModern ? document.getElementById('agent-tabbar-session-actions') : null)
  }, [isModern, sessionId])
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
  // 本机可用的项目文件夹打开方式；探测失败时回退为普通菜单项。
  const [projectFolderOpeners, setProjectFolderOpeners] = React.useState<ProjectFolderOpener[] | null>(null)
  React.useEffect(() => {
    let cancelled = false
    window.electronAPI.listProjectFolderOpeners()
      .then((openers) => { if (!cancelled) setProjectFolderOpeners(openers) })
      .catch(() => { if (!cancelled) setProjectFolderOpeners(null) })
    return () => { cancelled = true }
  }, [])

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
    includeSessionTools: isModern,
    projectFolderOpeners: projectFolderOpeners ?? undefined,
  })

  const rename = async (title: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.updateAgentSessionTitle(session.id, title)
      setTabs((previous) => updateTabTitle(previous, updated.id, updated.title))
      setAgentSessions((previous) => replaceAgentSessionInFreshnessOrder(previous, updated))
    } catch (error) {
      console.error('[AgentHeader] 更新标题失败:', error)
      toast.error(t('renameFailed'), {
        description: error instanceof Error ? error.message : t('unableUpdateSessionTitle'),
      })
      throw error
    }
  }

  const copy = async (value: string, success: string): Promise<void> => {
    try {
      await copyTextToClipboard(value)
      toast.success(success)
    } catch (error) {
      toast.error(t('copyFailed'), {
        description: error instanceof Error ? error.message : t('unableWriteClipboard'),
      })
    }
  }

  const handleMenuAction = (action: SessionHeaderMenuAction, openerId?: string): void => {
    if (action === 'rename') {
      setRenameOpen(true)
      return
    }
    if (action === 'copyId') {
      void copy(session.id, t('copiedSessionId'))
      return
    }
    if (action === 'copyPath' && sessionPath) {
      void copy(sessionPath, t('copiedSessionDirectory'))
      return
    }
    if (action === 'openProject' && workspace) {
      // 子菜单会提交具体 openerId；普通菜单项回退到系统文件管理器。
      const targetOpenerId = openerId ?? FILE_MANAGER_OPENER_ID
      void window.electronAPI.openAgentWorkspaceProjectFolderWith(workspace.id, targetOpenerId)
        .catch((error) => {
          toast.error(t('unableOpenProjectFolder'), {
            description: error instanceof Error ? error.message : undefined,
          })
        })
      return
    }
    if (action === 'sessionTree') {
      onToggleSessionTree?.()
      return
    }
    if (action === 'gallery') {
      setGalleryOpen(true)
      return
    }
    if (action === 'pin' || action === 'followUp' || action === 'archive' || action === 'move' || action === 'delete') {
      setSessionCommand({ sessionType: 'agent', sessionId: session.id, action })
    }
  }

  // SSR 中保留可测试的工具栏；浏览器首帧等待标签栏槽位，避免闪现空白第二行。
  const showInlineToolbar = !isModern || typeof document === 'undefined'
  const toolbar = (
    <div data-session-toolbar="agent" className="flex min-w-0 items-center gap-0.5 titlebar-no-drag">
      {!isModern && (
        <>
          <button
            type="button"
            onClick={() => setGalleryOpen(true)}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            aria-label={t('openImageGallery')}
            title={t('generateImages')}
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
            aria-label={branchCount > 1 ? `${t('openSessionTree')} (${t('branches', { count: branchCount })})` : t('openSessionTree')}
            title={branchCount > 1 ? `${t('sessionTree')} (${t('branches', { count: branchCount })})` : t('sessionTree')}
          >
            <Share2 className="size-3.5" />
          </button>
        </>
      )}
      <AgentSessionTargetBadge
        sessionId={session.id}
        projectName={workspace?.name ?? t('currentProject')}
        hideProjectName={isModern}
        currentIterationRequest={currentIterationRequest}
      />
      <SessionHeaderMenu entries={menuEntries} onAction={handleMenuAction} />
    </div>
  )

  return (
    <>
      {isModern && tabBarSlot ? createPortal(toolbar, tabBarSlot) : showInlineToolbar ? (
        <div className="conversation-narrow relative z-[51] flex h-10 items-center justify-end px-4">
          <div className={cn('absolute inset-0 titlebar-drag-region pointer-events-none', isWindows && WINDOW_CONTROLS_INSET_RIGHT)} />
          {toolbar}
        </div>
      ) : null}
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

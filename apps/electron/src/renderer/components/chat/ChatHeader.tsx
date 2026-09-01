/**
 * ChatHeader - Chat 对话工具栏
 *
 * 对话标题只在顶部标签页显示；工具栏仅保留对话配置和当前对话菜单。
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { Columns2, Images } from 'lucide-react'
import { toast } from 'sonner'
import type { ConversationMeta } from '@domi/shared'
import { conversationsAtom } from '@/atoms/chat-atoms'
import { sessionHeaderCommandAtom } from '@/atoms/session-header-actions'
import { tabsAtom, updateTabTitle } from '@/atoms/tab-atoms'
import { SessionHeaderMenu, SessionRenameDialog } from '@/components/SessionHeaderMenu.tsx'
import { GeneratedGalleryDrawer } from '@/components/gallery/GeneratedGalleryDrawer'
import { buildChatSessionHeaderMenu, type SessionHeaderMenuAction } from '@/components/session-header-menu-model.ts'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useConversationParallelMode } from '@/hooks/useConversationSettings'
import { copyTextToClipboard } from '@/lib/clipboard'
import { detectIsWindows, WINDOW_CONTROLS_INSET_RIGHT } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { SystemPromptSelector } from './SystemPromptSelector'

interface ChatHeaderProps {
  conversation: ConversationMeta | null
}

export function ChatHeader({ conversation }: ChatHeaderProps): React.ReactElement | null {
  const isWindows = React.useMemo(() => detectIsWindows(), [])
  const setConversations = useSetAtom(conversationsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setSessionCommand = useSetAtom(sessionHeaderCommandAtom)
  const [parallelMode, setParallelMode] = useConversationParallelMode()
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [galleryOpen, setGalleryOpen] = React.useState(false)

  if (!conversation) return null

  const rename = async (title: string): Promise<void> => {
    try {
      const updated = await window.electronAPI.updateConversationTitle(conversation.id, title)
      setConversations((previous) => previous.map((item) => item.id === updated.id ? updated : item))
      setTabs((previous) => updateTabTitle(previous, updated.id, updated.title))
    } catch (error) {
      console.error('[ChatHeader] 更新标题失败:', error)
      toast.error('重命名失败', {
        description: error instanceof Error ? error.message : '无法更新对话标题',
      })
      throw error
    }
  }

  const handleMenuAction = (action: SessionHeaderMenuAction): void => {
    if (action === 'rename') {
      setRenameOpen(true)
      return
    }
    if (action === 'copyId') {
      void copyTextToClipboard(conversation.id)
        .then(() => toast.success('已复制会话 ID'))
        .catch((error) => toast.error('复制失败', {
          description: error instanceof Error ? error.message : '无法写入剪贴板',
        }))
      return
    }
    if (action === 'pin' || action === 'archive' || action === 'delete') {
      setSessionCommand({ sessionType: 'chat', sessionId: conversation.id, action })
    }
  }

  return (
    <>
      <div
        data-session-toolbar="chat"
        className="relative z-[51] flex h-10 items-center gap-2 px-4"
      >
        <div className={cn('absolute inset-0 titlebar-drag-region pointer-events-none', isWindows && WINDOW_CONTROLS_INSET_RIGHT)} />
        <div className="relative ml-auto flex items-center gap-1 titlebar-no-drag">
          <SystemPromptSelector />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => setGalleryOpen(true)}
              >
                <Images className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>生成图片</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn('size-7', parallelMode && 'bg-accent text-accent-foreground')}
                onClick={() => setParallelMode(!parallelMode)}
              >
                <Columns2 className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>{parallelMode ? '关闭并排模式' : '并排模式'}</p></TooltipContent>
          </Tooltip>
          <SessionHeaderMenu
            entries={buildChatSessionHeaderMenu({
              pinned: !!conversation.pinned,
              archived: !!conversation.archived,
            })}
            onAction={handleMenuAction}
          />
        </div>
      </div>
      <SessionRenameDialog
        open={renameOpen}
        title={conversation.title}
        noun="对话"
        onOpenChange={setRenameOpen}
        onRename={rename}
      />
      <GeneratedGalleryDrawer
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        request={{ kind: 'chat', conversationId: conversation.id }}
      />
    </>
  )
}

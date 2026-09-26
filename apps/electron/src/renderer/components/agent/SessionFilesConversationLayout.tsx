import * as React from 'react'
import { useAtomValue } from 'jotai'
import { sessionFilesPopoverReservationMapAtom } from '@/atoms/right-workspace-atoms'

/** 浮窗有空间时只缩小可供会话列居中的区域，不分别移动消息和输入框。 */
export function SessionFilesConversationLayout({ sessionId, children }: {
  sessionId: string
  children: React.ReactNode
}): React.ReactElement {
  const reservation = useAtomValue(sessionFilesPopoverReservationMapAtom).get(sessionId) ?? 0
  return (
    <div
      data-session-files-conversation-layout
      className="h-full min-h-0 w-full"
      style={reservation > 0 ? { paddingRight: reservation } : undefined}
    >
      {children}
    </div>
  )
}

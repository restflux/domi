import type { SessionTreeNode } from '@domi/shared'

export const SESSION_TREE_NAVIGATED_EVENT = 'proma:session-tree-navigated'
export const SESSION_TREE_SCROLL_EVENT = 'proma:session-tree-scroll'

export interface SessionTreeNavigatedEventDetail {
  sessionId: string
  node: SessionTreeNode
  editorText?: string
  abortedRun: boolean
}

export interface SessionTreeScrollEventDetail {
  sessionId: string
  node: SessionTreeNode
}

interface SessionTreeDocumentLike {
  querySelectorAll: (selector: string) => ArrayLike<HTMLElement>
}

/** 根据树节点的活跃分支消息序号定位当前会话消息；浮窗通过 portal 渲染也不影响查找。 */
export function scrollSessionTreeMessageIntoView(
  sessionId: string,
  messageIndex: number,
  documentLike: SessionTreeDocumentLike = document,
): boolean {
  const sessionRoot = Array.from(documentLike.querySelectorAll('[data-agent-session-id]'))
    .find((element) => element.dataset.agentSessionId === sessionId)
  const message = sessionRoot?.querySelectorAll<HTMLElement>('[data-message-role]')[messageIndex]
  if (!message) return false
  message.scrollIntoView({ behavior: 'smooth', block: 'center' })
  return true
}

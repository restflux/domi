import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { SideChatView } from '@domi/shared'
import { setAgentSessionSidePanelOpenAtom, agentDiffPanelTabAtom, agentStreamingStatesAtom, liveMessagesMapAtom } from './agent-atoms'
import { mergeAgentMessageTimeline } from '@/lib/agent-message-timeline'
import type { SetStateAction } from 'react'
import { activateSessionRightWorkspaceTab, rightWorkspaceSessionStateMapAtom } from './right-workspace-atoms'

/**
 * ZCode 式多开侧聊状态：
 * - children：父会话下按创建顺序排列的子会话视图（持久事实来自主进程）
 * - activeChild：当前聚焦的子会话（划选入口复用它，/side 强制新开）
 * - draft/images：按子会话隔离的草稿，切换 tab 不丢内容
 */
export interface SideChatDraft {
  text: string
  model: { channelId: string; modelId: string } | null
  focusRevision: number
}
export const sideChatDraftAtomFamily = atomFamily((_childSessionId: string) => atom<SideChatDraft>({ text: '', model: null, focusRevision: 0 }))
export const sideChatChildrenMapAtom = atom(new Map<string, SideChatView[]>())
export const sideChatActiveChildMapAtom = atom(new Map<string, string>())

export function applySideChatChildrenList(
  current: Map<string, SideChatView[]>,
  parentSessionId: string,
  views: SideChatView[],
): Map<string, SideChatView[]> {
  const next = new Map(current)
  if (views.length > 0) next.set(parentSessionId, views)
  else next.delete(parentSessionId)
  return next
}

export const setActiveSideChatChildAtom = atom(null, (get, set, input: { parentSessionId: string; childSessionId: string }) => {
  const children = get(sideChatChildrenMapAtom).get(input.parentSessionId) ?? []
  if (!children.some(view => view.sessionId === input.childSessionId)) return
  set(sideChatActiveChildMapAtom, new Map(get(sideChatActiveChildMapAtom)).set(input.parentSessionId, input.childSessionId))
})

/** 子会话级流式帧终局归档：在全局监听器释放实时帧前合并进对应子会话视图。 */
export const retainCompletedSideChatAtom = atom(null, (get, set, input: { sessionId: string; startedAt?: number }) => {
  const state = get(agentStreamingStatesAtom).get(input.sessionId)
  if (state?.running || state?.backgroundWaiting || (state?.startedAt != null && (input.startedAt == null || state.startedAt > input.startedAt))) return
  const live = get(liveMessagesMapAtom).get(input.sessionId) ?? []
  let touched = false
  const nextChildren = new Map(get(sideChatChildrenMapAtom))
  for (const [parentId, views] of nextChildren) {
    const index = views.findIndex(view => view.sessionId === input.sessionId)
    if (index === -1) continue
    const view = views[index]!
    const merged = { ...view, messages: mergeAgentMessageTimeline(view.messages, live), isRunning: false }
    nextChildren.set(parentId, views.map((item, i) => (i === index ? merged : item)))
    touched = true
  }
  if (touched) {
    set(sideChatChildrenMapAtom, nextChildren)
    // 让终态到达前发起的历史请求失效，防止旧 partial/运行态覆盖最终正文。
    set(sideChatOperationAtomFamily(input.sessionId), (current) => ({ ...current, revision: current.revision + 1 }))
  }
})
export const sideChatOperationAtomFamily = atomFamily((_childSessionId: string) => atom({ sending: false, revision: 0 }))
export const sideChatVisibleMapAtom = atom(new Map<string, boolean>())
export const sideChatHandoffAtomFamily = atomFamily((_parentId: string) => atom<{ send: (text: string) => Promise<void> } | null>(null))

/**
 * 入口只聚焦面板（可选强制新开子会话），绝不自动发送；
 * 选区引用由调用方通过 side-chat-selections 写入目标 scope。
 */
export const openSideChatPanelAtom = atom(null, (get, set, input: { parentSessionId: string; forceNew?: boolean }) => {
  const id = input.parentSessionId
  set(sideChatVisibleMapAtom, new Map(get(sideChatVisibleMapAtom)).set(id, true))
  // 聚焦意图由同步器（RightSidePanel 轮询）消费：激活对应实例 tab 并聚焦输入。
  set(sideChatPendingFocusAtom, new Map(get(sideChatPendingFocusAtom)).set(id, true))
  set(setAgentSessionSidePanelOpenAtom, { sessionId: id, open: true })
  set(agentDiffPanelTabAtom, new Map(get(agentDiffPanelTabAtom)).set(id, 'chat'))
  // 先回到侧聊工具面；同步器随后精确激活到活动子会话的实例 tab。
  set(rightWorkspaceSessionStateMapAtom, activateSessionRightWorkspaceTab(get(rightWorkspaceSessionStateMapAtom), id, 'side-chat'))
  if (input.forceNew) {
    set(sideChatPendingForceNewAtom, new Map(get(sideChatPendingForceNewAtom)).set(id, true))
  }
})
/** 面板消费后清除；避免轮询重开时重复创建。 */
export const sideChatPendingForceNewAtom = atom(new Map<string, boolean>())
/** 打开/聚焦意图；同步器在列表刷新后激活对应实例 tab。 */
export const sideChatPendingFocusAtom = atom(new Map<string, boolean>())

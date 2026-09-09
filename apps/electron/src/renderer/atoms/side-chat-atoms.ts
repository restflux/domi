import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { SideChatView } from '@domi/shared'
import { agentSidePanelOpenAtom, agentDiffPanelTabAtom, agentStreamingStatesAtom, liveMessagesMapAtom } from './agent-atoms'
import { mergeAgentMessageTimeline } from '@/lib/agent-message-timeline'
import type { SetStateAction } from 'react'
import { activateSessionRightWorkspaceTab, rightWorkspaceSessionStateMapAtom } from './right-workspace-atoms'

export interface SideChatDraft {
  text: string
  quotedText: string
  model: { channelId: string; modelId: string } | null
  focusRevision: number
}
export const sideChatDraftAtomFamily = atomFamily((_parentId: string) => atom<SideChatDraft>({ text: '', quotedText: '', model: null, focusRevision: 0 }))
const sideChatViewsAtom = atom(new Map<string, SideChatView>())
export const sideChatViewAtomFamily = atomFamily((parentId: string) => atom(
  (get) => get(sideChatViewsAtom).get(parentId) ?? null,
  (get, set, update: SetStateAction<SideChatView | null>) => {
    const previous = get(sideChatViewsAtom)
    const view = typeof update === 'function' ? update(previous.get(parentId) ?? null) : update
    const next = new Map(previous)
    if (view) next.set(parentId, view)
    else next.delete(parentId)
    set(sideChatViewsAtom, next)
  },
))

/** 在全局监听器释放实时帧前交给侧聊历史；不依赖面板挂载或当前主会话。 */
export const retainCompletedSideChatAtom = atom(null, (get, set, input: { sessionId: string; startedAt?: number }) => {
  const state = get(agentStreamingStatesAtom).get(input.sessionId)
  if (state?.running || state?.backgroundWaiting || (state?.startedAt != null && (input.startedAt == null || state.startedAt > input.startedAt))) return
  for (const [parentId, view] of get(sideChatViewsAtom)) {
    if (view.sessionId !== input.sessionId) continue
    const live = get(liveMessagesMapAtom).get(input.sessionId) ?? []
    set(sideChatViewAtomFamily(parentId), { ...view, messages: mergeAgentMessageTimeline(view.messages, live), isRunning: false })
    // 让终态到达前发起的历史请求失效，防止旧 partial/运行态覆盖最终正文。
    set(sideChatOperationAtomFamily(parentId), (current) => ({ ...current, revision: current.revision + 1 }))
  }
})
export const sideChatOperationAtomFamily = atomFamily((_parentId: string) => atom({ sending: false, revision: 0 }))
export const sideChatVisibleMapAtom = atom(new Map<string, boolean>())
export const sideChatHandoffAtomFamily = atomFamily((_parentId: string) => atom<{ send: (text: string) => Promise<void> } | null>(null))

/** 入口只带入引用并聚焦，绝不自动发送，也不创建普通 Chat conversation。 */
export const openSideChatPanelAtom = atom(null, (get, set, input: { parentSessionId: string; quotedText?: string }) => {
  const id = input.parentSessionId
  set(sideChatVisibleMapAtom, new Map(get(sideChatVisibleMapAtom)).set(id, true))
  set(sideChatDraftAtomFamily(id), (draft) => ({ ...draft, ...(input.quotedText !== undefined ? { quotedText: input.quotedText } : {}), focusRevision: draft.focusRevision + 1 }))
  set(agentSidePanelOpenAtom, true)
  set(agentDiffPanelTabAtom, new Map(get(agentDiffPanelTabAtom)).set(id, 'chat'))
  set(rightWorkspaceSessionStateMapAtom, activateSessionRightWorkspaceTab(get(rightWorkspaceSessionStateMapAtom), id, 'side-chat'))
})

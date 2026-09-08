import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { SideChatView } from '@domi/shared'
import { agentSidePanelOpenAtom, agentDiffPanelTabAtom } from './agent-atoms'
import { activateSessionRightWorkspaceTab, rightWorkspaceSessionStateMapAtom } from './right-workspace-atoms'

export interface SideChatDraft {
  text: string
  quotedText: string
  model: { channelId: string; modelId: string } | null
  focusRevision: number
}
export const sideChatDraftAtomFamily = atomFamily((_parentId: string) => atom<SideChatDraft>({ text: '', quotedText: '', model: null, focusRevision: 0 }))
export const sideChatViewAtomFamily = atomFamily((_parentId: string) => atom<SideChatView | null>(null))
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

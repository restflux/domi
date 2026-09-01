import { atom } from 'jotai'
import type { BrowserSessionView, BrowserStateChange } from '@domi/shared'
import { currentAgentSessionIdAtom } from './agent-atoms'

/** Browser Session 状态按实例 ID 保存；同一 Work Session 可以同时拥有多个 Main-owned 页面。 */
export const browserStateMapAtom = atom<Map<string, BrowserSessionView>>(new Map())

export const currentSessionBrowserStatesAtom = atom<BrowserSessionView[]>((get) => {
  const sessionId = get(currentAgentSessionIdAtom)
  if (!sessionId) return []
  return [...get(browserStateMapAtom).values()].filter((state) => state.ownerSessionId === sessionId)
})

/** 兼容只需要“当前 Session 是否有 Browser”的旧读取点。 */
export const currentSessionBrowserStateAtom = atom<BrowserSessionView | null>((get) => {
  return get(currentSessionBrowserStatesAtom).at(-1) ?? null
})

export function getOwnerBrowserStates(
  current: Map<string, BrowserSessionView>,
  ownerSessionId: string,
): BrowserSessionView[] {
  return [...current.values()].filter((state) => state.ownerSessionId === ownerSessionId)
}

export function shouldAutoOpenBrowserPanel(state: BrowserSessionView): boolean {
  return state.control !== null
}

export function applyBrowserStateChange(
  current: Map<string, BrowserSessionView>,
  change: BrowserStateChange,
): Map<string, BrowserSessionView> {
  const next = new Map(current)
  if ('closed' in change) next.delete(change.browserSessionId)
  else next.set(change.browserSessionId, change)
  return next
}

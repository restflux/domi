import { atom } from 'jotai'

/** 每个 Agent 会话独立的 Session Tree 非模态浮窗开关。 */
export const sessionTreeOpenMapAtom = atom<Map<string, boolean>>(new Map())

export function isSessionTreeOpen(state: Map<string, boolean>, sessionId: string): boolean {
  return state.get(sessionId) ?? false
}

export function setSessionTreeOpen(
  state: Map<string, boolean>,
  sessionId: string,
  open: boolean,
): Map<string, boolean> {
  const next = new Map(state)
  next.set(sessionId, open)
  return next
}

export function toggleSessionTreeOpen(
  state: Map<string, boolean>,
  sessionId: string,
): Map<string, boolean> {
  return setSessionTreeOpen(state, sessionId, !isSessionTreeOpen(state, sessionId))
}

export function closeSessionTreeForEscape(
  state: Map<string, boolean>,
  sessionId: string,
): { handled: boolean; state: Map<string, boolean> } {
  if (!isSessionTreeOpen(state, sessionId)) return { handled: false, state }
  return { handled: true, state: setSessionTreeOpen(state, sessionId, false) }
}

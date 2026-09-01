import { atom } from 'jotai'
import type { TerminalSessionView, TerminalStateChange } from '@domi/shared'
import { currentAgentSessionIdAtom } from './agent-atoms.ts'

export const terminalStateMapAtom = atom<Map<string, TerminalSessionView>>(new Map())
/** TerminalRun 输出中识别出的本地服务地址，按终端隔离。 */
export const terminalServiceUrlsMapAtom = atom<Map<string, string[]>>(new Map())
export const terminalDockOpenMapAtom = atom<Map<string, boolean>>(new Map())
export const terminalActiveIdMapAtom = atom<Map<string, string>>(new Map())

export const currentSessionTerminalsAtom = atom<TerminalSessionView[]>((get) => {
  const sessionId = get(currentAgentSessionIdAtom)
  if (!sessionId) return []
  return [...get(terminalStateMapAtom).values()]
    .filter((terminal) => terminal.ownerSessionId === sessionId)
    .sort((left, right) => left.startedAt - right.startedAt)
})

export function applyTerminalStateChange(
  current: Map<string, TerminalSessionView>,
  change: TerminalStateChange,
): Map<string, TerminalSessionView> {
  const next = new Map(current)
  if ('closed' in change) next.delete(change.terminalId)
  else next.set(change.terminalId, change)
  return next
}

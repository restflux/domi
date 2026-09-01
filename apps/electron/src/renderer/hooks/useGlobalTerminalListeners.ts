import * as React from 'react'
import { useStore } from 'jotai'
import type { TerminalStateChange } from '@domi/shared'
import {
  applyTerminalStateChange,
  terminalActiveIdMapAtom,
  terminalDockOpenMapAtom,
  terminalServiceUrlsMapAtom,
  terminalStateMapAtom,
} from '@/atoms/terminal-atoms.ts'
import {
  accumulateTerminalServiceOutput,
  type TerminalServiceOutputState,
} from '@/components/terminal/running-terminals-model.ts'

export function useGlobalTerminalListeners(): void {
  const store = useStore()
  const serviceOutputStatesRef = React.useRef(new Map<string, TerminalServiceOutputState>())

  React.useEffect(() => {
    const clearServiceOutput = (terminalId: string): void => {
      serviceOutputStatesRef.current.delete(terminalId)
      store.set(terminalServiceUrlsMapAtom, (current) => {
        if (!current.has(terminalId)) return current
        const next = new Map(current)
        next.delete(terminalId)
        return next
      })
    }

    const disposeOutput = window.electronAPI.terminal.onOutput((event) => {
      const terminal = store.get(terminalStateMapAtom).get(event.terminalId)
      if (terminal?.kind !== 'agent-run') return

      const previous = serviceOutputStatesRef.current.get(event.terminalId)
      const nextOutput = accumulateTerminalServiceOutput(previous, event.data)
      serviceOutputStatesRef.current.set(event.terminalId, nextOutput)
      if (nextOutput.urls.length === 0 || nextOutput.urls === previous?.urls) return

      store.set(terminalServiceUrlsMapAtom, (current) => {
        const urls = [...new Set([...(current.get(event.terminalId) ?? []), ...nextOutput.urls])]
        return new Map(current).set(event.terminalId, urls)
      })
    })

    const disposeState = window.electronAPI.terminal.onStateChanged((change: TerminalStateChange) => {
      store.set(terminalStateMapAtom, (current) => applyTerminalStateChange(current, change))
      if ('closed' in change) {
        clearServiceOutput(change.terminalId)
        store.set(terminalActiveIdMapAtom, (current) => {
          if (current.get(change.ownerSessionId) !== change.terminalId) return current
          const nextTerminal = [...store.get(terminalStateMapAtom).values()]
            .find((terminal) => terminal.ownerSessionId === change.ownerSessionId)
          const next = new Map(current)
          if (nextTerminal) next.set(change.ownerSessionId, nextTerminal.terminalId)
          else next.delete(change.ownerSessionId)
          return next
        })
        return
      }

      if (change.status === 'starting') {
        if (change.kind === 'agent-run') clearServiceOutput(change.terminalId)
        store.set(terminalDockOpenMapAtom, (current) => new Map(current).set(change.ownerSessionId, true))
        store.set(terminalActiveIdMapAtom, (current) => {
          const activeId = current.get(change.ownerSessionId)
          const active = activeId ? store.get(terminalStateMapAtom).get(activeId) : undefined
          if (change.kind === 'agent-run' && active?.kind === 'user-shell' && active.status === 'running') return current
          return new Map(current).set(change.ownerSessionId, change.terminalId)
        })
      }
    })

    return () => {
      disposeOutput()
      disposeState()
    }
  }, [store])
}

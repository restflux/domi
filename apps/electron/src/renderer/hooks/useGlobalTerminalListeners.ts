import * as React from 'react'
import { useStore } from 'jotai'
import type { TerminalSessionView, TerminalStateChange } from '@domi/shared'
import {
  applyTerminalStateChange,
  terminalActiveIdMapAtom,
  terminalDockOpenMapAtom,
  terminalServiceUrlsMapAtom,
  terminalShellLabelMapAtom,
  terminalStateMapAtom,
} from '@/atoms/terminal-atoms.ts'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms.ts'
import {
  accumulateTerminalServiceOutput,
  type TerminalServiceOutputState,
} from '@/components/terminal/running-terminals-model.ts'
import { selectDockTerminals } from '@/components/terminal/terminal-dock-model.ts'
import {
  activateSessionRightWorkspaceTab,
  rightWorkspaceFocusAtom,
  rightWorkspaceOpenAtom,
  rightWorkspaceSessionStateMapAtom,
} from '@/atoms/right-workspace-atoms.ts'
import { terminalTabId } from '@/lib/right-workspace-model.ts'
import { sidePaneTerminalSessionRegistry } from '@/components/terminal/v2/zcode/ZCodeSessionRegistry.ts'
import {
  reconcileClosedWorkspaceFocus,
  reconcileClosedWorkspaceTerminal,
  reduceTerminalPanelState,
} from '@/components/terminal/v2/terminal-panel-state.ts'

/** Agent 终端只更新运行状态；只有手动 Shell 创建才切换面板和焦点。 */
export function applyTerminalStartPresentation(store: ReturnType<typeof useStore>, terminal: TerminalSessionView): void {
  if (terminal.kind === 'agent-run') return

  if (terminal.presentation === 'workspace') {
    store.set(rightWorkspaceSessionStateMapAtom, (current) => (
      activateSessionRightWorkspaceTab(current, terminal.ownerSessionId, terminalTabId(terminal.terminalId))
    ))
    if (store.get(currentAgentSessionIdAtom) === terminal.ownerSessionId) {
      store.set(rightWorkspaceOpenAtom, true)
    }
    return
  }

  store.set(terminalDockOpenMapAtom, (current) => new Map(current).set(terminal.ownerSessionId, true))
  store.set(terminalActiveIdMapAtom, (current) => new Map(current).set(terminal.ownerSessionId, terminal.terminalId))
}

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
      const previousState = store.get(terminalStateMapAtom)
      store.set(terminalStateMapAtom, (current) => applyTerminalStateChange(current, change))
      if ('closed' in change) {
        sidePaneTerminalSessionRegistry.release(JSON.stringify([change.ownerSessionId, change.terminalId]))
        clearServiceOutput(change.terminalId)
        store.set(terminalShellLabelMapAtom, (current) => {
          if (!current.has(change.terminalId)) return current
          const next = new Map(current)
          next.delete(change.terminalId)
          return next
        })
        const previousDockTerminals = selectDockTerminals(previousState.values(), change.ownerSessionId)
        const remainingDockTerminals = selectDockTerminals(store.get(terminalStateMapAtom).values(), change.ownerSessionId)
        const remainingWorkspaceTerminalIds = Array.from(store.get(terminalStateMapAtom).values())
          .filter((terminal) => terminal.ownerSessionId === change.ownerSessionId && terminal.presentation === 'workspace' && terminal.terminalId !== change.terminalId)
          .map((terminal) => terminal.terminalId)
        store.set(rightWorkspaceSessionStateMapAtom, (current) => {
          const currentState = current.get(change.ownerSessionId)
          if (!currentState) return current
          const nextState = reconcileClosedWorkspaceTerminal(currentState, change.terminalId, remainingWorkspaceTerminalIds)
          if (nextState === currentState) return current
          const next = new Map(current)
          next.set(change.ownerSessionId, nextState)
          return next
        })
        store.set(rightWorkspaceFocusAtom, (current) => (
          reconcileClosedWorkspaceFocus(current, change.ownerSessionId, change.terminalId, remainingWorkspaceTerminalIds)
        ))
        store.set(terminalDockOpenMapAtom, (current) => {
          // 上游 exitTerminalSession：当前 workspace 最后一个 tab 的 PTY 退出时收起面板；
          // 进程已死，没有可保活的 session，面板重新打开时由懒创建新终端。
          if (remainingDockTerminals.length > 0) return current
          if (!(current.get(change.ownerSessionId) ?? false)) return current
          return new Map(current).set(change.ownerSessionId, false)
        })
        store.set(terminalActiveIdMapAtom, (current) => {
          const nextPanelState = reduceTerminalPanelState(
            { open: store.get(terminalDockOpenMapAtom).get(change.ownerSessionId) ?? false, activeTerminalId: current.get(change.ownerSessionId) },
            {
              type: 'close-session',
              terminalId: change.terminalId,
              previousIds: previousDockTerminals.map((terminal) => terminal.terminalId),
              remainingIds: remainingDockTerminals.map((terminal) => terminal.terminalId),
            },
          )
          const next = new Map(current)
          if (nextPanelState.activeTerminalId) next.set(change.ownerSessionId, nextPanelState.activeTerminalId)
          else next.delete(change.ownerSessionId)
          return next
        })
        return
      }

      if (change.status === 'starting') {
        if (change.kind === 'agent-run') clearServiceOutput(change.terminalId)
        applyTerminalStartPresentation(store, change)
      }
    })

    return () => {
      disposeOutput()
      disposeState()
    }
  }, [store])
}

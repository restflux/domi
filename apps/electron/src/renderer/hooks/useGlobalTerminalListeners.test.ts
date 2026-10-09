import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { TerminalSessionView } from '@domi/shared'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms.ts'
import {
  activateSessionRightWorkspaceTab,
  rightWorkspaceOpenAtom,
  rightWorkspaceSessionStateMapAtom,
} from '@/atoms/right-workspace-atoms.ts'
import { terminalActiveIdMapAtom, terminalDockOpenMapAtom } from '@/atoms/terminal-atoms.ts'
import { applyTerminalStartPresentation } from './useGlobalTerminalListeners.ts'

const terminal = (kind: TerminalSessionView['kind'], presentation: TerminalSessionView['presentation']): TerminalSessionView => ({
  terminalId: 'new', ownerSessionId: 'owner', kind, presentation,
  title: 'Dev', cwd: '/repo', profile: 'bash', status: 'starting', startedAt: 1,
})

describe('终端启动展示', () => {
  for (const open of [false, true]) {
    for (const presentation of ['workspace', 'dock'] as const) {
      test(`Agent 启动 ${presentation} 终端时保留面板展开状态 ${open} 和当前标签`, () => {
        const store = createStore()
        store.set(currentAgentSessionIdAtom, 'owner')
        store.set(rightWorkspaceOpenAtom, open)
        store.set(rightWorkspaceSessionStateMapAtom, activateSessionRightWorkspaceTab(new Map(), 'owner', 'scratch'))
        store.set(terminalDockOpenMapAtom, new Map([['owner', open]]))
        store.set(terminalActiveIdMapAtom, new Map([['owner', 'manual']]))
        const workspaceState = store.get(rightWorkspaceSessionStateMapAtom)
        const dockState = store.get(terminalDockOpenMapAtom)
        const activeState = store.get(terminalActiveIdMapAtom)

        applyTerminalStartPresentation(store, terminal('agent-run', presentation))

        expect(store.get(rightWorkspaceOpenAtom)).toBe(open)
        expect(store.get(rightWorkspaceSessionStateMapAtom)).toBe(workspaceState)
        expect(store.get(terminalDockOpenMapAtom)).toBe(dockState)
        expect(store.get(terminalActiveIdMapAtom)).toBe(activeState)
      })
    }
  }

  test('用户手动创建侧栏终端时仍展开并激活终端', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'owner')
    store.set(rightWorkspaceOpenAtom, false)
    applyTerminalStartPresentation(store, terminal('user-shell', 'workspace'))
    expect(store.get(rightWorkspaceOpenAtom)).toBe(true)
    expect(store.get(rightWorkspaceSessionStateMapAtom)).toEqual(
      activateSessionRightWorkspaceTab(new Map(), 'owner', 'terminal:new'),
    )
  })

  test('其他会话创建手动终端不展开当前侧栏', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'other')
    store.set(rightWorkspaceOpenAtom, false)
    applyTerminalStartPresentation(store, terminal('user-shell', 'workspace'))
    expect(store.get(rightWorkspaceOpenAtom)).toBe(false)
  })

  test('用户手动创建 Dock 终端时仍展开并激活终端', () => {
    const store = createStore()
    applyTerminalStartPresentation(store, terminal('user-shell', 'dock'))
    expect(store.get(terminalDockOpenMapAtom).get('owner')).toBe(true)
    expect(store.get(terminalActiveIdMapAtom).get('owner')).toBe('new')
  })
})

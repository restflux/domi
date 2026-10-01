import { expect, test } from 'bun:test'
import type { TerminalSessionView } from '@domi/shared'
import {
  createInitialTerminalPanelState,
  getDockPanelState,
  reconcileClosedWorkspaceFocus,
  reconcileClosedWorkspaceTerminal,
  reduceTerminalPanelState,
} from './terminal-panel-state.ts'

const terminal = (terminalId: string, ownerSessionId = 'owner'): TerminalSessionView => ({
  terminalId,
  ownerSessionId,
  kind: 'user-shell',
  presentation: 'dock',
  title: terminalId,
  cwd: '/tmp',
  profile: 'bash',
  status: 'running',
  startedAt: Number(terminalId.slice(-1)) || 1,
})

test('Given a closed panel When a session is created Then the panel reopens and activates that session', () => {
  const next = reduceTerminalPanelState(createInitialTerminalPanelState(), { type: 'create', terminalId: 'one' })
  expect(next).toEqual({ open: true, activeTerminalId: 'one' })
})

test('Given an active tab When another tab closes Then the previous tab remains active', () => {
  const state = { open: true, activeTerminalId: 'two' }
  const next = reduceTerminalPanelState(state, {
    type: 'close-session',
    terminalId: 'two',
    previousIds: ['one', 'two', 'three'],
    remainingIds: ['one', 'three'],
  })
  expect(next).toEqual({ open: true, activeTerminalId: 'one' })
})

test('Given a stale active tab When the service snapshot is refreshed Then it falls back without reopening a collapsed panel', () => {
  const next = getDockPanelState(
    { open: false, activeTerminalId: 'gone' },
    [terminal('one'), terminal('other', 'another-owner')],
    'owner',
  )
  expect(next).toEqual({ open: false, activeTerminalId: 'one' })
})

test('Given a selected tab When the panel is closed and reopened Then the selection is retained', () => {
  const closed = reduceTerminalPanelState({ open: true, activeTerminalId: 'two' }, { type: 'close-panel' })
  const reopened = reduceTerminalPanelState(closed, { type: 'open' })
  expect(reopened).toEqual({ open: true, activeTerminalId: 'two' })
})

test('Given a terminal outside the owner When the snapshot is refreshed Then it cannot become active', () => {
  const next = getDockPanelState(
    { open: true, activeTerminalId: 'gone' },
    [terminal('other', 'another-owner')],
    'owner',
  )
  expect(next).toEqual({ open: true, activeTerminalId: undefined })
})

test('Given the right workspace is showing a closed terminal When its PTY exits Then it falls back to the previous tool', () => {
  const next = reconcileClosedWorkspaceTerminal(
    {
      activeTool: 'terminal',
      activeTabId: 'terminal:closed',
      previousTool: 'files',
      previousTabId: 'changes',
    },
    'closed',
    [],
  )
  expect(next.activeTool).toBe('changes')
  expect(next.activeTabId).toBe('changes')
})

test('Given a focused terminal tab When that PTY closes Then focus follows the remaining terminal', () => {
  const next = reconcileClosedWorkspaceFocus(
    { sessionId: 'owner', tool: 'terminal', tabId: 'terminal:closed' },
    'owner',
    'closed',
    ['remaining'],
  )
  expect(next).toEqual({ sessionId: 'owner', tool: 'terminal', tabId: 'terminal:remaining' })
})

test('Given a focused terminal tab When its owner has no remaining PTY Then focus is cleared', () => {
  const next = reconcileClosedWorkspaceFocus(
    { sessionId: 'owner', tool: 'terminal', tabId: 'terminal:closed' },
    'owner',
    'closed',
    [],
  )
  expect(next).toBeNull()
})

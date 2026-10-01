import { describe, expect, test } from 'bun:test'
import type { TerminalSessionView } from '@domi/shared'
import {
  buildZCodeDockTerminalInput,
  countRunningTerminals,
  formatTerminalTabTitle,
  getDockTerminalCloseAction,
  getPathLeaf,
  getTerminalTabTitle,
  getZCodeTerminalTabTitle,
  resolveTerminalToggleAction,
  selectDockTerminals,
  selectWorkspaceTerminals,
  terminalStatusLabel,
} from './terminal-dock-model.ts'

const terminal = (status: TerminalSessionView['status'], exitCode?: number): TerminalSessionView => ({
  terminalId: status, ownerSessionId: 's1', kind: 'agent-run', presentation: 'workspace', title: 'Dev', cwd: '/repo',
  profile: 'bash', status, startedAt: 1, ...(exitCode === undefined ? {} : { exitCode }),
})

describe('terminal dock model', () => {
  test('底部 Dock 与右侧工作区按 presentation 隔离终端', () => {
    const manual = { ...terminal('running'), terminalId: 'manual', kind: 'user-shell' as const, presentation: 'dock' as const, startedAt: 2 }
    const workspaceShell = { ...manual, terminalId: 'workspace', presentation: 'workspace' as const }
    const otherSession = { ...manual, terminalId: 'other', ownerSessionId: 's2' }

    const terminals = [terminal('running'), workspaceShell, otherSession, manual]
    expect(selectDockTerminals(terminals, 's1')).toEqual([manual])
    expect(selectWorkspaceTerminals(terminals, 's1')).toEqual([terminal('running'), workspaceShell])
  })

  test('counts starting and running PTYs as active', () => {
    expect(countRunningTerminals([terminal('starting'), terminal('running'), terminal('exited', 0)])).toBe(2)
  })

  test('shows exit code and stale target facts', () => {
    expect(terminalStatusLabel(terminal('exited', 7))).toBe('已退出 7')
    expect(terminalStatusLabel({ ...terminal('running'), sourceTarget: { kind: 'isolated', checkoutId: 'c1', revision: 1, stale: true } })).toBe('上一轮')
  })

  test('uses the detected ZCode shell label while retaining the host title fallback', () => {
    const value = terminal('running')
    expect(getTerminalTabTitle(value, 'PowerShell')).toBe('PowerShell')
    expect(getTerminalTabTitle(value, '  ')).toBe('Dev')
    expect(getTerminalTabTitle(value)).toBe('Dev')
  })

  test('matches ZCode close semantics for the final tab', () => {
    const first = { ...terminal('running'), terminalId: 'first' }
    const second = { ...terminal('running'), terminalId: 'second' }
    expect(getDockTerminalCloseAction([first], 'first')).toBe('close-panel')
    expect(getDockTerminalCloseAction([first, second], 'first')).toBe('close-session')
    expect(getDockTerminalCloseAction([first], 'missing')).toBe('none')
  })

  test('ZCode tab titles use the project leaf and per-owner ordinal', () => {
    const domiTerminal = { ...terminal('running'), cwd: '/Users/dev/Projects/open/domi' }
    expect(getPathLeaf('/Users/dev/Projects/open/domi')).toBe('domi')
    expect(getPathLeaf('C:\\repos\\domi\\')).toBe('domi')
    expect(getPathLeaf('')).toBe('')
    expect(formatTerminalTabTitle('domi', 1)).toBe('domi')
    expect(formatTerminalTabTitle('domi', 3)).toBe('domi 3')
    expect(getZCodeTerminalTabTitle(domiTerminal, 1)).toBe('domi')
    expect(getZCodeTerminalTabTitle(domiTerminal, 2)).toBe('domi 2')
    // cwd 为空时回退宿主 title，与上游 getPathLeaf(cwd) || title 一致。
    expect(getZCodeTerminalTabTitle({ ...domiTerminal, cwd: '' }, 1)).toBe('Dev')
  })

  test('toggle shortcut resolves ZCode panel actions including lazy create', () => {
    expect(resolveTerminalToggleAction(false, false, 0)).toBe('none')
    expect(resolveTerminalToggleAction(true, true, 3)).toBe('collapse')
    expect(resolveTerminalToggleAction(true, false, 2)).toBe('open')
    expect(resolveTerminalToggleAction(true, false, 0)).toBe('open-and-create')
  })
})

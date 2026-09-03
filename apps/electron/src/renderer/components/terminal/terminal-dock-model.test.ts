import { describe, expect, test } from 'bun:test'
import type { TerminalSessionView } from '@domi/shared'
import { countRunningTerminals, selectManualTerminals, terminalStatusLabel } from './terminal-dock-model.ts'

const terminal = (status: TerminalSessionView['status'], exitCode?: number): TerminalSessionView => ({
  terminalId: status, ownerSessionId: 's1', kind: 'agent-run', title: 'Dev', cwd: '/repo',
  profile: 'bash', status, startedAt: 1, ...(exitCode === undefined ? {} : { exitCode }),
})

describe('terminal dock model', () => {
  test('底部 Dock 只选择当前会话的手动 Shell', () => {
    const manual = { ...terminal('running'), terminalId: 'manual', kind: 'user-shell' as const, startedAt: 2 }
    const otherSession = { ...manual, terminalId: 'other', ownerSessionId: 's2' }

    expect(selectManualTerminals([terminal('running'), otherSession, manual], 's1')).toEqual([manual])
  })

  test('counts starting and running PTYs as active', () => {
    expect(countRunningTerminals([terminal('starting'), terminal('running'), terminal('exited', 0)])).toBe(2)
  })

  test('shows exit code and stale target facts', () => {
    expect(terminalStatusLabel(terminal('exited', 7))).toBe('已退出 7')
    expect(terminalStatusLabel({ ...terminal('running'), sourceTarget: { kind: 'isolated', checkoutId: 'c1', revision: 1, stale: true } })).toBe('上一轮')
  })
})

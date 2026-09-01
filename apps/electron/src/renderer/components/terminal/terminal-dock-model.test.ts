import { describe, expect, test } from 'bun:test'
import type { TerminalSessionView } from '@domi/shared'
import { countRunningTerminals, terminalStatusLabel } from './terminal-dock-model.ts'

const terminal = (status: TerminalSessionView['status'], exitCode?: number): TerminalSessionView => ({
  terminalId: status, ownerSessionId: 's1', kind: 'agent-run', title: 'Dev', cwd: '/repo',
  profile: 'bash', status, startedAt: 1, ...(exitCode === undefined ? {} : { exitCode }),
})

describe('terminal dock model', () => {
  test('counts starting and running PTYs as active', () => {
    expect(countRunningTerminals([terminal('starting'), terminal('running'), terminal('exited', 0)])).toBe(2)
  })

  test('shows exit code and stale target facts', () => {
    expect(terminalStatusLabel(terminal('exited', 7))).toBe('已退出 7')
    expect(terminalStatusLabel({ ...terminal('running'), sourceTarget: { kind: 'isolated', checkoutId: 'c1', revision: 1, stale: true } })).toBe('上一轮')
  })
})

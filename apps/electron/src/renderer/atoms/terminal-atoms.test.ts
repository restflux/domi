import { describe, expect, test } from 'bun:test'
import type { TerminalSessionView } from '@domi/shared'
import { applyTerminalStateChange } from './terminal-atoms.ts'

const running: TerminalSessionView = {
  terminalId: 't1', ownerSessionId: 's1', kind: 'agent-run', presentation: 'workspace', title: 'Dev', cwd: '/repo',
  profile: 'bash', status: 'running', startedAt: 1,
}

describe('terminal atoms', () => {
  test('upserts and removes Main-owned terminal projections', () => {
    const added = applyTerminalStateChange(new Map(), running)
    expect(added.get('t1')).toEqual(running)
    const removed = applyTerminalStateChange(added, { terminalId: 't1', ownerSessionId: 's1', closed: true })
    expect(removed.has('t1')).toBe(false)
    expect(added.has('t1')).toBe(true)
  })
})

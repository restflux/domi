import { describe, expect, test } from 'bun:test'
import { normalizeToolAction } from './tool-action-normalizer.ts'

describe('normalizeToolAction TerminalRun', () => {
  test('treats TerminalRun as the same shell action as Bash', () => {
    expect(normalizeToolAction('TerminalRun', { command: 'bun run dev', cwd: 'apps/electron' })).toEqual({
      kind: 'shell',
      command: 'bun run dev',
      paths: ['apps/electron'],
    })
  })
})

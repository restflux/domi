import { describe, expect, test } from 'bun:test'
import { getSlashCommand, resolveSlashMenuItems } from './registry'
import { registerBuiltinSlashCommands } from './builtin-session'
import type { SlashCommandContext } from './types'

const ctx: SlashCommandContext = {
  sessionId: 'session-plan',
  getState: <T>() => undefined as T,
  workspaceSlug: 'domi',
  isStreaming: false,
}

describe('builtin /plan command', () => {
  registerBuiltinSlashCommands()

  test('appears in the command menu as an insert command for the current task', () => {
    const item = resolveSlashMenuItems('plan', { skills: [], ctx })
      .find((candidate) => candidate.kind === 'command' && candidate.id === 'plan')

    expect(item).toMatchObject({
      label: '/plan',
      name: '本次先规划，批准后执行',
      description: '本次先规划，批准后执行',
      behavior: 'insert',
      insertText: '/plan ',
    })
  })

  test('does not route /plan through the persistent workflow switch host', () => {
    expect(getSlashCommand('plan')).toMatchObject({
      behavior: 'insert',
      insertText: '/plan ',
    })
    expect(getSlashCommand('plan')?.execute).toBeUndefined()
  })

  test('/workflow remains the two-mode persistent picker', () => {
    expect(getSlashCommand('workflow')).toMatchObject({
      description: '研究 / 执行',
      behavior: 'execute',
    })
  })
})

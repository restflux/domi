import { describe, expect, test } from 'bun:test'
import { markAgentIslandViewed } from './agent-island-viewed-state'

describe('Agent Island viewed completion state', () => {
  test('clears unread attention for a completed session', () => {
    const state = { phase: 'completed' as const, unread: true, attention: true }

    expect(markAgentIslandViewed(state)).toBe(true)
    expect(state).toEqual({ phase: 'completed', unread: false, attention: false })
  })

  test.each(['error', 'needs-interaction', 'running'] as const)(
    'preserves %s attention when the main app merely views the session',
    (phase) => {
      const state = { phase, unread: true, attention: true }

      expect(markAgentIslandViewed(state)).toBe(false)
      expect(state).toEqual({ phase, unread: true, attention: true })
    },
  )

  test('is idempotent for an already viewed completion', () => {
    const state = { phase: 'completed' as const, unread: false, attention: false }

    expect(markAgentIslandViewed(state)).toBe(false)
  })
})

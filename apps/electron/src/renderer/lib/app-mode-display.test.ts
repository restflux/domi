import { describe, expect, test } from 'bun:test'
import { APP_MODE_DISPLAY } from './app-mode-display'

describe('app mode display names', () => {
  test('uses Work as the user-facing name for the internal agent mode', () => {
    expect(APP_MODE_DISPLAY.agent.label).toBe('Work')
    expect(APP_MODE_DISPLAY.chat.label).toBe('Chat')
  })
})

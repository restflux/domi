import { describe, expect, test } from 'bun:test'
import { resolveBrowserProfile } from './browser-profile-policy.ts'

describe('浏览器 Profile 策略', () => {
  test('Given an interactive session When resolving a profile Then the workspace receives a stable persistent partition', () => {
    const first = resolveBrowserProfile({ workspaceId: 'workspace-1', source: 'interactive' })
    const second = resolveBrowserProfile({ workspaceId: 'workspace-1', source: 'interactive' })
    const other = resolveBrowserProfile({ workspaceId: 'workspace-2', source: 'interactive' })

    expect(first).toEqual(second)
    expect(first.kind).toBe('project')
    expect(first.partition.startsWith('persist:domi-browser-')).toBe(true)
    expect(first.partition).not.toBe(other.partition)
    expect(first.partition).not.toContain('workspace-1')
  })

  test('Given automation or delegation sessions When resolving a profile Then each run receives an isolated temporary partition', () => {
    const automation = resolveBrowserProfile({ workspaceId: 'workspace-1', source: 'automation', ownerSessionId: 'session-a' })
    const delegation = resolveBrowserProfile({ workspaceId: 'workspace-1', source: 'delegation', ownerSessionId: 'session-b' })

    expect(automation.kind).toBe('temporary')
    expect(delegation.kind).toBe('temporary')
    expect(automation.partition.startsWith('domi-browser-temp-')).toBe(true)
    expect(automation.partition).not.toBe(delegation.partition)
  })
})

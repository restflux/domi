import { describe, expect, test } from 'bun:test'
import type { BrowserSessionView } from '@domi/shared'
import { applyBrowserStateChange, getOwnerBrowserStates, shouldAutoOpenBrowserPanel } from './browser-atoms.ts'

const state: BrowserSessionView = {
  browserSessionId: 'browser-1',
  ownerSessionId: 'session-1',
  workspaceId: 'workspace-1',
  profileKind: 'project',
  control: null,
  page: null,
}

describe('浏览器 renderer 状态投影', () => {
  test('同一 owner 的多个 Browser 按实例 ID 共存', () => {
    const second = { ...state, browserSessionId: 'browser-2' }
    const firstResult = applyBrowserStateChange(new Map(), state)
    const result = applyBrowserStateChange(firstResult, second)

    expect(result.get('browser-1')).toEqual(state)
    expect(result.get('browser-2')).toEqual(second)
    expect(getOwnerBrowserStates(result, 'session-1')).toEqual([state, second])
  })

  test('Given an Agent-controlled browser When state changes Then its panel is marked open for that session', () => {
    expect(shouldAutoOpenBrowserPanel({
      ...state,
      control: {
        runId: 'run-1', sessionId: 'session-1', source: 'agent', displayName: 'Domi Agent', startedAt: 1, stoppable: true,
      },
    })).toBe(true)
    expect(shouldAutoOpenBrowserPanel(state)).toBe(false)
  })

  test('关闭事件只删除对应 Browser 实例，不影响同 owner 的其他标签', () => {
    const other = { ...state, browserSessionId: 'browser-2' }
    const current = new Map([['browser-1', state], ['browser-2', other]])

    const result = applyBrowserStateChange(current, {
      browserSessionId: 'browser-1', ownerSessionId: 'session-1', closed: true,
    })

    expect(result.has('browser-1')).toBe(false)
    expect(result.get('browser-2')).toEqual(other)
  })
})

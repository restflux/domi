import { describe, expect, test } from 'bun:test'
import { closeSessionTreeForEscape, isSessionTreeOpen, setSessionTreeOpen, toggleSessionTreeOpen } from './session-tree-atoms'

describe('Session Tree 独立浮窗状态', () => {
  test('按 session 独立打开和切换，不影响预览面板状态', () => {
    const initial = new Map<string, boolean>()
    const opened = setSessionTreeOpen(initial, 'session-a', true)
    expect(isSessionTreeOpen(initial, 'session-a')).toBe(false)
    expect(isSessionTreeOpen(opened, 'session-a')).toBe(true)
    expect(isSessionTreeOpen(opened, 'session-b')).toBe(false)
    expect(isSessionTreeOpen(toggleSessionTreeOpen(opened, 'session-a'), 'session-a')).toBe(false)
  })

  test('Escape 只关闭当前 session 的浮窗并报告已处理', () => {
    const opened = new Map([['session-a', true], ['session-b', true]])
    const result = closeSessionTreeForEscape(opened, 'session-a')
    expect(result.handled).toBe(true)
    expect(isSessionTreeOpen(result.state, 'session-a')).toBe(false)
    expect(isSessionTreeOpen(result.state, 'session-b')).toBe(true)
    expect(closeSessionTreeForEscape(result.state, 'session-a').handled).toBe(false)
  })
})

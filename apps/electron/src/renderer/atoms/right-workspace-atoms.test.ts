import { describe, expect, test } from 'bun:test'
import {
  activateSessionRightWorkspaceTab,
  activateSessionRightWorkspaceTool,
  closeSessionRightWorkspaceTool,
  resolveBrowserFocusEscape,
  resolveRightWorkspaceFocus,
  toggleRightWorkspaceFocus,
} from './right-workspace-atoms'

describe('Right Workspace 会话隔离', () => {
  test('激活工具只更新目标 Work Session', () => {
    const current = new Map([
      ['session-a', { activeTool: 'files' as const }],
      ['session-b', { activeTool: 'changes' as const }],
    ])

    const next = activateSessionRightWorkspaceTool(current, 'session-a', 'preview')

    expect(next.get('session-a')).toEqual({ activeTool: 'preview', previousTool: 'files' })
    expect(next.get('session-b')).toEqual({ activeTool: 'changes' })
    expect(current.get('session-a')).toEqual({ activeTool: 'files' })
  })

  test('实例标签激活记录稳定 tabId，并让草稿保持可恢复可见', () => {
    const withScratch = activateSessionRightWorkspaceTab(new Map(), 'session-a', 'scratch')
    const withBrowser = activateSessionRightWorkspaceTab(withScratch, 'session-a', 'browser:browser-2')

    expect(withScratch.get('session-a')).toEqual({
      activeTool: 'scratch',
      previousTool: 'files',
      activeTabId: 'scratch',
      previousTabId: 'files',
      scratchVisible: true,
    })
    expect(withBrowser.get('session-a')).toMatchObject({
      activeTool: 'browser',
      activeTabId: 'browser:browser-2',
      previousTabId: 'scratch',
      scratchVisible: true,
    })
  })

  test('关闭动态工具不影响其他 Work Session', () => {
    const current = new Map([
      ['session-a', { activeTool: 'side-chat' as const, previousTool: 'changes' as const }],
      ['session-b', { activeTool: 'preview' as const, previousTool: 'files' as const }],
    ])

    const next = closeSessionRightWorkspaceTool(
      current,
      'session-a',
      'side-chat',
      { hasPreview: false, hasSideChat: false },
    )

    expect(next.get('session-a')).toEqual({ activeTool: 'changes' })
    expect(next.get('session-b')).toEqual({ activeTool: 'preview', previousTool: 'files' })
  })

  test('所有 Right Workspace 工具的聚焦都同时绑定会话和工具', () => {
    const browserFocus = toggleRightWorkspaceFocus(null, 'session-a', 'browser')

    expect(browserFocus).toEqual({ sessionId: 'session-a', tool: 'browser' })
    expect(resolveRightWorkspaceFocus(browserFocus, 'session-a', 'browser')).toBe(true)
    expect(resolveRightWorkspaceFocus(browserFocus, 'session-a', 'files')).toBe(false)
    expect(resolveRightWorkspaceFocus(browserFocus, 'session-a', 'changes')).toBe(false)
    expect(resolveRightWorkspaceFocus(browserFocus, 'session-a', 'scratch')).toBe(false)
    expect(resolveRightWorkspaceFocus(browserFocus, 'session-a', 'preview')).toBe(false)
    expect(resolveRightWorkspaceFocus(browserFocus, 'session-a', 'side-chat')).toBe(false)
    expect(resolveRightWorkspaceFocus(browserFocus, 'session-b', 'browser')).toBe(false)
  })

  test('重复点击同一聚焦入口退出，切换到文件或预览则转移聚焦身份', () => {
    const browserFocus = { sessionId: 'session-a', tool: 'browser' as const }

    expect(toggleRightWorkspaceFocus(browserFocus, 'session-a', 'browser')).toBeNull()
    expect(toggleRightWorkspaceFocus(browserFocus, 'session-a', 'files')).toEqual({
      sessionId: 'session-a',
      tool: 'files',
    })
    expect(toggleRightWorkspaceFocus(browserFocus, 'session-a', 'preview')).toEqual({
      sessionId: 'session-a',
      tool: 'preview',
    })
  })

  test('终端实例聚焦保留具体 terminalId', () => {
    expect(toggleRightWorkspaceFocus(null, 'session-a', 'terminal:terminal-2')).toEqual({
      sessionId: 'session-a',
      tool: 'terminal',
      tabId: 'terminal:terminal-2',
    })
  })

  test('Browser 实例聚焦只响应相同 browserSessionId 的原生 Escape', () => {
    const focus = toggleRightWorkspaceFocus(null, 'session-a', 'browser:browser-2')

    expect(focus).toEqual({ sessionId: 'session-a', tool: 'browser', tabId: 'browser:browser-2' })
    expect(resolveBrowserFocusEscape(focus, 'session-a', 'browser-1')).toEqual(focus)
    expect(resolveBrowserFocusEscape(focus, 'session-a', 'browser-2')).toBeNull()
  })

  test('原生 Browser 页面 Escape 只退出对应会话的 Browser 聚焦', () => {
    expect(resolveBrowserFocusEscape({ sessionId: 'session-a', tool: 'browser' }, 'session-a')).toBeNull()
    expect(resolveBrowserFocusEscape({ sessionId: 'session-a', tool: 'browser' }, 'session-b')).toEqual({
      sessionId: 'session-a',
      tool: 'browser',
    })
    expect(resolveBrowserFocusEscape({ sessionId: 'session-a', tool: 'scratch' }, 'session-a')).toEqual({
      sessionId: 'session-a',
      tool: 'scratch',
    })
  })
})

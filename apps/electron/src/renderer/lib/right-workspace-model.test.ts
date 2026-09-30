import { describe, expect, test } from 'bun:test'
import {
  activateRightWorkspaceTool,
  canCloseRightWorkspaceTool,
  closeRightWorkspaceTool,
  closeRightWorkspaceV2OptionalTab,
  getRightWorkspaceMenuTools,
  getRightWorkspaceToolbarTools,
  openRightWorkspaceV2OptionalTab,
  resolveAvailableRightWorkspaceTabId,
  resolveClosedTabFallback,
  clampRightWorkspaceWidth,
  resolveRightWorkspaceTool,
  shouldPinRightWorkspaceMenu,
  shouldShowRightWorkspace,
  terminalIdFromTab,
  terminalTabId,
  toolFromRightWorkspaceTab,
  visibleRightWorkspaceTabs,
  type RightWorkspaceAvailability,
} from './right-workspace-model'

const allAvailable: RightWorkspaceAvailability = {
  hasPreview: true,
  hasSideChat: true,
}

describe('Right Workspace 状态模型', () => {
  test('Given 文件和改动原本常驻 When 切到 v2 Then 仅显式打开的标签出现，v1 始终保留', () => {
    const tabs = [{ tool: 'files' as const }, { tool: 'session-files' as const }, { tool: 'changes' as const }]
    expect(visibleRightWorkspaceTabs(tabs, true, { activeTool: 'files' })).toEqual([])
    expect(visibleRightWorkspaceTabs(tabs, true, openRightWorkspaceV2OptionalTab(undefined, 'changes'))).toEqual([{ tool: 'changes' }])
    expect(visibleRightWorkspaceTabs(tabs, false, { activeTool: 'files' })).toEqual(tabs)
  })

  test('Given 项目文件与会话文件已拆分 When v2 按需打开 Then 两个独立标签互不重复、可各自关闭', () => {
    const tabs = [{ tool: 'session-files' as const }, { tool: 'files' as const }]
    const sessionFiles = openRightWorkspaceV2OptionalTab(undefined, 'session-files')
    expect(sessionFiles.v2OpenTools).toEqual(['session-files'])
    expect(visibleRightWorkspaceTabs(tabs, true, sessionFiles)).toEqual([{ tool: 'session-files' }])

    const both = openRightWorkspaceV2OptionalTab(sessionFiles, 'files')
    expect(both.v2OpenTools).toEqual(['session-files', 'files'])
    expect(visibleRightWorkspaceTabs(tabs, true, both)).toEqual(tabs)
    expect(openRightWorkspaceV2OptionalTab(both, 'session-files').v2OpenTools).toEqual(['session-files', 'files'])

    const afterSessionFiles = closeRightWorkspaceV2OptionalTab(both, 'session-files', ['files'])
    expect(afterSessionFiles.v2OpenTools).toEqual(['files'])
    expect(afterSessionFiles.activeTabId).toBe('files')
  })

  test('Given v2 空工作区 When 从加号按需打开文件与改动 Then 不重复并可关闭回到启动页', () => {
    const files = openRightWorkspaceV2OptionalTab(undefined, 'files')
    expect(files.v2OpenTools).toEqual(['files'])
    const both = openRightWorkspaceV2OptionalTab(files, 'changes')
    expect(both.v2OpenTools).toEqual(['files', 'changes'])
    expect(openRightWorkspaceV2OptionalTab(both, 'changes').v2OpenTools).toEqual(['files', 'changes'])
    const afterChanges = closeRightWorkspaceV2OptionalTab(both, 'changes', ['files'])
    expect(afterChanges.activeTabId).toBe('files')
    expect(afterChanges.v2OpenTools).toEqual(['files'])
    const empty = closeRightWorkspaceV2OptionalTab(afterChanges, 'files', [])
    expect(empty.v2OpenTools).toEqual([])
    expect(empty.activeTabId).toBe('files')

    const withBrowser = openRightWorkspaceV2OptionalTab({ activeTool: 'browser', activeTabId: 'browser:owned' }, 'files')
    expect(closeRightWorkspaceV2OptionalTab(withBrowser, 'files', ['browser:owned']).activeTabId).toBe('browser:owned')
  })

  test('Given 会话 A 的可选标签 When 打开或关闭 Then 会话 B 与旧版默认文件标签不受影响', () => {
    const a = openRightWorkspaceV2OptionalTab(undefined, 'files')
    const b = { activeTool: 'changes' as const }
    expect(a.v2OpenTools).toEqual(['files'])
    expect(b.activeTool).toBe('changes')
    expect(getRightWorkspaceToolbarTools(b.activeTool)).toContain('files')
  })
  test('已关闭的活动标签不会阻止空白右栏回退', () => {
    const stalePreview = { activeTool: 'preview' as const, activeTabId: 'preview' as const }
    expect(resolveAvailableRightWorkspaceTabId(stalePreview, [])).toBe('files')
    expect(resolveAvailableRightWorkspaceTabId(stalePreview, [{ id: 'changes' }])).toBe('changes')
    expect(resolveAvailableRightWorkspaceTabId(stalePreview, [{ id: 'preview' }])).toBe('preview')
  })

  test('右侧栏共享宽度仍受统一的拖拽上下限约束', () => {
    expect(clampRightWorkspaceWidth(280)).toBe(340)
    expect(clampRightWorkspaceWidth(480)).toBe(480)
    expect(clampRightWorkspaceWidth(800)).toBe(720)
  })

  test('Agent 终端实例使用独立标签并映射到终端工具', () => {
    expect(terminalTabId('terminal-1')).toBe('terminal:terminal-1')
    expect(terminalIdFromTab('terminal:terminal-1')).toBe('terminal-1')
    expect(terminalIdFromTab('files')).toBeNull()
    expect(toolFromRightWorkspaceTab('terminal:terminal-1')).toBe('terminal')
  })

  test('浏览器和草稿均为始终可用的工作区工具', () => {
    const availability = { hasPreview: false, hasSideChat: false }

    expect(resolveRightWorkspaceTool({ activeTool: 'browser' }, availability)).toBe('browser')
    expect(resolveRightWorkspaceTool({ activeTool: 'scratch' }, availability)).toBe('scratch')
  })

  test('文件与改动常驻，当前低频工具临时显示在工具带', () => {
    expect(getRightWorkspaceToolbarTools('files')).toEqual(['files', 'changes'])
    expect(getRightWorkspaceToolbarTools('browser')).toEqual(['files', 'changes', 'browser'])
    expect(getRightWorkspaceToolbarTools('preview')).toEqual(['files', 'changes', 'preview'])
  })

  test('添加菜单只负责新建 Browser 或恢复草稿', () => {
    expect(getRightWorkspaceMenuTools()).toEqual(['browser', 'scratch'])
  })

  test('关闭活动实例优先返回历史标签，否则回到相邻标签', () => {
    const tabIds = ['files', 'changes', 'scratch', 'browser:first', 'browser:second'] as const

    expect(resolveClosedTabFallback(tabIds, 'browser:second', 'browser:first')).toBe('browser:first')
    expect(resolveClosedTabFallback(tabIds, 'scratch', 'scratch')).toBe('changes')
    expect(resolveClosedTabFallback(['files'], 'files')).toBe('files')
  })

  test('添加工具按钮仅在标签总宽度超过可用空间时固定到右侧', () => {
    expect(shouldPinRightWorkspaceMenu(240, 160)).toBe(false)
    expect(shouldPinRightWorkspaceMenu(196, 160)).toBe(false)
    expect(shouldPinRightWorkspaceMenu(195, 160)).toBe(true)
  })

  test('只有持有真实内容的 Browser、预览和问答可以关闭', () => {
    expect(canCloseRightWorkspaceTool('browser', true)).toBe(true)
    expect(canCloseRightWorkspaceTool('browser', false)).toBe(false)
    expect(canCloseRightWorkspaceTool('preview', false)).toBe(true)
    expect(canCloseRightWorkspaceTool('side-chat', false)).toBe(true)
    expect(canCloseRightWorkspaceTool('scratch', false)).toBe(false)
    expect(canCloseRightWorkspaceTool('files', false)).toBe(false)
  })

  test('没有会话状态时默认显示文件', () => {
    expect(resolveRightWorkspaceTool(undefined, allAvailable)).toBe('files')
  })

  test('动态工具不可用时回退到文件', () => {
    expect(resolveRightWorkspaceTool(
      { activeTool: 'preview', previousTool: 'changes' },
      { hasPreview: false, hasSideChat: false },
    )).toBe('files')
  })

  test('激活动态工具时记录上一个工具', () => {
    expect(activateRightWorkspaceTool({ activeTool: 'changes' }, 'preview')).toEqual({
      activeTool: 'preview',
      previousTool: 'changes',
    })
  })

  test('关闭活动动态工具后回到可用的上一个工具', () => {
    expect(closeRightWorkspaceTool(
      { activeTool: 'preview', previousTool: 'changes' },
      'preview',
      { hasPreview: false, hasSideChat: false },
    )).toEqual({ activeTool: 'changes' })
  })

  test('上一个工具也不可用时回到文件', () => {
    expect(closeRightWorkspaceTool(
      { activeTool: 'preview', previousTool: 'side-chat' },
      'preview',
      { hasPreview: false, hasSideChat: false },
    )).toEqual({ activeTool: 'files' })
  })

  test('折叠后整个 Right Workspace 退出布局', () => {
    const base = {
      appMode: 'agent' as const,
      hasSession: true,
      automationFormOpen: false,
      activeView: 'conversations',
    }

    expect(shouldShowRightWorkspace({ ...base, open: true })).toBe(true)
    expect(shouldShowRightWorkspace({ ...base, open: false })).toBe(false)
  })

  test('非 Work 会话或全屏工作视图不展示 Right Workspace', () => {
    expect(shouldShowRightWorkspace({
      appMode: 'chat',
      hasSession: true,
      open: true,
      automationFormOpen: false,
      activeView: 'conversations',
    })).toBe(false)
    expect(shouldShowRightWorkspace({
      appMode: 'agent',
      hasSession: true,
      open: true,
      automationFormOpen: false,
      activeView: 'planning',
    })).toBe(false)
  })
})

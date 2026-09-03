import { describe, expect, test } from 'bun:test'
import {
  activateRightWorkspaceTool,
  canCloseRightWorkspaceTool,
  closeRightWorkspaceTool,
  getRightWorkspaceMenuTools,
  getRightWorkspaceToolbarTools,
  resolveClosedTabFallback,
  resolveRightWorkspaceActivation,
  resolveRightWorkspaceAutoWidth,
  resolveRightWorkspaceAutoWidthActivation,
  resolveRightWorkspaceTool,
  shouldPinRightWorkspaceMenu,
  shouldShowRightWorkspace,
  terminalIdFromTab,
  terminalTabId,
  toolFromRightWorkspaceTab,
  type RightWorkspaceAvailability,
} from './right-workspace-model'

const allAvailable: RightWorkspaceAvailability = {
  hasPreview: true,
  hasSideChat: true,
}

describe('Right Workspace 状态模型', () => {
  test('活动身份同时包含会话和实例标签，未初始化时回退到文件', () => {
    expect(resolveRightWorkspaceActivation('session-a', undefined)).toEqual({
      key: 'session-a:files',
      tool: 'files',
    })
    expect(resolveRightWorkspaceActivation('session-a', {
      activeTool: 'browser',
      activeTabId: 'browser:first',
    })).toEqual({
      key: 'session-a:browser:first',
      tool: 'browser',
    })
    expect(resolveRightWorkspaceActivation('session-b', {
      activeTool: 'terminal',
      activeTabId: 'terminal:dev-server',
    })).toEqual({
      key: 'session-b:terminal:dev-server',
      tool: 'terminal',
    })
  })

  test('活动标签只在身份变化时请求一次扩宽，隐藏后清除记录', () => {
    const preview = resolveRightWorkspaceActivation('session-a', { activeTool: 'preview' })
    expect(resolveRightWorkspaceAutoWidthActivation(null, true, preview)).toEqual({
      nextKey: 'session-a:preview',
      toolToEnsure: 'preview',
    })
    expect(resolveRightWorkspaceAutoWidthActivation('session-a:preview', true, preview)).toEqual({
      nextKey: 'session-a:preview',
      toolToEnsure: null,
    })
    expect(resolveRightWorkspaceAutoWidthActivation('session-a:preview', false, preview)).toEqual({
      nextKey: null,
      toolToEnsure: null,
    })
  })

  test('浏览器、终端和文档预览在空间允许时扩大到建议宽度', () => {
    const base = {
      currentWidth: 340,
      viewportWidth: 1440,
      leftSidebarWidth: 300,
      leftSidebarCollapsed: false,
    }

    expect(resolveRightWorkspaceAutoWidth({ ...base, tool: 'browser' })).toBe(720)
    expect(resolveRightWorkspaceAutoWidth({ ...base, tool: 'terminal' })).toBe(720)
    expect(resolveRightWorkspaceAutoWidth({ ...base, tool: 'preview' })).toBe(720)
  })

  test('紧凑工具和已经足够宽的工作区不改变宽度', () => {
    const base = {
      currentWidth: 720,
      viewportWidth: 1440,
      leftSidebarWidth: 300,
      leftSidebarCollapsed: false,
    }

    expect(resolveRightWorkspaceAutoWidth({ ...base, tool: 'files' })).toBe(720)
    expect(resolveRightWorkspaceAutoWidth({ ...base, tool: 'changes' })).toBe(720)
    expect(resolveRightWorkspaceAutoWidth({ ...base, tool: 'scratch' })).toBe(720)
    expect(resolveRightWorkspaceAutoWidth({ ...base, tool: 'browser' })).toBe(720)
  })

  test('窗口空间有限时只扩到安全上限，左栏折叠后可使用释放出的宽度', () => {
    const base = {
      tool: 'browser' as const,
      currentWidth: 340,
      leftSidebarWidth: 300,
      leftSidebarCollapsed: false,
    }

    expect(resolveRightWorkspaceAutoWidth({ ...base, viewportWidth: 1024 })).toBe(340)
    expect(resolveRightWorkspaceAutoWidth({ ...base, viewportWidth: 1200 })).toBe(480)
    expect(resolveRightWorkspaceAutoWidth({ ...base, viewportWidth: 1024, leftSidebarCollapsed: true })).toBe(604)
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

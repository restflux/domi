import { describe, expect, test } from 'bun:test'
import React from 'react'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { agentAttachedDirectoriesMapAtom, agentAttachedFilesMapAtom, agentSessionsAtom, agentWorkspacesAtom } from '@/atoms/agent-atoms'
import type { GeneratedImageItem, SDKMessage } from '@domi/shared'
import { SessionFilesCard } from './SessionFilesCard'
import { SessionFilesPopover } from './SessionFilesPopover'
import {
  DEFAULT_SESSION_FILES_POPOVER_OPEN,
  positionSessionFilesPopover,
  resolveRightWorkspaceToolAfterSessionFilesClose,
  selectConfirmedSessionOutputs,
  selectSessionFileSources,
  shouldCloseSessionFilesPopoverOnPointerDown,
} from './session-files-popover-model'

describe('会话文件浮窗入口', () => {
  test('Given 完整右侧栏收起 When 首次进入 Work 会话 Then 用户自行决定何时打开浮窗', () => {
    expect(DEFAULT_SESSION_FILES_POPOVER_OPEN).toBe(false)
    const html = renderToStaticMarkup(React.createElement(SessionFilesCard, {
      sessionId: 'session-1', sessionPath: null, onViewAll: () => {},
    }))
    expect(html).toContain('输出内容')
    expect(html).toContain('来源')
    expect(html).toContain('查看全部')
    expect(html).toContain('暂无可确认的输出')
    expect(html).not.toContain('创建文件或站点')
    expect(html).not.toContain('搜索文件')
    expect(html).not.toContain('支持拖拽')
  })

  test('Given 生成图片和附件混在同一会话 When 选择明确输出 Then 只展示工作目录中确认生成的图片', () => {
    const image = (source: GeneratedImageItem['source'], filename: string, mtime: number): GeneratedImageItem => ({
      source, filename, mtime, localPath: `/session/${filename}`, mediaType: 'image/png', size: 100,
    })
    expect(selectConfirmedSessionOutputs([
      image('agent-attachment', '用户上传.png', 30),
      image('agent-workspace', '旧生成.png', 10),
      image('agent-workspace', '新生成.png', 20),
    ]).map((item) => item.filename)).toEqual(['新生成.png', '旧生成.png'])
  })

  test('Given 用户在消息中上传图片 When 选择来源 Then 展示输入图片并排除工具结果与不明工作目录文件', () => {
    const userMessage = (content: string): SDKMessage => ({
      type: 'user', message: { role: 'user', content: [{ type: 'text', text: content }] },
    }) as SDKMessage
    const messages: SDKMessage[] = [
      userMessage('<attached_files>\n- image.png: /session/image.png\n</attached_files>'),
      { ...userMessage('<attached_files>\n- 假图.png: /tool/假图.png\n</attached_files>'), parent_tool_use_id: 'tool-1' } as SDKMessage,
      userMessage('<attached_files>\n- image-1.png: /session/image-1.png\n</attached_files>'),
    ]
    expect(selectSessionFileSources(messages, ['/session/image.png', '/external/说明.pdf'], ['/external/资料'])).toEqual([
      { path: '/session/image-1.png', filename: 'image-1.png', isDirectory: false, isImage: true },
      { path: '/session/image.png', filename: 'image.png', isDirectory: false, isImage: true },
      { path: '/external/说明.pdf', filename: '说明.pdf', isDirectory: false, isImage: false },
    ])
    expect(selectSessionFileSources([], [], [])).toEqual([])
  })

  test('Given 用户附加了文件和目录 When 渲染卡片 Then 只在来源中列出真实附加项', () => {
    const store = createStore()
    store.set(agentSessionsAtom, [{
      id: 'session-1', title: '会话', workspaceId: 'workspace-1', createdAt: 0, updatedAt: 0,
    }])
    store.set(agentWorkspacesAtom, [{
      id: 'workspace-1', name: '项目', slug: 'project', createdAt: 0, updatedAt: 0,
    }])
    store.set(agentAttachedFilesMapAtom, new Map([['session-1', ['/source/参考.pdf']]]))
    store.set(agentAttachedDirectoriesMapAtom, new Map([['session-1', ['/source/资料']]]))
    const html = renderToStaticMarkup(React.createElement(Provider, { store },
      React.createElement(SessionFilesCard, { sessionId: 'session-1', sessionPath: null, onViewAll: () => {} }),
    ))
    expect(html).toContain('参考.pdf')
    expect(html).toContain('资料')
    expect(html).toContain('添加来源')
    expect(html).not.toContain('/source/参考.pdf</span>')
  })

  test('Given 浮窗已经展开 When 点击卡片外层 Then 关闭浮窗；点击入口或卡片内部则保持', () => {
    expect(shouldCloseSessionFilesPopoverOnPointerDown({
      insideTrigger: false,
      insidePanel: false,
    })).toBe(true)
    expect(shouldCloseSessionFilesPopoverOnPointerDown({
      insideTrigger: true,
      insidePanel: false,
    })).toBe(false)
    expect(shouldCloseSessionFilesPopoverOnPointerDown({
      insideTrigger: false,
      insidePanel: true,
    })).toBe(false)
    expect(shouldCloseSessionFilesPopoverOnPointerDown({
      insideTrigger: false,
      insidePanel: false,
      insideOverlay: true,
    })).toBe(false)
  })

  test('Given 当前是 Work 会话且完整右侧栏收起 When 渲染顶部工具 Then 显示会话文件入口', () => {
    const html = renderToStaticMarkup(React.createElement(SessionFilesPopover, {
      sessionId: 'session-1', rightWorkspaceOpen: false,
    }))
    expect(html).toContain('查看会话文件')
    expect(html).toContain('aria-expanded="false"')
    expect(html.match(/<circle /g)).toHaveLength(2)
    expect(html).not.toContain('lucide-files')
  })

  test('Given 完整右侧栏已经打开 When 渲染顶部工具 Then 仍显示可点击的会话文件入口', () => {
    const html = renderToStaticMarkup(React.createElement(SessionFilesPopover, {
      sessionId: 'session-1', rightWorkspaceOpen: true,
    }))
    expect(html).toContain('查看会话文件')
    expect(html).toContain('aria-expanded="false"')
    expect(html.match(/<circle /g)).toHaveLength(2)
  })

  test('Given 侧栏展开或窗口缩小 When 浮窗靠入口定位 Then 卡片留在主内容区而非覆盖侧栏', () => {
    const collapsed = positionSessionFilesPopover({
      viewportWidth: 1000, mainLeft: 180, mainRight: 1000, mainBottom: 46,
      triggerRight: 955, triggerBottom: 38,
    })
    expect(collapsed).toEqual({ top: 54, right: 45, width: 300 })

    const expanded = positionSessionFilesPopover({
      viewportWidth: 1000, mainLeft: 180, mainRight: 680, mainBottom: 46,
      triggerRight: 635, triggerBottom: 38,
    })
    expect(expanded).toEqual({ top: 54, right: 365, width: 300 })
    expect(1000 - expanded.right).toBeLessThan(680)

    const narrow = positionSessionFilesPopover({
      viewportWidth: 800, mainLeft: 120, mainRight: 350, mainBottom: 46,
      triggerRight: 305, triggerBottom: 38,
    })
    expect(narrow).toEqual({ top: 54, right: 495, width: 173 })
    expect(800 - narrow.right - narrow.width).toBeGreaterThanOrEqual(120)
  })

  test('Given 会话文件浮窗正在展示 When 打开完整右侧栏 Then 关闭浮窗并转到改动，不把文件恢复进侧栏', () => {
    expect(resolveRightWorkspaceToolAfterSessionFilesClose(undefined)).toBe('changes')
    expect(resolveRightWorkspaceToolAfterSessionFilesClose('files')).toBe('changes')
    expect(resolveRightWorkspaceToolAfterSessionFilesClose('browser')).toBe('browser')
  })

})

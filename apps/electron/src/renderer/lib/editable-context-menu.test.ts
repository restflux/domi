import { describe, expect, it } from 'bun:test'
import {
  closeEditableContextMenuSession,
  createEditableContextMenuItems,
  createEditableContextMenuSession,
  getEditableContextMenuShortcutLabels,
  resolveEditableContextMenuPlacement,
  resolveEditableContextMenuRequest,
  resolveEditableContextMenuTarget,
} from './editable-context-menu'

describe('Domi 输入框右键菜单', () => {
  it('按标准编辑顺序展示操作，并沿用 Electron 提供的禁用状态', () => {
    const items = createEditableContextMenuItems({
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: false,
      canDelete: true,
      canSelectAll: true,
    }, 'win32')

    expect(items).toEqual([
      { type: 'action', action: 'undo', label: '撤销', shortcut: 'Ctrl+Z', enabled: true },
      { type: 'action', action: 'redo', label: '重做', shortcut: 'Ctrl+Y', enabled: false },
      { type: 'separator' },
      { type: 'action', action: 'cut', label: '剪切', shortcut: 'Ctrl+X', enabled: true },
      { type: 'action', action: 'copy', label: '复制', shortcut: 'Ctrl+C', enabled: true },
      { type: 'action', action: 'paste', label: '粘贴', shortcut: 'Ctrl+V', enabled: false },
      { type: 'action', action: 'pasteAsPlainText', label: '粘贴为纯文本', shortcut: 'Ctrl+Shift+V', enabled: false },
      { type: 'action', action: 'delete', label: '删除', shortcut: 'Del', enabled: true },
      { type: 'separator' },
      { type: 'action', action: 'selectAll', label: '全选', shortcut: 'Ctrl+A', enabled: true },
    ])
  })

  it('macOS 使用平台惯用快捷键标签', () => {
    expect(getEditableContextMenuShortcutLabels('darwin')).toEqual({
      undo: '⌘Z',
      redo: '⇧⌘Z',
      cut: '⌘X',
      copy: '⌘C',
      paste: '⌘V',
      pasteAsPlainText: '⇧⌘V',
      delete: '⌫',
      selectAll: '⌘A',
    })
  })

  it('优先使用原生 contextmenu 事件捕获的编辑目标，不再被坐标 hit-test 丢失', () => {
    const capturedTarget = { id: 'captured-editor' }
    let hitTestCount = 0

    expect(resolveEditableContextMenuTarget(capturedTarget, () => {
      hitTestCount += 1
      return null
    })).toBe(capturedTarget)
    expect(hitTestCount).toBe(0)
  })

  it('没有捕获目标时才使用坐标 hit-test 兜底', () => {
    const fallbackTarget = { id: 'fallback-editor' }

    expect(resolveEditableContextMenuTarget(null, () => fallbackTarget)).toBe(fallbackTarget)
  })

  it('优先使用 Renderer 原生事件坐标作为菜单锚点，并保留 Main 编辑状态', () => {
    expect(resolveEditableContextMenuRequest({
      x: 140,
      y: 320,
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: false,
      canDelete: true,
      canSelectAll: true,
    }, { x: 186, y: 744 })).toEqual({
      x: 186,
      y: 744,
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: false,
      canDelete: true,
      canSelectAll: true,
    })
  })

  it('没有 Renderer 坐标时保留 Main IPC 坐标兜底', () => {
    const request = {
      x: 140,
      y: 320,
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: false,
      canDelete: true,
      canSelectAll: true,
    }

    expect(resolveEditableContextMenuRequest(request, null)).toBe(request)
  })

  it('旧菜单的延迟关闭不能清空后来打开的新菜单', () => {
    const request = {
      x: 320,
      y: 500,
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canDelete: true,
      canSelectAll: true,
    }
    const oldSession = createEditableContextMenuSession(1, request)
    const newSession = createEditableContextMenuSession(2, request)

    expect(closeEditableContextMenuSession(newSession, oldSession.id)).toBe(newSession)
    expect(closeEditableContextMenuSession(newSession, newSession.id)).toBeNull()
  })

  it('上方空间足够时默认向上展开，让菜单底边落在右键位置', () => {
    expect(resolveEditableContextMenuPlacement({
      x: 320,
      y: 500,
      menuWidth: 220,
      menuHeight: 280,
      viewportWidth: 1200,
      viewportHeight: 800,
    })).toEqual({ horizontal: 'right', vertical: 'up' })
  })

  it('仅在上方空间不足时向下展开', () => {
    expect(resolveEditableContextMenuPlacement({
      x: 320,
      y: 120,
      menuWidth: 220,
      menuHeight: 280,
      viewportWidth: 1200,
      viewportHeight: 800,
    })).toEqual({ horizontal: 'right', vertical: 'down' })
  })

  it('靠近窗口右侧时向左展开', () => {
    expect(resolveEditableContextMenuPlacement({
      x: 1120,
      y: 500,
      menuWidth: 220,
      menuHeight: 280,
      viewportWidth: 1200,
      viewportHeight: 800,
    })).toEqual({ horizontal: 'left', vertical: 'up' })
  })
})

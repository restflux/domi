import type {
  EditableContextMenuAction,
  EditableContextMenuRequest,
  EditableContextMenuState,
} from '../../types/editable-context-menu'

export type EditableContextMenuPlatform = 'darwin' | 'win32' | 'linux'

export interface EditableContextMenuPlacementInput {
  x: number
  y: number
  menuWidth: number
  menuHeight: number
  viewportWidth: number
  viewportHeight: number
  viewportPadding?: number
}

export interface EditableContextMenuSession {
  id: number
  request: EditableContextMenuRequest
}

export interface EditableContextMenuPlacement {
  horizontal: 'left' | 'right'
  vertical: 'up' | 'down'
}

export interface EditableContextMenuPoint {
  x: number
  y: number
}

/**
 * 使用 Renderer 原生 contextmenu 事件的 viewport 坐标定位菜单，同时保留
 * Main 提供的编辑能力状态；未捕获到 Renderer 坐标时才沿用 IPC 坐标。
 */
export function resolveEditableContextMenuRequest(
  request: EditableContextMenuRequest,
  capturedPoint: EditableContextMenuPoint | null,
): EditableContextMenuRequest {
  return capturedPoint ? { ...request, ...capturedPoint } : request
}

/**
 * 选择本次右键对应的编辑目标。
 *
 * Renderer 的原生 contextmenu 事件能给出精确 DOM 目标；坐标 hit-test 只作为
 * preload/main 消息先到等异常时序下的兜底。
 */
export function resolveEditableContextMenuTarget<T>(
  capturedTarget: T | null,
  hitTest: () => T | null,
): T | null {
  return capturedTarget ?? hitTest()
}

export function createEditableContextMenuSession(
  id: number,
  request: EditableContextMenuRequest,
): EditableContextMenuSession {
  return { id, request }
}

export function closeEditableContextMenuSession(
  current: EditableContextMenuSession | null,
  closingSessionId: number,
): EditableContextMenuSession | null {
  return current?.id === closingSessionId ? null : current
}

export type EditableContextMenuItem =
  | {
      type: 'action'
      action: EditableContextMenuAction
      label: string
      shortcut: string
      enabled: boolean
    }
  | { type: 'separator' }

export function resolveEditableContextMenuPlacement({
  x,
  y,
  menuWidth,
  menuHeight,
  viewportWidth,
  viewportPadding = 8,
}: EditableContextMenuPlacementInput): EditableContextMenuPlacement {
  return {
    horizontal: x + menuWidth <= viewportWidth - viewportPadding ? 'right' : 'left',
    vertical: y - menuHeight >= viewportPadding ? 'up' : 'down',
  }
}

export function getEditableContextMenuShortcutLabels(
  platform: EditableContextMenuPlatform,
): Record<EditableContextMenuAction, string> {
  if (platform === 'darwin') {
    return {
      undo: '⌘Z',
      redo: '⇧⌘Z',
      cut: '⌘X',
      copy: '⌘C',
      paste: '⌘V',
      pasteAsPlainText: '⇧⌘V',
      delete: '⌫',
      selectAll: '⌘A',
    }
  }

  return {
    undo: 'Ctrl+Z',
    redo: 'Ctrl+Y',
    cut: 'Ctrl+X',
    copy: 'Ctrl+C',
    paste: 'Ctrl+V',
    pasteAsPlainText: 'Ctrl+Shift+V',
    delete: 'Del',
    selectAll: 'Ctrl+A',
  }
}

export function createEditableContextMenuItems(
  state: EditableContextMenuState,
  platform: EditableContextMenuPlatform,
): EditableContextMenuItem[] {
  const shortcuts = getEditableContextMenuShortcutLabels(platform)

  return [
    { type: 'action', action: 'undo', label: '撤销', shortcut: shortcuts.undo, enabled: state.canUndo },
    { type: 'action', action: 'redo', label: '重做', shortcut: shortcuts.redo, enabled: state.canRedo },
    { type: 'separator' },
    { type: 'action', action: 'cut', label: '剪切', shortcut: shortcuts.cut, enabled: state.canCut },
    { type: 'action', action: 'copy', label: '复制', shortcut: shortcuts.copy, enabled: state.canCopy },
    { type: 'action', action: 'paste', label: '粘贴', shortcut: shortcuts.paste, enabled: state.canPaste },
    {
      type: 'action',
      action: 'pasteAsPlainText',
      label: '粘贴为纯文本',
      shortcut: shortcuts.pasteAsPlainText,
      enabled: state.canPaste,
    },
    { type: 'action', action: 'delete', label: '删除', shortcut: shortcuts.delete, enabled: state.canDelete },
    { type: 'separator' },
    { type: 'action', action: 'selectAll', label: '全选', shortcut: shortcuts.selectAll, enabled: state.canSelectAll },
  ]
}

export function getEditableContextMenuPlatform(userAgent: string): EditableContextMenuPlatform {
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'darwin'
  if (/Windows/i.test(userAgent)) return 'win32'
  return 'linux'
}

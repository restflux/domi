import type { App, IpcMain, WebContents } from 'electron'
import {
  EDITABLE_CONTEXT_MENU_CHANNELS,
  isEditableContextMenuAction,
  type EditableContextMenuAction,
} from '../../types/editable-context-menu'

function executeEditableContextMenuAction(
  webContents: WebContents,
  action: EditableContextMenuAction,
): void {
  switch (action) {
    case 'undo':
      webContents.undo()
      break
    case 'redo':
      webContents.redo()
      break
    case 'cut':
      webContents.cut()
      break
    case 'copy':
      webContents.copy()
      break
    case 'paste':
      webContents.paste()
      break
    case 'pasteAsPlainText':
      webContents.pasteAndMatchStyle()
      break
    case 'delete':
      webContents.delete()
      break
    case 'selectAll':
      webContents.selectAll()
      break
  }
}

/** 将 Chromium 的编辑状态发送给渲染进程，由 Domi UI 展示右键菜单。 */
export function installEditableContextMenu(webContents: WebContents): void {
  webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable) return

    webContents.send(EDITABLE_CONTEXT_MENU_CHANNELS.SHOW, {
      x: params.x,
      y: params.y,
      canUndo: params.editFlags.canUndo,
      canRedo: params.editFlags.canRedo,
      canCut: params.editFlags.canCut,
      canCopy: params.editFlags.canCopy,
      canPaste: params.editFlags.canPaste,
      canDelete: params.editFlags.canDelete,
      canSelectAll: params.editFlags.canSelectAll,
    })
  })
}

/** 覆盖所有 Electron 窗口，并在主进程执行受信任的标准编辑命令。 */
export function registerEditableContextMenus(app: App, ipcMain: IpcMain): void {
  app.on('web-contents-created', (_event, webContents) => {
    // 内置浏览器使用无 Domi preload 的 WebContentsView，不能路由到应用内菜单。
    if (webContents.getType() !== 'window') return
    installEditableContextMenu(webContents)
  })

  ipcMain.on(EDITABLE_CONTEXT_MENU_CHANNELS.EXECUTE, (event, action: unknown) => {
    if (!isEditableContextMenuAction(action)) return
    executeEditableContextMenuAction(event.sender, action)
  })
}

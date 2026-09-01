export const EDITABLE_CONTEXT_MENU_CHANNELS = {
  SHOW: 'editable-context-menu:show',
  EXECUTE: 'editable-context-menu:execute',
} as const

export type EditableContextMenuAction =
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'pasteAsPlainText'
  | 'delete'
  | 'selectAll'

export interface EditableContextMenuState {
  canUndo: boolean
  canRedo: boolean
  canCut: boolean
  canCopy: boolean
  canPaste: boolean
  canDelete: boolean
  canSelectAll: boolean
}

export interface EditableContextMenuRequest extends EditableContextMenuState {
  x: number
  y: number
}

export function isEditableContextMenuAction(value: unknown): value is EditableContextMenuAction {
  return value === 'undo'
    || value === 'redo'
    || value === 'cut'
    || value === 'copy'
    || value === 'paste'
    || value === 'pasteAsPlainText'
    || value === 'delete'
    || value === 'selectAll'
}

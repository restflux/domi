export interface DialogCloseAutoFocusEvent {
  preventDefault: () => void
}

/**
 * Radix Dialog 关闭后按调用方指定的目标恢复焦点。
 * 未提供回调时保留 Radix 默认行为，避免改变复用组件在其他场景的焦点语义。
 */
export function handleOptionalDialogCloseAutoFocus(
  event: DialogCloseAutoFocusEvent,
  restoreFocus?: () => void,
): void {
  if (!restoreFocus) return
  event.preventDefault()
  restoreFocus()
}

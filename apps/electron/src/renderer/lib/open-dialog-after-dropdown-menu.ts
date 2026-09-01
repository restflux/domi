export type DropdownMenuDialogScheduler = (callback: () => void) => void

function defaultScheduler(callback: () => void): void {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => callback())
    return
  }
  setTimeout(callback, 0)
}

/**
 * Radix DropdownMenu 会在 onSelect 后关闭菜单并恢复焦点。
 * 把受控 Dialog 延迟到下一帧打开，避免菜单的焦点恢复把 Dialog 立即吞掉。
 */
export function openDialogAfterDropdownMenu(
  open: () => void,
  schedule: DropdownMenuDialogScheduler = defaultScheduler,
): void {
  schedule(open)
}

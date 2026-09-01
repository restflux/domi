/**
 * Radix Tooltip 默认自行管理悬停状态；附件菜单展开时必须强制关闭，
 * 避免仍停留在触发按钮上的 Tooltip 覆盖菜单项。
 */
export function resolveAttachmentMenuTooltipOpen(menuOpen: boolean): false | undefined {
  return menuOpen ? false : undefined
}

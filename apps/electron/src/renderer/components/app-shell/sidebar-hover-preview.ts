export const SIDEBAR_PREVIEW_EXIT_MS = 160

/** 固定展开、经典界面或设置页应立即移除浮窗，不等待收起动画。 */
export function shouldRenderSidebarHoverPreview(
  active: boolean,
  mounted: boolean,
  collapsed: boolean,
  classic: boolean,
  settingsOpen: boolean,
): boolean {
  return collapsed && !classic && !settingsOpen && (active || mounted)
}

interface PointerPosition {
  x: number
  y: number
}

interface PreviewBounds {
  left: number
  right: number
  top: number
  bottom: number
}

/** 替换轨道 DOM 时的 pointerleave 不能直接视为用户真的离开了悬浮面板。 */
export function shouldCloseSidebarHoverPreview(
  pointer: PointerPosition,
  preview: PreviewBounds | null,
  popupOpen: boolean,
  focusInside = false,
): boolean {
  if (popupOpen || focusInside) return false
  if (!preview) return true
  return pointer.x < preview.left || pointer.x >= preview.right
    || pointer.y < preview.top || pointer.y >= preview.bottom
}

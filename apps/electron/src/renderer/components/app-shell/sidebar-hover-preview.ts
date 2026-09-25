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
): boolean {
  if (popupOpen) return false
  if (!preview) return true
  return pointer.x < preview.left || pointer.x >= preview.right
    || pointer.y < preview.top || pointer.y >= preview.bottom
}

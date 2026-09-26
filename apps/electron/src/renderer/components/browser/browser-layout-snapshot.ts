export interface BrowserLayoutSnapshot {
  visible: boolean
  bounds: { x: number; y: number; width: number; height: number }
}

/** Native View 的布局协议只需要可见性或取整后的屏幕矩形真正改变时发布。 */
export function shouldPublishBrowserLayout(previous: BrowserLayoutSnapshot | null, next: BrowserLayoutSnapshot): boolean {
  return !previous || previous.visible !== next.visible
    || previous.bounds.x !== next.bounds.x || previous.bounds.y !== next.bounds.y
    || previous.bounds.width !== next.bounds.width || previous.bounds.height !== next.bounds.height
}

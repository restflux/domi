export interface ViewportSize { width: number; height: number }

/** 一个动画帧内只发布最新尺寸，避免每次 pointermove 都触发 WebContentsView 布局 IPC。 */
export function createViewportResizeFrameQueue(
  publish: (size: ViewportSize) => void,
  requestFrame: (callback: () => void) => number,
  cancelFrame: (id: number) => void,
): { schedule: (size: ViewportSize) => void; flush: () => void; dispose: () => void } {
  let pending: ViewportSize | null = null
  let frameId = 0
  let disposed = false
  const publishLatest = (): void => {
    frameId = 0
    if (disposed || !pending) return
    const size = pending
    pending = null
    publish(size)
  }
  return {
    schedule(size) {
      if (disposed) return
      pending = size
      if (!frameId) frameId = requestFrame(publishLatest)
    },
    flush() {
      if (frameId) cancelFrame(frameId)
      publishLatest()
    },
    dispose() {
      disposed = true
      if (frameId) cancelFrame(frameId)
      frameId = 0
      pending = null
    },
  }
}

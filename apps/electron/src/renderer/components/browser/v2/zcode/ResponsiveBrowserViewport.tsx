import * as React from 'react'
import type { BrowserSessionView } from '@domi/shared'
import { BrowserViewportToolbar } from './BrowserViewportToolbar.tsx'
import { ResponsiveBrowserResizeHandles, type ResizeHandleDirections } from './ResponsiveBrowserResizeHandles.tsx'
import { createViewportResizeFrameQueue, type ViewportSize } from './viewportResizeFrameQueue.ts'
import { BrowserSlot } from '../../BrowserSlot.tsx'

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)))

/**
 * 源自 ZCode ResponsiveBrowserViewport / BrowserViewportToolbar / ResponsiveBrowserResizeHandles。
 * 与其 CSS transform+webview 不同，Domi 把 BrowserSlot 缩到真实 CSS 尺寸，由 Main-owned
 * WebContentsView.setBounds 同步实际页面 viewport；超出可见画布不假装按比例缩放。
 */
export function ResponsiveBrowserViewport({ state, size, onSizeChange, onClose }: {
  state: BrowserSessionView
  size: ViewportSize
  onSizeChange: (size: ViewportSize) => void
  onClose: () => void
}): React.ReactElement {
  const region = React.useRef<HTMLDivElement>(null)
  const [available, setAvailable] = React.useState({ width: 390, height: 600 })
  const drag = React.useRef<{ pointerId: number; startX: number; startY: number; initial: ViewportSize; directions: ResizeHandleDirections } | null>(null)
  const resizeQueue = React.useRef<ReturnType<typeof createViewportResizeFrameQueue> | null>(null)
  React.useEffect(() => () => { resizeQueue.current?.dispose() }, [])
  React.useEffect(() => {
    const node = region.current
    if (!node) return
    const observer = new ResizeObserver(() => setAvailable({ width: node.clientWidth, height: node.clientHeight }))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const fitWidth = Math.max(4, Math.min(size.width, available.width - 32))
  const fitHeight = Math.max(4, Math.min(size.height, available.height - 32))
  const clipped = fitWidth < size.width || fitHeight < size.height
  const beginResize = (directions: ResizeHandleDirections, event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, initial: size, directions }
    resizeQueue.current?.dispose()
    resizeQueue.current = createViewportResizeFrameQueue(onSizeChange, requestAnimationFrame, cancelAnimationFrame)
  }
  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    resizeQueue.current?.schedule({
      width: clamp(current.initial.width + (event.clientX - current.startX) * current.directions.widthDirection, 240, 1920),
      height: clamp(current.initial.height + (event.clientY - current.startY) * current.directions.heightDirection, 320, 1600),
    })
  }
  const endResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointerId !== event.pointerId) return
    if (event.type === 'pointercancel') resizeQueue.current?.dispose()
    else resizeQueue.current?.flush()
    resizeQueue.current = null
    drag.current = null
  }
  const resizeByKeyboard = (directions: ResizeHandleDirections, event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 10 : 1
    if (directions.widthDirection && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      onSizeChange({ ...size, width: clamp(size.width + (event.key === 'ArrowRight' ? step : -step) * directions.widthDirection, 240, 1920) })
    }
    if (directions.heightDirection && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      onSizeChange({ ...size, height: clamp(size.height + (event.key === 'ArrowDown' ? step : -step) * directions.heightDirection, 320, 1600) })
    }
  }
  return <div className="flex min-h-0 flex-1 flex-col bg-muted/35" data-zcode-responsive-viewport="">
    <BrowserViewportToolbar size={size} onSizeChange={onSizeChange} onClose={onClose} />
    {clipped && <div role="status" className="shrink-0 bg-amber-500/10 px-3 py-1 text-center text-[11px] text-amber-700 dark:text-amber-300">当前窗口空间不足，页面视口已缩至可见范围</div>}
    <div ref={region} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
      <div className="relative flex shrink-0 flex-col rounded-lg border border-border bg-background shadow-xl" style={{ width: fitWidth, height: fitHeight }}>
        <BrowserSlot state={state} />
        <ResponsiveBrowserResizeHandles width={size.width} height={size.height} onBeginResize={beginResize} onMove={handlePointerMove} onEndResize={endResize} onResizeKeyDown={resizeByKeyboard} />
      </div>
    </div>
  </div>
}

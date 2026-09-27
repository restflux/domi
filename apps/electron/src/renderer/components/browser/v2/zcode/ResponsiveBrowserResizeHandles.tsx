import type { KeyboardEvent, PointerEvent, ReactElement } from 'react'
import { GripHorizontal, GripVertical } from 'lucide-react'

// 改编自 ZCode packages/ui/src/browser-use/ResponsiveBrowserResizeHandles.tsx。
export interface ResizeHandleDirections { widthDirection: -1 | 0 | 1; heightDirection: -1 | 0 | 1 }
interface Handle extends ResizeHandleDirections {
  edge: string
  className: string
  orientation?: 'vertical' | 'horizontal'
}
const HANDLES: readonly Handle[] = [
  { edge: 'left', className: 'top-0 -left-2 h-full w-4 cursor-ew-resize', widthDirection: -1, heightDirection: 0, orientation: 'vertical' },
  { edge: 'right', className: 'top-0 -right-2 h-full w-4 cursor-ew-resize', widthDirection: 1, heightDirection: 0, orientation: 'vertical' },
  { edge: 'top', className: '-top-2 left-0 h-4 w-full cursor-ns-resize', widthDirection: 0, heightDirection: -1, orientation: 'horizontal' },
  { edge: 'bottom', className: '-bottom-2 left-0 h-4 w-full cursor-ns-resize', widthDirection: 0, heightDirection: 1, orientation: 'horizontal' },
  { edge: 'top-left', className: '-top-2 -left-2 size-5 cursor-nwse-resize', widthDirection: -1, heightDirection: -1 },
  { edge: 'top-right', className: '-top-2 -right-2 size-5 cursor-nesw-resize', widthDirection: 1, heightDirection: -1 },
  { edge: 'bottom-left', className: '-bottom-2 -left-2 size-5 cursor-nesw-resize', widthDirection: -1, heightDirection: 1 },
  { edge: 'bottom-right', className: '-bottom-2 -right-2 size-5 cursor-nwse-resize', widthDirection: 1, heightDirection: 1 },
]

export function ResponsiveBrowserResizeHandles({ width, height, onBeginResize, onMove, onEndResize, onResizeKeyDown }: {
  width: number
  height: number
  onBeginResize: (directions: ResizeHandleDirections, event: PointerEvent<HTMLDivElement>) => void
  onMove: (event: PointerEvent<HTMLDivElement>) => void
  onEndResize: (event: PointerEvent<HTMLDivElement>) => void
  onResizeKeyDown: (directions: ResizeHandleDirections, event: KeyboardEvent<HTMLDivElement>) => void
}): ReactElement {
  return <>{HANDLES.map((handle) => <div
    key={handle.edge} data-resize-edge={handle.edge}
    className={`absolute z-30 touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring ${handle.className}`}
    role={handle.orientation ? 'separator' : undefined}
    tabIndex={handle.orientation ? 0 : undefined}
    aria-hidden={handle.orientation ? undefined : true}
    aria-label={handle.orientation ? `调整视口${handle.orientation === 'vertical' ? '宽度' : '高度'}` : undefined}
    aria-orientation={handle.orientation}
    aria-valuenow={handle.orientation === 'vertical' ? width : handle.orientation === 'horizontal' ? height : undefined}
    aria-valuemin={handle.orientation === 'vertical' ? 240 : handle.orientation === 'horizontal' ? 320 : undefined}
    aria-valuemax={handle.orientation === 'vertical' ? 1920 : handle.orientation === 'horizontal' ? 1600 : undefined}
    onPointerDown={(event) => onBeginResize(handle, event)}
    onPointerMove={onMove} onPointerUp={onEndResize} onPointerCancel={onEndResize}
    onLostPointerCapture={onEndResize}
    onKeyDown={(event) => onResizeKeyDown(handle, event)}
  >{handle.orientation === 'vertical' ? <GripVertical className="pointer-events-none absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 opacity-60" /> : handle.orientation === 'horizontal' ? <GripHorizontal className="pointer-events-none absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 opacity-60" /> : null}</div>)}</>
}

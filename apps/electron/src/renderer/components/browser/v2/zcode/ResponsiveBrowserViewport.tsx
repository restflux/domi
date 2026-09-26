import * as React from 'react'
import { ChevronDown, GripVertical, Monitor, RotateCw, Smartphone, Tablet } from 'lucide-react'
import type { BrowserSessionView } from '@domi/shared'
import { Button } from '@/components/ui/button.tsx'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx'
import { BrowserSlot } from '../../BrowserSlot.tsx'

interface ViewportPreset { label: string; width: number; height: number; icon: typeof Monitor }
const PRESETS: ViewportPreset[] = [
  { label: '手机', width: 390, height: 844, icon: Smartphone },
  { label: '平板', width: 768, height: 1024, icon: Tablet },
  { label: '桌面', width: 1280, height: 800, icon: Monitor },
]
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)))

/**
 * 源自 ZCode ResponsiveBrowserViewport / BrowserViewportToolbar / ResponsiveBrowserResizeHandles。
 * 与其 CSS transform+webview 不同，Domi 把 BrowserSlot 缩到真实 CSS 尺寸，由 Main-owned
 * WebContentsView.setBounds 同步实际页面 viewport；超出可见画布不假装按比例缩放。
 */
export function ResponsiveBrowserViewport({ state, onClose }: { state: BrowserSessionView; onClose: () => void }): React.ReactElement {
  const region = React.useRef<HTMLDivElement>(null)
  const [size, setSize] = React.useState({ width: 390, height: 844 })
  const [available, setAvailable] = React.useState({ width: 390, height: 600 })
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
  const startResize = (event: React.PointerEvent<HTMLDivElement>, edge: 'right' | 'left' | 'bottom'): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startY = event.clientY
    const initial = size
    const node = event.currentTarget
    const onMove = (pointer: PointerEvent): void => {
      setSize({ width: clamp(initial.width + (pointer.clientX - startX) * (edge === 'left' ? -2 : edge === 'right' ? 2 : 0), 240, 1920), height: clamp(initial.height + (pointer.clientY - startY) * (edge === 'bottom' ? 1 : 0), 320, 1600) })
    }
    const onEnd = (): void => { node.removeEventListener('pointermove', onMove); node.removeEventListener('pointerup', onEnd); node.removeEventListener('pointercancel', onEnd) }
    node.addEventListener('pointermove', onMove)
    node.addEventListener('pointerup', onEnd)
    node.addEventListener('pointercancel', onEnd)
  }
  return <div className="flex min-h-0 flex-1 flex-col bg-muted/35" data-zcode-responsive-viewport="">
    <div className="flex h-10 shrink-0 items-center justify-center gap-2 border-b border-border/60 px-2 text-xs">
      <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="h-7 gap-1"><Smartphone className="size-3.5" />响应式<ChevronDown className="size-3" /></Button></DropdownMenuTrigger><DropdownMenuContent>{PRESETS.map((preset) => <DropdownMenuItem key={preset.label} onSelect={() => setSize({ width: preset.width, height: preset.height })}><preset.icon className="size-4" />{preset.label} · {preset.width} × {preset.height}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
      <label className="flex items-center gap-1"><span className="sr-only">视口宽度</span><input type="number" min="240" max="1920" className="h-7 w-14 rounded-md bg-background px-1 text-center outline-none focus:ring-2 focus:ring-ring" aria-label="视口宽度" value={size.width} onChange={(event) => setSize((current) => ({ ...current, width: clamp(Number(event.target.value) || 240, 240, 1920) }))} /></label><span>×</span>
      <label><span className="sr-only">视口高度</span><input type="number" min="320" max="1600" className="h-7 w-14 rounded-md bg-background px-1 text-center outline-none focus:ring-2 focus:ring-ring" aria-label="视口高度" value={size.height} onChange={(event) => setSize((current) => ({ ...current, height: clamp(Number(event.target.value) || 320, 320, 1600) }))} /></label>
      <Button variant="ghost" size="icon" className="size-7" aria-label="交换视口宽高" onClick={() => setSize(({ width, height }) => ({ width: height, height: width }))}><RotateCw className="size-3.5" /></Button>
      <Button variant="ghost" size="sm" className="h-7" onClick={onClose}>退出响应式</Button>
    </div>
    {clipped && <div role="status" className="shrink-0 bg-amber-500/10 px-3 py-1 text-center text-[11px] text-amber-700 dark:text-amber-300">当前窗口空间不足，页面视口已缩至可见范围</div>}
    <div ref={region} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
      <div className="relative flex shrink-0 flex-col rounded-lg border border-border bg-background shadow-xl" style={{ width: fitWidth, height: fitHeight }}>
        <BrowserSlot state={state} />
        <div className="absolute -right-3 top-1/2 z-10 flex h-14 w-3 -translate-y-1/2 cursor-ew-resize items-center justify-center rounded-r-md bg-background shadow opacity-70 hover:opacity-100" onPointerDown={(event) => startResize(event, 'right')} role="separator" aria-label="调整视口宽度"><GripVertical className="size-3" /></div>
        <div className="absolute -bottom-3 right-1/2 z-10 h-3 w-14 translate-x-1/2 cursor-ns-resize rounded-b-md bg-background shadow opacity-70 hover:opacity-100" onPointerDown={(event) => startResize(event, 'bottom')} role="separator" aria-label="调整视口高度" />
      </div>
    </div>
  </div>
}

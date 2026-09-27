import * as React from 'react'
import { ChevronDown, RotateCw, Smartphone, Tablet, Monitor } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx'
import { parseViewportDimensionDraft } from './browserViewportDraft.ts'

interface BrowserViewportSize { width: number; height: number }
interface ViewportPreset extends BrowserViewportSize { label: string; icon: typeof Monitor }
const PRESETS: ViewportPreset[] = [
  { label: '手机', width: 390, height: 844, icon: Smartphone },
  { label: '平板', width: 768, height: 1024, icon: Tablet },
  { label: '桌面', width: 1280, height: 800, icon: Monitor },
]

/** 改编自 ZCode BrowserViewportToolbar：尺寸草稿只在 Enter/失焦时提交。 */
export function BrowserViewportToolbar({ size, onSizeChange, onClose }: {
  size: BrowserViewportSize
  onSizeChange: (size: BrowserViewportSize) => void
  onClose: () => void
}): React.ReactElement {
  const [widthDraft, setWidthDraft] = React.useState(String(size.width))
  const [heightDraft, setHeightDraft] = React.useState(String(size.height))
  const [invalid, setInvalid] = React.useState<'width' | 'height' | null>(null)
  const skipBlurCommit = React.useRef<'width' | 'height' | null>(null)
  React.useEffect(() => { setWidthDraft(String(size.width)) }, [size.width])
  React.useEffect(() => { setHeightDraft(String(size.height)) }, [size.height])

  const reset = (dimension: 'width' | 'height'): void => {
    if (dimension === 'width') setWidthDraft(String(size.width))
    else setHeightDraft(String(size.height))
    setInvalid(null)
  }
  const commit = (dimension: 'width' | 'height'): void => {
    const value = parseViewportDimensionDraft(dimension === 'width' ? widthDraft : heightDraft, dimension)
    if (value === null) { setInvalid(dimension); return }
    setInvalid(null)
    if (size[dimension] !== value) onSizeChange({ ...size, [dimension]: value })
    else reset(dimension)
  }
  const input = (dimension: 'width' | 'height'): React.ReactElement => <input
    type="text" inputMode="numeric" aria-label={dimension === 'width' ? '视口宽度' : '视口高度'}
    aria-invalid={invalid === dimension || undefined}
    aria-describedby={invalid === dimension ? `viewport-${dimension}-error` : undefined}
    className="h-7 w-14 rounded-md bg-background px-1 text-center outline-none focus:ring-2 focus:ring-ring aria-invalid:ring-2 aria-invalid:ring-destructive"
    value={dimension === 'width' ? widthDraft : heightDraft}
    onChange={(event) => {
      if (dimension === 'width') setWidthDraft(event.target.value)
      else setHeightDraft(event.target.value)
      if (invalid) setInvalid(null)
    }}
    onKeyDown={(event) => {
      if (event.key === 'Enter') { event.preventDefault(); commit(dimension) }
      if (event.key === 'Escape') { event.preventDefault(); skipBlurCommit.current = dimension; reset(dimension); event.currentTarget.blur() }
    }}
    onBlur={() => {
      if (skipBlurCommit.current === dimension) { skipBlurCommit.current = null; return }
      commit(dimension)
    }}
  />
  return <div className="flex h-10 shrink-0 items-center justify-center gap-2 border-b border-border/60 px-2 text-xs" data-zcode-viewport-toolbar="">
    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" className="h-7 gap-1"><Smartphone className="size-3.5" />响应式<ChevronDown className="size-3" /></Button></DropdownMenuTrigger><DropdownMenuContent>{PRESETS.map((preset) => <DropdownMenuItem key={preset.label} onSelect={() => { setInvalid(null); onSizeChange({ width: preset.width, height: preset.height }) }}><preset.icon className="size-4" />{preset.label} · {preset.width} × {preset.height}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
    {input('width')}<span aria-hidden="true">×</span>{input('height')}
    <Button variant="ghost" size="icon" className="size-7" aria-label="交换视口宽高" onClick={() => onSizeChange({ width: Math.min(1920, Math.max(240, size.height)), height: Math.min(1600, Math.max(320, size.width)) })}><RotateCw className="size-3.5" /></Button>
    <Button variant="ghost" size="sm" className="h-7" onClick={onClose}>退出响应式</Button>
    {invalid && <span id={`viewport-${invalid}-error`} role="alert" className="sr-only">{invalid === 'width' ? '宽度须在 240 至 1920 之间' : '高度须在 320 至 1600 之间'}</span>}
  </div>
}

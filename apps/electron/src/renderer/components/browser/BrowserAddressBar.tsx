import * as React from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  Focus,
  Loader2,
  Minus,
  MoreHorizontal,
  MousePointer2,
  Plus,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export const BROWSER_PRIMARY_ACTIONS = ['back', 'forward', 'reload-stop', 'address', 'select-element', 'more'] as const
export const BROWSER_MORE_ACTIONS = ['zoom', 'reset-zoom', 'fit-width', 'open-external', 'copy-url'] as const

interface BrowserAddressBarProps {
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  zoomPercent: number
  fitToWidth: boolean
  selectingElement: boolean
  disabled?: boolean
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onStop: () => void
  onZoom: (action: 'decrease' | 'increase' | 'reset') => void
  onToggleFit: () => void
  onToggleElementSelection: () => void
  onOpenExternal: () => void
}

interface BrowserToolbarIconButtonProps extends React.ComponentProps<typeof Button> {
  label: string
}

function BrowserToolbarIconButton({ label, className, ...props }: BrowserToolbarIconButtonProps): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          className={cn('size-7 shrink-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring', className)}
          {...props}
        />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function BrowserAddressBar({
  url,
  loading,
  canGoBack,
  canGoForward,
  zoomPercent,
  fitToWidth,
  selectingElement,
  disabled = false,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  onZoom,
  onToggleFit,
  onToggleElementSelection,
  onOpenExternal,
}: BrowserAddressBarProps): React.ReactElement {
  const [draftUrl, setDraftUrl] = React.useState(url)
  const [copyStatus, setCopyStatus] = React.useState<'idle' | 'copied' | 'failed'>('idle')

  React.useEffect(() => setDraftUrl(url), [url])

  const submit = React.useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const trimmed = draftUrl.trim()
    if (trimmed) onNavigate(trimmed)
  }, [draftUrl, onNavigate])

  const copyUrl = React.useCallback(async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('failed')
    }
    window.setTimeout(() => setCopyStatus('idle'), 1_500)
  }, [url])

  return (
    <div className="flex h-10 min-w-0 items-center gap-0.5 border-b border-border/50 bg-background/95 px-1.5 backdrop-blur">
      <BrowserToolbarIconButton label="后退" onClick={onBack} disabled={disabled || !canGoBack}>
        <ArrowLeft className="size-4" />
      </BrowserToolbarIconButton>
      <BrowserToolbarIconButton label="前进" onClick={onForward} disabled={disabled || !canGoForward}>
        <ArrowRight className="size-4" />
      </BrowserToolbarIconButton>
      <BrowserToolbarIconButton
        label={loading ? '停止加载' : '刷新'}
        onClick={loading ? onStop : onReload}
        disabled={disabled}
      >
        {loading ? <X className="size-4" /> : <RefreshCw className="size-4" />}
      </BrowserToolbarIconButton>

      <form onSubmit={submit} className="mx-1 min-w-[7rem] flex-1">
        <Input
          value={draftUrl}
          onChange={(event) => setDraftUrl(event.target.value)}
          aria-label="浏览器地址"
          placeholder="输入网址"
          disabled={disabled}
          className="h-7 min-w-0 rounded-md border-border/60 bg-muted/35 px-2 text-xs shadow-none focus-visible:ring-2"
        />
      </form>

      <BrowserToolbarIconButton
        label={selectingElement ? '取消选择网页元素' : '选择网页元素'}
        onClick={onToggleElementSelection}
        disabled={disabled}
        aria-pressed={selectingElement}
        className={selectingElement ? 'bg-primary/12 text-primary hover:bg-primary/18' : undefined}
      >
        {selectingElement ? <Loader2 className="size-4 animate-spin" /> : <MousePointer2 className="size-4" />}
      </BrowserToolbarIconButton>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="更多浏览器操作"
                disabled={disabled}
                className="size-7 shrink-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>更多</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-56">
          <div className="flex items-center gap-1 px-2 py-1.5" aria-label="网页缩放">
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="缩小网页" onClick={() => onZoom('decrease')}>
              <Minus className="size-4" />
            </Button>
            <span className="min-w-16 flex-1 text-center text-xs tabular-nums text-muted-foreground">{zoomPercent}%</span>
            <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="放大网页" onClick={() => onZoom('increase')}>
              <Plus className="size-4" />
            </Button>
          </div>
          <DropdownMenuItem onSelect={() => onZoom('reset')}>
            <RotateCcw />
            重置缩放
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onToggleFit}>
            {fitToWidth ? <Check /> : <Focus />}
            {fitToWidth ? '退出适应宽度' : '适应宽度'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onOpenExternal} disabled={!url}>
            <ExternalLink />
            在系统浏览器打开
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { void copyUrl() }} disabled={!url}>
            {copyStatus === 'copied' ? <Check /> : <Copy />}
            {copyStatus === 'copied' ? '已复制网址' : copyStatus === 'failed' ? '复制失败' : '复制网址'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

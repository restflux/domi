import * as React from 'react'
import { ChevronLeft, ChevronRight, Ellipsis, ExternalLink, Globe, Loader2, Minus, MonitorSmartphone, MousePointerClick, Plus, RefreshCw, TriangleAlert, X } from 'lucide-react'
import type { BrowserPageView, BrowserZoomAction } from '@domi/shared'
import { Button } from '@/components/ui/button.tsx'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu.tsx'
import { Input } from '@/components/ui/input.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'

interface BrowserToolbarProps {
  page: BrowserPageView | null
  disabled: boolean
  selecting: boolean
  responsive: boolean
  onToggleResponsive: () => void
  onNavigate: (url: string) => void
  onBack: () => void
  onForward: () => void
  onReload: () => void
  onStop: () => void
  onSelectElement: () => void
  onZoom: (action: BrowserZoomAction) => void
  onToggleFit: () => void
  onOpenExternal: () => void
}

/** 移植 ZCode EmbeddedBrowserPaneParts 的 48px BrowserToolbar；页面控制统一走 Domi Main。 */
export function BrowserToolbar({ page, disabled, selecting, responsive, onToggleResponsive, onNavigate, onBack, onForward, onReload, onStop, onSelectElement, onZoom, onToggleFit, onOpenExternal }: BrowserToolbarProps): React.ReactElement {
  const [address, setAddress] = React.useState(page?.url ?? '')
  const [editing, setEditing] = React.useState(false)
  React.useEffect(() => { if (!editing) setAddress(page?.url ?? '') }, [page?.url, editing])
  const loading = page?.loadState === 'loading'
  const icon = (label: string, callback: () => void, element: React.ReactNode, inactive = false, pressed?: boolean): React.ReactNode => <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 rounded-lg" aria-label={label} aria-pressed={pressed} disabled={inactive} onClick={callback}>{element}</Button></TooltipTrigger><TooltipContent side="bottom">{label}</TooltipContent></Tooltip>
  return <form className="flex h-12 shrink-0 items-center gap-2 border-b border-border/50 bg-background px-3" onSubmit={(event) => { event.preventDefault(); setEditing(false); onNavigate(address) }}>
    {icon('后退', onBack, <ChevronLeft className="size-4" />, disabled || !page?.canGoBack)}
    {icon('前进', onForward, <ChevronRight className="size-4" />, disabled || !page?.canGoForward)}
    {icon(loading ? '停止加载' : '刷新', loading ? onStop : onReload, loading ? <X className="size-4" /> : <RefreshCw className="size-4" />, disabled || !page)}
    <div className="relative min-w-0 flex-1">
      <Globe className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input value={address} onChange={(event) => setAddress(event.target.value)} onFocus={() => setEditing(true)} onBlur={() => setEditing(false)} aria-label="浏览器地址" placeholder="搜索或输入网址" className="h-8 rounded-lg border-transparent bg-muted/65 pl-8 pr-8 text-xs shadow-none focus-visible:border-border focus-visible:ring-1" />
      {loading && <Loader2 className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />}
    </div>
    {icon('响应式视口', onToggleResponsive, <MonitorSmartphone className="size-4" />, disabled || !page, responsive)}
    {icon(selecting ? '取消元素选择' : '选择页面元素', onSelectElement, <MousePointerClick className="size-4" />, disabled || !page || page.loadState !== 'ready', selecting)}
    <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" size="icon" variant="ghost" className="size-8 shrink-0 rounded-lg" aria-label="更多浏览器操作"><Ellipsis className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="min-w-44">
      <DropdownMenuItem onSelect={() => onZoom('decrease')}><Minus className="size-4" />缩小</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onZoom('increase')}><Plus className="size-4" />放大</DropdownMenuItem>
      <DropdownMenuItem onSelect={() => onZoom('reset')}>重置缩放 {page?.zoomPercent ?? 100}%</DropdownMenuItem>
      <DropdownMenuItem onSelect={onToggleFit}>{page?.fitToWidth ? '关闭适应宽度' : '适应宽度'}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onOpenExternal} disabled={!page?.url}><ExternalLink className="size-4" />在系统浏览器打开</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>
  </form>
}

/** ZCode BrowserEmptyState 与 BrowserLoadErrorState 的 Domi 宿主实现。 */
export function BrowserEmptyState({ busy }: { busy: boolean }): React.ReactElement {
  return <div className="flex min-h-0 flex-1 items-center justify-center bg-background px-6"><div className="flex max-w-sm flex-col items-center pb-10 text-center">{busy ? <Loader2 className="mb-6 size-16 animate-spin text-muted-foreground/40" /> : <Globe className="mb-6 size-16 text-muted-foreground/40" />}<h3 className="text-sm font-medium">内置浏览器</h3><p className="mt-2 text-sm text-muted-foreground">{busy ? '正在启动…' : '输入网址，开始浏览'}</p></div></div>
}

export function BrowserLoadErrorState({ message, onRetry }: { message: string; onRetry: () => void }): React.ReactElement {
  const isCertificateError = /cert|certificate|证书|SSL/i.test(message)
  return <div className="flex min-h-0 flex-1 items-center justify-center bg-background px-6" role="alert"><div className="flex max-w-md flex-col items-center pb-10 text-center"><TriangleAlert className="mb-5 size-12 text-amber-500" /><h3 className="text-sm font-medium">无法加载此页面</h3><p className="mt-2 break-words text-xs text-muted-foreground">{message}</p>{isCertificateError && <p className="mt-3 text-xs text-muted-foreground">证书验证失败，请检查网址或证书配置。</p>}<Button type="button" variant="outline" className="mt-6 gap-2" onClick={onRetry}><RefreshCw className="size-4" />重试</Button></div></div>
}

import * as React from 'react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface MinimapItem {
  id: string
  role: 'user' | 'assistant' | 'status'
  preview: string
  avatar?: string
  model?: string
}

interface ScrollMinimapProps {
  items: MinimapItem[]
  hasUnmountedItems?: boolean
  onRequestMount?: (id: string) => Promise<void>
}

export interface TurnNavigationItem {
  id: string
  userPreview: string
  assistantPreview: string
}

/** 移植 ZCode ConversationTurnNavigator 的「一轮提问一条横杠」结构；Domi 的消息分组在此处配对。 */
export function buildTurnNavigationItems(items: readonly MinimapItem[]): TurnNavigationItem[] {
  const turns: TurnNavigationItem[] = []
  for (const item of items) {
    if (item.role === 'user') {
      turns.push({ id: item.id, userPreview: item.preview || '（空消息）', assistantPreview: '' })
    } else if (turns.length === 0) {
      turns.push({ id: item.id, userPreview: item.role === 'status' ? '会话状态' : '助手消息', assistantPreview: item.preview })
    } else {
      const turn = turns[turns.length - 1]!
      if (item.preview) turn.assistantPreview += `${turn.assistantPreview ? '\n' : ''}${item.preview}`
    }
  }
  return turns
}

/** 与 ZCode conversationTurnNavigatorHelpers 中的聚焦短横条尺度保持一致。 */
export function resolveTurnBarVisualState(index: number, focusIndex?: number): { opacity: number; scaleX: number; tone: 'focus' | 'muted' } {
  if (focusIndex === undefined) return { opacity: 0.58, scaleX: 1, tone: 'muted' }
  const distance = Math.abs(index - focusIndex)
  if (distance === 0) return { opacity: 1, scaleX: 2.6, tone: 'focus' }
  if (distance === 1) return { opacity: 0.86, scaleX: 1.7, tone: 'muted' }
  if (distance === 2) return { opacity: 0.72, scaleX: 1.25, tone: 'muted' }
  return { opacity: 0.58, scaleX: 1, tone: 'muted' }
}

function messageTop(node: HTMLElement, container: HTMLElement): number {
  return node.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
}

export function resolveMinimapNavigationViewportPosition(
  conversation: { left: number; top: number; height: number },
  boundary?: { left: number },
): { left: number; top: number } {
  return { left: (boundary?.left ?? conversation.left) + 4, top: conversation.top + conversation.height / 2 }
}

export function resolveMinimapLogicalTarget(count: number, ratio: number): { index: number; offsetRatio: number } {
  const position = Math.max(0, Math.min(1, ratio)) * count
  const index = Math.max(0, Math.min(count - 1, Math.floor(position)))
  return { index, offsetRatio: ratio >= 1 ? 1 : position - index }
}

export function resolveMinimapWheelScrollTop(input: {
  scrollTop: number; scrollHeight: number; clientHeight: number; deltaY: number; deltaMode: number
}): number {
  const delta = input.deltaMode === 1 ? input.deltaY * 40 : input.deltaMode === 2 ? input.deltaY * input.clientHeight : input.deltaY
  return Math.max(0, Math.min(input.scrollHeight - input.clientHeight, input.scrollTop + delta))
}

export const SCROLL_MINIMAP_LAYOUT_CLASSES = {
  root: 'absolute inset-0 z-30 pointer-events-none',
  navigation: 'fixed flex -translate-y-1/2 items-center pointer-events-auto',
  progress: 'absolute inset-y-0 right-1 py-4 pointer-events-auto',
} as const

const ROW_HEIGHT = 10
const RAIL_MAX_HEIGHT = 400

/** 左侧采用 ZCode 的纵向虚拟短横条与逐轮悬浮预览；右侧保留 Domi 的滚动进度。 */
export function ScrollMinimap({ items, hasUnmountedItems = false, onRequestMount }: ScrollMinimapProps): React.ReactElement | null {
  const { scrollRef, stopScroll, state: stickyState } = useStickToBottomContext()
  const turns = React.useMemo(() => buildTurnNavigationItems(items), [items])
  const [metrics, setMetrics] = React.useState({ top: 0, height: 1, scrollHeight: 1, mountedCount: 0, centerId: '' })
  const [position, setPosition] = React.useState({ left: 4, top: 0 })
  const [railTop, setRailTop] = React.useState(0)
  const [railHeight, setRailHeight] = React.useState(RAIL_MAX_HEIGHT)
  const [hoverIndex, setHoverIndex] = React.useState<number>()
  const [dragRatio, setDragRatio] = React.useState<number>()
  const railRef = React.useRef<HTMLDivElement>(null)
  const trackRef = React.useRef<HTMLDivElement>(null)
  const navigationSerial = React.useRef(0)

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const update = (): void => {
      const rect = el.getBoundingClientRect()
      const boundary = el.closest('[data-scroll-minimap-boundary]')?.getBoundingClientRect()
      setPosition(resolveMinimapNavigationViewportPosition(rect, boundary))
      const nodes = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]'))
      const center = el.scrollTop + el.clientHeight / 2
      const centerNode = nodes.find((node) => messageTop(node, el) + node.offsetHeight > center) ?? nodes.at(-1)
      setMetrics({ top: el.scrollTop, height: el.clientHeight, scrollHeight: el.scrollHeight, mountedCount: nodes.length, centerId: centerNode?.dataset.messageId ?? '' })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    const boundaryElement = el.closest('[data-scroll-minimap-boundary]')
    if (boundaryElement) observer.observe(boundaryElement)
    el.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => { observer.disconnect(); el.removeEventListener('scroll', update); window.removeEventListener('resize', update) }
  }, [scrollRef, items, hasUnmountedItems])

  React.useEffect(() => {
    const rail = railRef.current
    if (!rail) return
    const update = (): void => setRailHeight(rail.clientHeight || RAIL_MAX_HEIGHT)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(rail)
    return () => observer.disconnect()
  }, [turns.length])

  const activeIndex = React.useMemo(() => {
    const centerIndex = items.findIndex((item) => item.id === metrics.centerId)
    if (centerIndex < 0) return turns.length - 1
    const turnId = items.slice(0, centerIndex + 1).findLast((item) => item.role === 'user')?.id ?? turns[0]?.id
    return turns.findIndex((turn) => turn.id === turnId)
  }, [items, metrics.centerId, turns])

  React.useEffect(() => {
    if (activeIndex < 0 || !railRef.current) return
    const rail = railRef.current
    const start = activeIndex * ROW_HEIGHT
    if (start < rail.scrollTop || start + ROW_HEIGHT > rail.scrollTop + rail.clientHeight) {
      rail.scrollTop = Math.max(0, start - rail.clientHeight / 2)
    }
  }, [activeIndex])

  const navigate = React.useCallback(async (id: string, offsetRatio = 0, behavior: ScrollBehavior = 'smooth'): Promise<void> => {
    const el = scrollRef.current
    if (!el) return
    const serial = ++navigationSerial.current
    stopScroll()
    stickyState.animation = undefined
    stickyState.velocity = 0
    stickyState.accumulated = 0
    const findTarget = (): HTMLElement | undefined => Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]'))
      .find((node) => node.dataset.messageId === id)
    let target = findTarget()
    const wasUnmounted = !target
    if (wasUnmounted && onRequestMount) {
      await onRequestMount(id)
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      target = findTarget()
    }
    if (!target || serial !== navigationSerial.current) return
    const top = messageTop(target, el) + target.offsetHeight * offsetRatio - el.clientHeight * 0.2
    el.scrollTo({ top, behavior: wasUnmounted ? 'auto' : behavior })
  }, [onRequestMount, scrollRef, stickyState, stopScroll])

  const navigateRatio = React.useCallback((ratio: number): void => {
    const el = scrollRef.current
    if (!el) return
    if (hasUnmountedItems && items.length > 0) {
      const { index, offsetRatio } = resolveMinimapLogicalTarget(items.length, ratio)
      void navigate(items[index]!.id, offsetRatio, 'auto')
    } else {
      stopScroll()
      stickyState.animation = undefined
      stickyState.velocity = 0
      stickyState.accumulated = 0
      el.scrollTo({ top: ratio * (el.scrollHeight - el.clientHeight), behavior: 'auto' })
    }
  }, [hasUnmountedItems, items, navigate, scrollRef, stickyState, stopScroll])

  const logicalIndex = items.findIndex((item) => item.id === metrics.centerId)
  const progress = hasUnmountedItems && logicalIndex >= 0 ? (logicalIndex + 0.5) / items.length
    : metrics.top / Math.max(1, metrics.scrollHeight - metrics.height)
  const thumbRatio = hasUnmountedItems
    ? Math.max(0.08, Math.min(1, (metrics.mountedCount / Math.max(1, items.length)) * metrics.height / metrics.scrollHeight))
    : Math.max(0.08, Math.min(1, metrics.height / metrics.scrollHeight))
  const effectiveRatio = Math.max(0, Math.min(1, dragRatio ?? progress))
  const first = Math.max(0, Math.floor(railTop / ROW_HEIGHT) - 6)
  const last = Math.min(turns.length, Math.ceil((railTop + railHeight) / ROW_HEIGHT) + 6)

  const handleThumbPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const track = trackRef.current
    if (!track) return
    const startY = event.clientY
    const startRatio = effectiveRatio
    const move = (next: PointerEvent): void => {
      const ratio = Math.max(0, Math.min(1, startRatio + (next.clientY - startY) / Math.max(1, track.clientHeight * (1 - thumbRatio))))
      setDragRatio(ratio)
      navigateRatio(ratio)
    }
    const release = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', release); setDragRatio(undefined) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', release, { once: true })
  }

  if (turns.length < 2 || (metrics.scrollHeight <= metrics.height + 10 && !hasUnmountedItems)) return null

  return (
    <div data-scroll-minimap-root className={SCROLL_MINIMAP_LAYOUT_CLASSES.root}>
      <TooltipProvider delayDuration={120}>
        <nav aria-label="消息导航" data-scroll-minimap-navigation className={SCROLL_MINIMAP_LAYOUT_CLASSES.navigation} style={position}>
          <div ref={railRef} className="w-9 max-h-[min(400px,calc(100vh-6rem))] overflow-x-hidden overflow-y-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            onScroll={(event) => { setRailTop(event.currentTarget.scrollTop); setHoverIndex(undefined) }} onPointerLeave={() => setHoverIndex(undefined)}>
            <div className="relative w-9" style={{ height: turns.length * ROW_HEIGHT }}>
              {turns.slice(first, last).map((turn, localIndex) => {
                const index = first + localIndex
                const active = index === activeIndex
                const visual = resolveTurnBarVisualState(index, hoverIndex)
                return (
                  <div key={turn.id} className="absolute left-0 top-0 h-2.5 w-9" style={{ transform: `translateY(${index * ROW_HEIGHT}px)` }}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" aria-current={active ? 'location' : undefined} aria-label={`跳转到第 ${index + 1} 轮提问`}
                          aria-posinset={index + 1} aria-setsize={turns.length} onClick={() => void navigate(turn.id)}
                          onFocus={() => setHoverIndex(index)} onBlur={() => setHoverIndex(undefined)}
                          onPointerEnter={() => setHoverIndex(index)} onPointerLeave={() => setHoverIndex(undefined)}
                          className="flex h-2.5 w-9 items-center justify-start rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                          <span className={cn('block h-0.5 w-3 origin-left rounded-full transition-[opacity,transform,background-color] duration-150 motion-reduce:transition-none',
                            visual.tone === 'focus' || (hoverIndex === undefined && active) ? 'bg-foreground' : 'bg-muted-foreground')}
                            style={{ opacity: hoverIndex === undefined && active ? 0.9 : visual.opacity, transform: `scaleX(${visual.scaleX})` }} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right" sideOffset={8} className="w-80 max-w-[calc(100vw-2rem)] border border-popover-border bg-popover p-3 text-popover-foreground shadow-lg">
                        <div className="space-y-2">
                          <p className="line-clamp-2 whitespace-pre-line text-sm font-medium leading-5">{turn.userPreview}</p>
                          <p className="line-clamp-3 whitespace-pre-line text-sm leading-5 opacity-70">{turn.assistantPreview || '暂无回复'}</p>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                )
              })}
            </div>
          </div>
        </nav>
      </TooltipProvider>
      <div className={SCROLL_MINIMAP_LAYOUT_CLASSES.progress} style={{ width: 8 }}
        onWheel={(event) => { const el = scrollRef.current; if (!el) return; event.preventDefault(); stopScroll(); el.scrollTop = resolveMinimapWheelScrollTop({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, deltaY: event.deltaY, deltaMode: event.deltaMode }) }}>
        <div ref={trackRef} className="relative h-full cursor-pointer rounded-full scroll-progress-track"
          onPointerDown={(event) => { if (event.target !== event.currentTarget) return; const rect = event.currentTarget.getBoundingClientRect(); navigateRatio((event.clientY - rect.top) / rect.height) }}>
          <div className="absolute left-0 right-0 cursor-grab rounded-full scroll-progress-thumb" style={{ height: `${thumbRatio * 100}%`, top: `${effectiveRatio * (1 - thumbRatio) * 100}%` }}
            onPointerDown={handleThumbPointerDown} />
        </div>
      </div>
    </div>
  )
}

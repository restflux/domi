/**
 * ScrollMinimap — 消息导航迷你地图 + 滚动进度条
 *
 * 在消息区域两侧显示：
 * 1. 左侧中部的短横杠代表每条消息的位置（迷你地图），悬浮时向右弹出消息预览列表
 * 2. 右侧保留可拖拽的滚动进度条，提供丝滑的滚动体验
 * 必须放在 StickToBottom（Conversation）内部使用。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AlertTriangle, Search } from 'lucide-react'
import { useStickToBottomContext } from 'use-stick-to-bottom'
import { Input } from '@/components/ui/input'
import { UserAvatar } from '@/components/chat/UserAvatar'
import { getModelLogo, resolveModelProvider } from '@/lib/model-logo'
import { channelsAtom } from '@/atoms/chat-atoms'
import { useShortcut } from '@/hooks/useShortcut'
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
  /** 当前完整消息序列中是否仍有尚未挂载到 DOM 的消息。 */
  hasUnmountedItems?: boolean
  /** 目标未挂载时，请求宿主先创建包含该消息的有界 DOM 窗口。 */
  onRequestMount?: (id: string) => Promise<void>
}

/** 最少消息数才显示迷你地图 */
const MIN_ITEMS = 1
/** 迷你地图最多渲染的横杠数 */
const MAX_BARS = 20
/** 迷你地图横杠垂直间距（px） */
const MINIMAP_BAR_SPACING = 8
/** 右侧滚动位置条宽度（px） */
const SCROLL_PROGRESS_WIDTH = 8
/** 导航条与主内容区左边缘的间距（px） */
const NAVIGATION_EDGE_INSET = 4

/** 用于计算导航条视口定位的最小矩形信息。 */
export interface MinimapViewportRect {
  left: number
  top: number
  height: number
}

/**
 * 导航条需要贴住完整 MainArea，而不是受居中消息容器的最大宽度约束。
 * 未找到 MainArea 边界时回退到消息视口左边缘。
 */
export function resolveMinimapNavigationViewportPosition(
  conversationRect: MinimapViewportRect,
  boundaryRect?: Pick<MinimapViewportRect, 'left'>,
): { left: number; top: number } {
  return {
    left: (boundaryRect?.left ?? conversationRect.left) + NAVIGATION_EDGE_INSET,
    top: conversationRect.top + conversationRect.height / 2,
  }
}

/** 导航与滚动进度条的布局契约，供组件与行为测试共享。 */
export const SCROLL_MINIMAP_LAYOUT_CLASSES = {
  root: 'absolute inset-0 z-30 pointer-events-none',
  navigation: 'fixed flex -translate-y-1/2 items-center',
  panel: 'order-2 ml-1 w-[280px] rounded-lg border bg-popover shadow-xl origin-left flex flex-col overflow-hidden pointer-events-auto',
  progress: 'absolute inset-y-0 right-1 py-4 pointer-events-auto',
} as const

// ── Markdown 预览配置（轻量级，禁用重量级渲染） ──

const PREVIEW_REMARK_PLUGINS = [remarkGfm]

/* eslint-disable @typescript-eslint/no-explicit-any -- react-markdown components 类型复杂，使用内联对象即可 */
const PREVIEW_MD_COMPONENTS = {
  pre: ({ children }: { children?: React.ReactNode }) => <pre className="text-[11px] opacity-70 truncate">{children}</pre>,
  code: ({ children }: { children?: React.ReactNode }) => <code className="text-[11px] bg-muted/50 px-0.5 rounded">{children}</code>,
  img: () => null as unknown as React.ReactElement,
  a: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
} as const
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── 辅助函数 ──

/** 计算 node 相对于 container 的实际顶部偏移（递归累积 offsetTop） */
function getOffsetTopRelativeTo(node: HTMLElement, container: HTMLElement): number {
  let top = 0
  let el: HTMLElement | null = node
  while (el && el !== container) {
    top += el.offsetTop
    el = el.offsetParent as HTMLElement | null
  }
  return top
}

/** 转义正则特殊字符 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface MinimapLogicalProgress {
  centerRatio: number
}

export interface MinimapSearchInteractionState {
  isFocused: boolean
  isComposing: boolean
}

/** 搜索框仍在交互时，忽略 IME 候选窗等原生浮层引发的 mouseleave。 */
export function shouldPreserveMinimapSearchPanel({
  isFocused,
  isComposing,
}: MinimapSearchInteractionState): boolean {
  return isFocused || isComposing
}

/** 用完整消息序列与当前视口中心计算逻辑进度，不依赖当前挂载窗口的物理 scrollHeight。 */
export function resolveMinimapLogicalProgress(
  items: readonly MinimapItem[],
  visibleIds: ReadonlySet<string>,
  centerVisibleId?: string,
  centerOffsetRatio = 0.5,
): MinimapLogicalProgress {
  if (items.length === 0) return { centerRatio: 0 }
  const visibleIndexes = items.flatMap((item, index) => visibleIds.has(item.id) ? [index] : [])
  const centerIndex = centerVisibleId == null
    ? -1
    : items.findIndex((item) => item.id === centerVisibleId)
  const fallbackCenterIndex = visibleIndexes.length > 0
    ? (visibleIndexes[0]! + visibleIndexes.at(-1)!) / 2
    : items.length - 0.5
  const resolvedCenterPosition = centerIndex >= 0
    ? centerIndex + Math.max(0, Math.min(1, centerOffsetRatio))
    : fallbackCenterIndex + 0.5
  return {
    centerRatio: Math.max(0, Math.min(1, resolvedCenterPosition / items.length)),
  }
}

/**
 * 根据当前挂载窗口的真实像素比例估算完整会话的滑块长度。
 * 使用挂载消息数而不是视口内消息数，避免经过高矮不一的消息时滑块抖动。
 */
export function resolveMinimapThumbRatio(input: {
  itemCount: number
  mountedItemCount: number
  clientHeight: number
  scrollHeight: number
}): number {
  if (input.itemCount <= 0 || input.mountedItemCount <= 0 || input.scrollHeight <= 0) return 1
  const mountedViewportRatio = Math.max(0, Math.min(1, input.clientHeight / input.scrollHeight))
  const mountedHistoryRatio = Math.max(0, Math.min(1, input.mountedItemCount / input.itemCount))
  return Math.max(0, Math.min(1, mountedViewportRatio * mountedHistoryRatio))
}

/** 把完整会话中的连续逻辑比例映射到消息及消息内部位置。 */
export function resolveMinimapLogicalTarget(itemCount: number, ratio: number): {
  index: number
  offsetRatio: number
} {
  if (itemCount <= 0) return { index: 0, offsetRatio: 0 }
  const clampedRatio = Math.max(0, Math.min(1, ratio))
  if (clampedRatio === 1) return { index: itemCount - 1, offsetRatio: 1 }
  const position = clampedRatio * itemCount
  const index = Math.min(itemCount - 1, Math.floor(position))
  return { index, offsetRatio: position - index }
}

/** 将指针位移映射到滑块实际可移动轨道，保证拖动可覆盖完整会话。 */
export function resolveMinimapDragRatio(input: {
  startRatio: number
  pointerDelta: number
  trackHeight: number
  thumbRatio: number
}): number {
  const movableTrack = Math.max(1, input.trackHeight * (1 - Math.max(0, Math.min(1, input.thumbRatio))))
  return Math.max(0, Math.min(1, input.startRatio + input.pointerDelta / movableTrack))
}

export function resolveMinimapScrollbarMetrics(input: {
  hasUnmountedItems: boolean
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  logicalProgressRatio: number
  logicalThumbRatio: number
}): { progressRatio: number; thumbRatio: number } {
  if (input.hasUnmountedItems) {
    return {
      progressRatio: Math.max(0, Math.min(1, input.logicalProgressRatio)),
      thumbRatio: Math.max(0, Math.min(1, input.logicalThumbRatio)),
    }
  }
  const scrollRange = Math.max(0, input.scrollHeight - input.clientHeight)
  return {
    progressRatio: scrollRange > 0
      ? Math.max(0, Math.min(1, input.scrollTop / scrollRange))
      : 0,
    thumbRatio: input.scrollHeight > 0
      ? Math.max(0, Math.min(1, input.clientHeight / input.scrollHeight))
      : 1,
  }
}

/** 将覆盖在消息区导航控件上的滚轮位移映射回真实消息滚动容器。 */
export function resolveMinimapWheelScrollTop(input: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  deltaY: number
  deltaMode: number
}): number {
  const delta = input.deltaMode === 1
    ? input.deltaY * 40
    : input.deltaMode === 2
      ? input.deltaY * input.clientHeight
      : input.deltaY
  const maxScrollTop = Math.max(0, input.scrollHeight - input.clientHeight)
  return Math.max(0, Math.min(maxScrollTop, input.scrollTop + delta))
}

function waitForMountedMessage(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

// ── 主组件 ──

export function ScrollMinimap({
  items,
  hasUnmountedItems = false,
  onRequestMount,
}: ScrollMinimapProps): React.ReactElement | null {
  const { scrollRef, stopScroll, state: stickyState } = useStickToBottomContext()
  const [hovered, setHovered] = React.useState(false)
  const [isLeaving, setIsLeaving] = React.useState(false)
  const [visibleIds, setVisibleIds] = React.useState<Set<string>>(new Set())
  /** 主区视口几何中心当前对应的消息 id —— 面板打开时作为列表居中锚点 */
  const [centerVisibleId, setCenterVisibleId] = React.useState<string | undefined>(undefined)
  const [centerVisibleOffsetRatio, setCenterVisibleOffsetRatio] = React.useState(0.5)
  const [canScroll, setCanScroll] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')
  const [isDragging, setIsDragging] = React.useState(false)
  const [dragLogicalRatio, setDragLogicalRatio] = React.useState<number | null>(null)
  const [scrollMetrics, setScrollMetrics] = React.useState({
    scrollTop: 0,
    scrollHeight: 1,
    clientHeight: 1,
    mountedItemCount: 0,
  })
  const closeTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const fadeTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const openTimerRef = React.useRef<ReturnType<typeof setTimeout>>()
  const searchInputRef = React.useRef<HTMLInputElement>(null)
  const panelRef = React.useRef<HTMLDivElement>(null)
  const navigationRef = React.useRef<HTMLDivElement>(null)
  const trackRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const pointerInsideNavigationRef = React.useRef(false)
  const searchFocusedRef = React.useRef(false)
  const searchComposingRef = React.useRef(false)
  const pendingDragRatioRef = React.useRef<number | null>(null)
  const dragNavigationInFlightRef = React.useRef(false)
  const dragFrameRef = React.useRef<number>()

  // ── 组件卸载时清理计时器 ──

  React.useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
      if (openTimerRef.current) clearTimeout(openTimerRef.current)
      if (dragFrameRef.current != null) cancelAnimationFrame(dragFrameRef.current)
    }
  }, [])

  // 导航条使用 fixed 横向定位以越过居中消息容器，但纵向仍跟随消息视口中心。
  React.useLayoutEffect(() => {
    const conversationElement = scrollRef.current
    const navigationElement = navigationRef.current
    if (!conversationElement || !navigationElement) return

    const boundaryElement = conversationElement.closest<HTMLElement>('[data-scroll-minimap-boundary]')
    const updatePosition = (): void => {
      const position = resolveMinimapNavigationViewportPosition(
        conversationElement.getBoundingClientRect(),
        boundaryElement?.getBoundingClientRect(),
      )
      navigationElement.style.left = `${position.left}px`
      navigationElement.style.top = `${position.top}px`
    }

    updatePosition()
    const resizeObserver = new ResizeObserver(updatePosition)
    resizeObserver.observe(conversationElement)
    if (boundaryElement) resizeObserver.observe(boundaryElement)
    window.addEventListener('resize', updatePosition)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', updatePosition)
    }
  }, [canScroll, hasUnmountedItems, scrollRef])

  // ── 可见消息 + 滚动指标追踪 ──

  React.useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const update = (): void => {
      const { scrollTop, scrollHeight, clientHeight } = el
      setCanScroll(scrollHeight > clientHeight + 10)
      if (scrollHeight <= 0) return

      const viewportCenter = scrollTop + clientHeight / 2
      const nodes = el.querySelectorAll<HTMLElement>('[data-message-id]')
      setScrollMetrics({ scrollTop, scrollHeight, clientHeight, mountedItemCount: nodes.length })
      const ids = new Set<string>()
      let centerId: string | undefined
      let centerOffsetRatio = 0.5
      for (const node of nodes) {
        const top = getOffsetTopRelativeTo(node, el)
        const bottom = top + node.offsetHeight
        if (bottom > scrollTop && top < scrollTop + clientHeight) {
          const id = node.getAttribute('data-message-id')
          if (id) ids.add(id)
        }
        if (centerId === undefined && top <= viewportCenter && bottom > viewportCenter) {
          centerId = node.getAttribute('data-message-id') ?? undefined
          centerOffsetRatio = node.offsetHeight > 0
            ? Math.max(0, Math.min(1, (viewportCenter - top) / node.offsetHeight))
            : 0.5
        }
      }
      setVisibleIds(ids)
      setCenterVisibleId(centerId)
      setCenterVisibleOffsetRatio(centerOffsetRatio)
    }

    update()
    el.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(el)
    const content = el.firstElementChild
    if (content instanceof HTMLElement) observer.observe(content)

    return () => {
      el.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [scrollRef])

  // ── 面板打开时自动聚焦搜索框 ──

  React.useEffect(() => {
    if (hovered && searchInputRef.current) {
      const timer = setTimeout(() => searchInputRef.current?.focus(), 80)
      return () => clearTimeout(timer)
    }
  }, [hovered])

  // ── 面板打开时把当前可见消息滚到列表中间，避免每次都从顶部开始 ──

  React.useEffect(() => {
    if (!hovered) return
    const timer = setTimeout(() => {
      const list = listRef.current
      if (!list) return
      const target = list.querySelector<HTMLElement>('[data-minimap-visible="true"]')
      if (!target) return
      // listRef 没有 position 设置，offsetTop / getOffsetTopRelativeTo 都不可靠，
      // 直接用 getBoundingClientRect 计算 target 相对 list 视口的偏移
      const listRect = list.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      const offsetInList = (targetRect.top - listRect.top) + list.scrollTop
      const offset = offsetInList - (list.clientHeight - target.offsetHeight) / 2
      list.scrollTo({ top: Math.max(0, offset), behavior: 'auto' })
    }, 0)
    return () => clearTimeout(timer)
  }, [hovered])

  // ── 面板关闭时清空搜索与输入交互状态 ──

  React.useEffect(() => {
    if (hovered) return
    setSearchQuery('')
    searchFocusedRef.current = false
    searchComposingRef.current = false
    pointerInsideNavigationRef.current = false
  }, [hovered])

  const cancelScheduledClose = React.useCallback((): void => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = undefined
    }
    if (fadeTimerRef.current) {
      clearTimeout(fadeTimerRef.current)
      fadeTimerRef.current = undefined
    }
    setIsLeaving(false)
  }, [])

  const scheduleClose = React.useCallback((): void => {
    if (shouldPreserveMinimapSearchPanel({
      isFocused: searchFocusedRef.current,
      isComposing: searchComposingRef.current,
    })) return

    cancelScheduledClose()
    closeTimerRef.current = setTimeout(() => {
      setIsLeaving(true)
      fadeTimerRef.current = setTimeout(() => {
        setHovered(false)
        setIsLeaving(false)
        fadeTimerRef.current = undefined
      }, 80)
      closeTimerRef.current = undefined
    }, 40)
  }, [cancelScheduledClose])

  // ── Cmd+F / Ctrl+F 快捷键：打开面板并聚焦搜索 ──

  const handleShortcutOpen = React.useCallback(() => {
    cancelScheduledClose()
    if (openTimerRef.current) { clearTimeout(openTimerRef.current); openTimerRef.current = undefined }
    setHovered(true)
  }, [cancelScheduledClose])

  useShortcut('file-find', handleShortcutOpen, items.length >= MIN_ITEMS && (canScroll || hasUnmountedItems))

  // ── 鼠标进出控制（仅迷你地图区域） ──

  /** 鼠标进入后需停留此时间（ms）才展开面板，防止掠过时闪烁 */
  const OPEN_DELAY = 180

  const handleMouseEnter = (): void => {
    pointerInsideNavigationRef.current = true
    cancelScheduledClose()

    // 面板已打开则无需重复触发
    if (hovered) return

    // 延迟打开：鼠标需在触发条上停留足够时间
    if (!openTimerRef.current) {
      openTimerRef.current = setTimeout(() => {
        setHovered(true)
        openTimerRef.current = undefined
      }, OPEN_DELAY)
    }
  }

  const handleMouseLeave = (): void => {
    pointerInsideNavigationRef.current = false

    // 尚未打开就离开了 → 取消打开定时器
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current)
      openTimerRef.current = undefined
    }

    if (!hovered) return
    scheduleClose()
  }

  const handleSearchFocus = (): void => {
    searchFocusedRef.current = true
    cancelScheduledClose()
  }

  const handleSearchBlur = (event: React.FocusEvent<HTMLInputElement>): void => {
    searchFocusedRef.current = false
    const nextTarget = event.relatedTarget
    if (
      searchComposingRef.current
      || pointerInsideNavigationRef.current
      || (nextTarget instanceof Node && panelRef.current?.contains(nextTarget))
    ) return
    scheduleClose()
  }

  const handleSearchCompositionStart = (): void => {
    searchComposingRef.current = true
    cancelScheduledClose()
  }

  const handleSearchCompositionEnd = (): void => {
    searchComposingRef.current = false
    if (!searchFocusedRef.current && !pointerInsideNavigationRef.current) scheduleClose()
  }

  // ── 跳转到指定消息（未挂载时先请求宿主创建有界窗口） ──

  const prepareManualScroll = React.useCallback((): void => {
    stopScroll()
    stickyState.animation = undefined
    stickyState.velocity = 0
    stickyState.accumulated = 0
  }, [stopScroll, stickyState])

  const findOrMountMessage = React.useCallback(async (id: string): Promise<HTMLElement | undefined> => {
    const el = scrollRef.current
    if (!el) return undefined
    const findTarget = (): HTMLElement | undefined => Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(
      (node) => node.getAttribute('data-message-id') === id
    )
    let target = findTarget()
    if (!target && onRequestMount) {
      await onRequestMount(id)
      await waitForMountedMessage()
      target = findTarget()
    }
    return target
  }, [onRequestMount, scrollRef])

  const scrollToLogicalRatio = React.useCallback(async (
    ratio: number,
    behavior: 'auto' | 'smooth',
  ): Promise<void> => {
    const el = scrollRef.current
    if (!el) return
    prepareManualScroll()

    const targetPosition = resolveMinimapLogicalTarget(items.length, ratio)
    const item = items[targetPosition.index]
    if (!item) return
    const target = await findOrMountMessage(item.id)
    if (!target) return

    const currentEl = scrollRef.current
    if (!currentEl) return
    const maxScrollTop = Math.max(0, currentEl.scrollHeight - currentEl.clientHeight)
    const unclampedScrollTop = ratio <= 0
      ? 0
      : ratio >= 1
        ? maxScrollTop
        : getOffsetTopRelativeTo(target, currentEl)
          + target.offsetHeight * targetPosition.offsetRatio
          - currentEl.clientHeight / 2
    const nextScrollTop = Math.max(0, Math.min(maxScrollTop, unclampedScrollTop))
    if (behavior === 'smooth') {
      currentEl.scrollTo({ top: nextScrollTop, behavior })
    } else {
      currentEl.scrollTop = nextScrollTop
    }
  }, [findOrMountMessage, items, prepareManualScroll, scrollRef])

  const scrollToMessage = React.useCallback(async (id: string) => {
    const index = items.findIndex((item) => item.id === id)
    if (index < 0) return
    await scrollToLogicalRatio((index + 0.5) / items.length, 'smooth')
    setHovered(false)
  }, [items, scrollToLogicalRatio])

  // ── 搜索过滤 ──

  const filteredItems = React.useMemo(() => {
    if (!searchQuery.trim()) return items
    const q = searchQuery.toLowerCase()
    return items.filter((item) => item.preview.toLowerCase().includes(q))
  }, [items, searchQuery])

  /** 列表居中锚点：优先用主区视口中心对应的消息；该消息被搜索过滤掉时退回第一条可见消息 */
  const anchorId = React.useMemo(() => {
    if (centerVisibleId && filteredItems.some((item) => item.id === centerVisibleId)) {
      return centerVisibleId
    }
    return filteredItems.find((item) => visibleIds.has(item.id))?.id
  }, [centerVisibleId, filteredItems, visibleIds])

  const logicalProgress = React.useMemo(
    () => resolveMinimapLogicalProgress(items, visibleIds, centerVisibleId, centerVisibleOffsetRatio),
    [centerVisibleId, centerVisibleOffsetRatio, items, visibleIds],
  )
  const logicalThumbRatio = resolveMinimapThumbRatio({
    itemCount: items.length,
    mountedItemCount: scrollMetrics.mountedItemCount,
    clientHeight: scrollMetrics.clientHeight,
    scrollHeight: scrollMetrics.scrollHeight,
  })
  const scrollbarMetrics = resolveMinimapScrollbarMetrics({
    hasUnmountedItems,
    scrollTop: scrollMetrics.scrollTop,
    scrollHeight: scrollMetrics.scrollHeight,
    clientHeight: scrollMetrics.clientHeight,
    logicalProgressRatio: logicalProgress.centerRatio,
    logicalThumbRatio,
  })
  const thumbRatio = Math.max(0.1, scrollbarMetrics.thumbRatio)

  const navigateToRatio = React.useCallback((ratio: number): void => {
    void scrollToLogicalRatio(ratio, 'smooth')
  }, [scrollToLogicalRatio])

  const drainDragNavigation = React.useCallback(async (): Promise<void> => {
    if (dragNavigationInFlightRef.current) return
    dragNavigationInFlightRef.current = true
    try {
      while (pendingDragRatioRef.current != null) {
        const ratio = pendingDragRatioRef.current
        pendingDragRatioRef.current = null
        await scrollToLogicalRatio(ratio, 'auto')
      }
    } finally {
      dragNavigationInFlightRef.current = false
    }
  }, [scrollToLogicalRatio])

  const scheduleDragNavigation = React.useCallback((ratio: number): void => {
    pendingDragRatioRef.current = ratio
    if (dragFrameRef.current != null || dragNavigationInFlightRef.current) return
    dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = undefined
      void drainDragNavigation()
    })
  }, [drainDragNavigation])

  // 迷你地图和进度条是滚动容器的绝对定位兄弟节点，浏览器不会自动把它们上方的
  // wheel 事件交给消息区，因此这里显式转发，避免指针停在“滚动条”上时无法滚动。
  const handleScrollSurfaceWheel = React.useCallback((event: React.WheelEvent<HTMLDivElement>): void => {
    if (event.deltaY === 0 || event.ctrlKey) return
    event.stopPropagation()

    const el = scrollRef.current
    if (!el) return
    stopScroll()
    stickyState.animation = undefined
    stickyState.velocity = 0
    stickyState.accumulated = 0
    el.scrollTop = resolveMinimapWheelScrollTop({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      deltaY: event.deltaY,
      deltaMode: event.deltaMode,
    })
  }, [scrollRef, stopScroll, stickyState])

  // ── 滚动条滑块拖拽 ──

  const handleThumbMouseDown = React.useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const el = scrollRef.current
    const track = trackRef.current
    if (!el || !track) return

    stopScroll()
    stickyState.animation = undefined
    stickyState.velocity = 0
    stickyState.accumulated = 0

    setIsDragging(true)
    const startY = e.clientY
    const trackHeight = track.clientHeight

    if (hasUnmountedItems) {
      const startRatio = scrollbarMetrics.progressRatio
      const onMouseMove = (event: MouseEvent): void => {
        event.preventDefault()
        const targetRatio = resolveMinimapDragRatio({
          startRatio,
          pointerDelta: event.clientY - startY,
          trackHeight,
          thumbRatio,
        })
        setDragLogicalRatio(targetRatio)
        scheduleDragNavigation(targetRatio)
      }
      const onMouseUp = (event: MouseEvent): void => {
        const targetRatio = resolveMinimapDragRatio({
          startRatio,
          pointerDelta: event.clientY - startY,
          trackHeight,
          thumbRatio,
        })
        scheduleDragNavigation(targetRatio)
        setIsDragging(false)
        setDragLogicalRatio(null)
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
      }
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'grabbing'
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
      return
    }

    const startScrollTop = el.scrollTop
    const { scrollHeight, clientHeight } = el
    const scrollRange = scrollHeight - clientHeight
    const thumbHeight = Math.max(trackHeight * 0.1, (clientHeight / scrollHeight) * trackHeight)
    const scrollableTrack = trackHeight - thumbHeight
    const onMouseMove = (event: MouseEvent): void => {
      event.preventDefault()
      const scrollDelta = scrollableTrack > 0 ? ((event.clientY - startY) / scrollableTrack) * scrollRange : 0
      el.scrollTop = Math.max(0, Math.min(scrollRange, startScrollTop + scrollDelta))
    }
    const onMouseUp = (): void => {
      setIsDragging(false)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'grabbing'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [hasUnmountedItems, scheduleDragNavigation, scrollRef, scrollbarMetrics.progressRatio, stopScroll, stickyState, thumbRatio])

  // ── 轨道点击跳转 ──

  const handleTrackMouseDown = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return

    const track = trackRef.current
    const el = scrollRef.current
    if (!track || !el) return

    stopScroll()
    stickyState.animation = undefined
    stickyState.velocity = 0
    stickyState.accumulated = 0

    const rect = track.getBoundingClientRect()
    const clickRatio = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
    if (hasUnmountedItems) {
      navigateToRatio(clickRatio)
      return
    }
    const { scrollHeight, clientHeight } = el
    el.scrollTo({ top: clickRatio * (scrollHeight - clientHeight), behavior: 'smooth' })
  }, [hasUnmountedItems, navigateToRatio, scrollRef, stopScroll, stickyState])

  if (items.length < MIN_ITEMS || (!canScroll && !hasUnmountedItems)) return null

  // ── 迷你地图条纹 ──

  const barCount = Math.min(items.length, MAX_BARS)

  // ── 滚动条滑块尺寸计算 ──

  const thumbHeightPct = thumbRatio * 100
  const effectiveProgressRatio = dragLogicalRatio ?? scrollbarMetrics.progressRatio
  const thumbTopPct = effectiveProgressRatio * (100 - thumbHeightPct)

  return (
    <div data-scroll-minimap-root className={SCROLL_MINIMAP_LAYOUT_CLASSES.root}>
      {/* ── 左侧中部的迷你地图悬停区域（横杠 + 面板） ── */}
      <div
        ref={navigationRef}
        data-scroll-minimap-navigation
        className={SCROLL_MINIMAP_LAYOUT_CLASSES.navigation}
      >
        {/* 展开面板 */}
        {hovered && (
          <div
            ref={panelRef}
            className={cn(
              SCROLL_MINIMAP_LAYOUT_CLASSES.panel,
              isLeaving
                ? 'animate-out fade-out-0 zoom-out-95 duration-75'
                : 'animate-in fade-in-0 zoom-in-95 duration-150'
            )}
            style={{ maxHeight: 'min(420px, 60vh)' }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
              <span className="text-xs font-medium text-popover-foreground/70">消息导航</span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {visibleIds.size}/{items.length}
              </span>
            </div>

            {/* 搜索框 */}
            <div className="px-2 py-1.5 border-b shrink-0">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50" />
                <Input
                  ref={searchInputRef}
                  placeholder="搜索消息..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onFocus={handleSearchFocus}
                  onBlur={handleSearchBlur}
                  onCompositionStart={handleSearchCompositionStart}
                  onCompositionEnd={handleSearchCompositionEnd}
                  className="h-7 text-xs pl-7 focus-visible:!border-border/60 focus-visible:!ring-0 focus-visible:!shadow-xs"
                />
              </div>
            </div>

            {/* 消息列表 */}
            <div ref={listRef} className="overflow-y-auto flex-1 p-1.5 space-y-0.5 scrollbar-thin">
              {filteredItems.length === 0 ? (
                <div className="py-6 text-center text-xs text-muted-foreground">
                  未找到匹配消息
                </div>
              ) : (
                filteredItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-minimap-visible={item.id === anchorId ? 'true' : undefined}
                    className={cn(
                      'flex items-start gap-2 w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent',
                      visibleIds.has(item.id) && 'bg-accent/50'
                    )}
                    onClick={() => { void scrollToMessage(item.id) }}
                  >
                    <ItemIcon item={item} />
                    <div className="flex-1 min-w-0">
                      <HighlightedPreview text={item.preview} query={searchQuery} />
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {/* ── 迷你地图横杠 —— 只有这里触发面板展开 ── */}
        <div
          className="order-1 relative flex-shrink-0 pointer-events-auto"
          style={{ width: 24, height: barCount * MINIMAP_BAR_SPACING }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          onWheel={handleScrollSurfaceWheel}
        >
          {Array.from({ length: barCount }, (_, i) => {
            const start = Math.floor((i * items.length) / barCount)
            const end = Math.floor(((i + 1) * items.length) / barCount)
            const group = items.slice(start, end)
            const isVisible = group.some((it) => visibleIds.has(it.id))
            const hasUser = group.some((it) => it.role === 'user')
            const top = ((i + 0.5) / barCount) * 100
            return (
              <div
                key={i}
                className={cn(
                  'absolute left-1 h-[2px] w-[20px] rounded-full transition-colors',
                  // 可见范围指示器的颜色由 .minimap-visible-indicator 规则按主题 token 提供
                  isVisible
                    ? 'minimap-visible-indicator'
                    : hasUser
                      ? 'bg-primary/25 dark:bg-primary/15'
                      : 'bg-primary/40 dark:bg-primary/25'
                )}
                style={{ top: `${top}%` }}
              />
            )
          })}
        </div>
      </div>

      {/* ── 滚动进度条 ── */}
      <div
        data-scroll-minimap-progress
        className={SCROLL_MINIMAP_LAYOUT_CLASSES.progress}
        style={{ width: SCROLL_PROGRESS_WIDTH }}
        onWheel={handleScrollSurfaceWheel}
      >
        <div
          ref={trackRef}
          className="relative h-full rounded-full cursor-pointer scroll-progress-track"
          onMouseDown={handleTrackMouseDown}
        >
          <div
            className={cn(
              'absolute left-0 right-0 rounded-full transition-colors duration-100 scroll-progress-thumb',
              isDragging
                ? 'scroll-progress-thumb-active cursor-grabbing'
                : 'cursor-grab'
            )}
            style={{
              height: `${thumbHeightPct}%`,
              top: `${thumbTopPct}%`,
            }}
            onMouseDown={handleThumbMouseDown}
          />
        </div>
      </div>
    </div>
  )
}

// ── 子组件 ──

function ItemIcon({ item }: { item: MinimapItem }): React.ReactElement {
  const channels = useAtomValue(channelsAtom)
  if (item.role === 'user' && item.avatar) {
    return <UserAvatar avatar={item.avatar} size={16} className="mt-0.5" />
  }
  if ((item.role === 'assistant') && item.model) {
    return (
      <img
        src={getModelLogo(item.model, resolveModelProvider(item.model, channels))}
        alt=""
        className="size-4 shrink-0 mt-0.5 rounded-[20%] object-cover"
      />
    )
  }
  if (item.role === 'status') {
    return <AlertTriangle className="size-4 shrink-0 mt-0.5 text-destructive" />
  }
  return <div className="size-4 shrink-0 mt-0.5 rounded-[20%] bg-muted" />
}

/** Markdown 预览（无搜索时）或 纯文本+高亮（搜索时） */
function HighlightedPreview({ text, query }: { text: string; query: string }): React.ReactElement {
  if (!text) {
    return <span className="text-xs opacity-40">(空消息)</span>
  }

  if (query.trim()) {
    const escaped = escapeRegExp(query)
    const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
    return (
      <span className="text-xs text-popover-foreground/80 line-clamp-3">
        {parts.map((part, i) =>
          part.toLowerCase() === query.toLowerCase()
            ? <mark key={i} className="bg-primary/20 text-primary rounded-sm px-0.5">{part}</mark>
            : part
        )}
      </span>
    )
  }

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none text-xs text-popover-foreground/80 prose-p:my-0 prose-headings:my-0.5 prose-headings:text-xs prose-li:my-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 line-clamp-3 overflow-hidden">
      <Markdown remarkPlugins={PREVIEW_REMARK_PLUGINS} components={PREVIEW_MD_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  )
}

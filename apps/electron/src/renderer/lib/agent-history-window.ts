// 普通会话直接完整挂载；真正长会话首屏只挂载尾部窗口，随后按滚动方向渐进扩展。
export const DEFAULT_AGENT_HISTORY_WINDOW_SIZE = 40

export interface AgentHistoryRange {
  startId: string
  /** 结束位置使用 exclusive anchor；null 表示一直挂载到当前尾部。 */
  endId: string | null
}

export type AgentHistoryLoadDirection = 'earlier' | 'later'

export interface AgentHistoryWindow<T> {
  mountedItems: T[]
  startIndex: number
  endIndex: number
  remainingCount: number
  remainingAfterCount: number
  anchorId: string | null
  endAnchorId: string | null
}

/**
 * 解析长会话的渐进挂载窗口。
 *
 * 没有显式 range 时始终根据当前完整 items 计算尾窗，不把派生 anchor 写回状态。
 * 这样流式结束阶段即使暂时只有最后一个 live turn，完整 persisted 历史回来后也会
 * 重新得到正确尾窗，不会把临时最后一组永久固化为会话起点。
 */
export function resolveAgentHistoryWindow<T>(
  items: readonly T[],
  anchorId: string | null,
  getId: (item: T) => string,
  windowSize = DEFAULT_AGENT_HISTORY_WINDOW_SIZE,
  endAnchorId: string | null = null,
): AgentHistoryWindow<T> {
  if (items.length === 0) {
    return {
      mountedItems: [],
      startIndex: 0,
      endIndex: 0,
      remainingCount: 0,
      remainingAfterCount: 0,
      anchorId: null,
      endAnchorId: null,
    }
  }

  const normalizedWindowSize = Math.max(1, Math.floor(windowSize))
  const anchoredIndex = anchorId == null
    ? -1
    : items.findIndex((item) => getId(item) === anchorId)
  const requestedEndIndex = endAnchorId == null
    ? items.length
    : items.findIndex((item) => getId(item) === endAnchorId)
  const hasValidRange = anchoredIndex >= 0
    && requestedEndIndex > anchoredIndex
  const startIndex = hasValidRange
    ? anchoredIndex
    : anchoredIndex >= 0 && endAnchorId == null
      ? anchoredIndex
      : Math.max(0, items.length - normalizedWindowSize)
  const endIndex = hasValidRange ? requestedEndIndex : items.length

  return {
    mountedItems: items.slice(startIndex, endIndex),
    startIndex,
    endIndex,
    remainingCount: startIndex,
    remainingAfterCount: items.length - endIndex,
    anchorId: getId(items[startIndex]!),
    endAnchorId: endIndex < items.length ? getId(items[endIndex]!) : null,
  }
}

/** 返回向前扩展后的新起点；已经到达开头时保持第一项。 */
export function expandAgentHistoryWindow<T>(
  items: readonly T[],
  currentAnchorId: string | null,
  getId: (item: T) => string,
  chunkSize = DEFAULT_AGENT_HISTORY_WINDOW_SIZE,
): string | null {
  if (items.length === 0) return null

  const normalizedChunkSize = Math.max(1, Math.floor(chunkSize))
  const currentIndex = currentAnchorId == null
    ? Math.max(0, items.length - normalizedChunkSize)
    : items.findIndex((item) => getId(item) === currentAnchorId)
  const safeCurrentIndex = currentIndex >= 0
    ? currentIndex
    : Math.max(0, items.length - normalizedChunkSize)

  return getId(items[Math.max(0, safeCurrentIndex - normalizedChunkSize)]!)
}

/** 返回向后扩展后的 exclusive 终点；null 表示已经扩展到当前尾部。 */
export function expandAgentHistoryWindowForward<T>(
  items: readonly T[],
  currentEndAnchorId: string | null,
  getId: (item: T) => string,
  chunkSize = DEFAULT_AGENT_HISTORY_WINDOW_SIZE,
): string | null {
  if (items.length === 0 || currentEndAnchorId == null) return null

  const normalizedChunkSize = Math.max(1, Math.floor(chunkSize))
  const currentEndIndex = items.findIndex((item) => getId(item) === currentEndAnchorId)
  if (currentEndIndex < 0) return null
  const nextEndIndex = Math.min(items.length, currentEndIndex + normalizedChunkSize)
  return nextEndIndex < items.length ? getId(items[nextEndIndex]!) : null
}

/**
 * 为未挂载的消息导航目标生成一个有界窗口，使目标位于窗口前 1/3 附近，
 * 同时给用户保留上下文，并允许继续向两个方向自动加载。
 */
export function resolveAgentHistoryNavigationRange<T>(
  items: readonly T[],
  targetId: string,
  getId: (item: T) => string,
  windowSize = DEFAULT_AGENT_HISTORY_WINDOW_SIZE,
): AgentHistoryRange | null {
  const targetIndex = items.findIndex((item) => getId(item) === targetId)
  if (targetIndex < 0) return null

  const normalizedWindowSize = Math.max(1, Math.floor(windowSize))
  const preferredContextBefore = Math.floor(normalizedWindowSize / 3)
  let startIndex = Math.max(0, targetIndex - preferredContextBefore)
  const endIndex = Math.min(items.length, startIndex + normalizedWindowSize)
  startIndex = Math.max(0, endIndex - normalizedWindowSize)

  return {
    startId: getId(items[startIndex]!),
    endId: endIndex < items.length ? getId(items[endIndex]!) : null,
  }
}

/** 计算顶部 prepend 后应恢复的 scrollTop，优先使用同一消息的几何偏移保持阅读锚点。 */
export function resolveAgentHistoryPreservedScrollTop(input: {
  previousScrollTop: number
  previousScrollHeight: number
  nextScrollHeight: number
  previousAnchorOffset: number | null
  nextAnchorOffset: number | null
}): number {
  const delta = input.previousAnchorOffset != null && input.nextAnchorOffset != null
    ? input.nextAnchorOffset - input.previousAnchorOffset
    : input.nextScrollHeight - input.previousScrollHeight
  return Math.max(0, input.previousScrollTop + delta)
}

/** 根据用户滚动方向和窗口边界决定是否无感补入历史。 */
export function resolveAgentHistoryLoadDirection(input: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  intent: 'up' | 'down'
  canLoadEarlier: boolean
  canLoadLater: boolean
  threshold?: number
}): AgentHistoryLoadDirection | null {
  const threshold = Math.max(0, input.threshold ?? 160)
  if (input.intent === 'up' && input.canLoadEarlier && input.scrollTop <= threshold) {
    return 'earlier'
  }
  const distanceFromBottom = input.scrollHeight - input.clientHeight - input.scrollTop
  if (input.intent === 'down' && input.canLoadLater && distanceFromBottom <= threshold) {
    return 'later'
  }
  return null
}

/** 只有用户显式扩展/导航产生的 range 才能跨 render 保留；切换会话立即失效。 */
export function resolveAgentHistoryRangeForSession(
  range: (AgentHistoryRange & { sessionId: string }) | null,
  sessionId: string,
): AgentHistoryRange | null {
  if (!range || range.sessionId !== sessionId) return null
  return { startId: range.startId, endId: range.endId }
}

import type { AgentSessionMeta } from '@domi/shared'

export type AgentProjectSessionSortMode = 'recent' | 'markers'

export interface AgentSessionTreeOrderItem {
  session: Pick<AgentSessionMeta, 'id' | 'updatedAt' | 'needsFollowUp' | 'starred'>
  childSessions: ReadonlyArray<Pick<AgentSessionMeta, 'needsFollowUp' | 'starred'>>
}

export function getSessionTreeManualMarkerPriority(item: AgentSessionTreeOrderItem): number {
  if (item.session.needsFollowUp || item.childSessions.some((session) => !!session.needsFollowUp)) return 0
  if (item.session.starred || item.childSessions.some((session) => !!session.starred)) return 1
  return 2
}

/**
 * 默认 recent 模式严格保留输入顺序，让 Flag / Star 切换不会导致会话跳位。
 * 只有用户在项目菜单显式选择 markers 模式时，才按待继续、星标、普通排序。
 */
export function orderSessionTreesForProject<T extends AgentSessionTreeOrderItem>(
  items: readonly T[],
  mode: AgentProjectSessionSortMode,
): T[] {
  if (mode === 'recent') return [...items]

  return [...items].sort((a, b) => {
    const markerDelta = getSessionTreeManualMarkerPriority(a) - getSessionTreeManualMarkerPriority(b)
    return markerDelta !== 0 ? markerDelta : b.session.updatedAt - a.session.updatedAt
  })
}

/**
 * 计算项目折叠预览中的非系统状态会话：
 * - 所有 Flag / Star 会话始终可见；
 * - 另外补充最近窗口内至多 previewLimit 条普通会话；
 * - 最终按输入顺序返回，避免人工标记把条目实时搬到另一个分区。
 */
export function selectStableProjectSessionPreview<T extends AgentSessionTreeOrderItem>(
  items: readonly T[],
  recentCutoff: number,
  previewLimit: number,
): T[] {
  const markedRootIds = new Set(
    items
      .filter((item) => getSessionTreeManualMarkerPriority(item) < 2)
      .map((item) => item.session.id),
  )
  const recentOrdinaryRootIds = new Set(
    items
      .filter((item) => (
        !markedRootIds.has(item.session.id)
        && item.session.updatedAt >= recentCutoff
      ))
      .slice(0, previewLimit)
      .map((item) => item.session.id),
  )

  return items.filter((item) => (
    markedRootIds.has(item.session.id)
    || recentOrdinaryRootIds.has(item.session.id)
  ))
}

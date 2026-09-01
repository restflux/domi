import type { WorkSidebarSortMode } from '../../types'

export interface SidebarSortableSession {
  title: string
  createdAt: number
  updatedAt: number
}

/**
 * Work 侧边栏按更新时间或创建时间倒序排列，并用标题作为稳定次级键。
 */
export function orderSidebarSessions<T extends SidebarSortableSession>(
  sessions: readonly T[],
  sortMode: WorkSidebarSortMode,
): T[] {
  return [...sessions].sort((left, right) => {
    const timestampDelta = sortMode === 'created'
      ? right.createdAt - left.createdAt
      : right.updatedAt - left.updatedAt
    if (timestampDelta !== 0) return timestampDelta
    return left.title.localeCompare(right.title, 'zh-CN', {
      numeric: true,
      sensitivity: 'base',
    })
  })
}

/** 一次展开或收起全部项目组，同时保留集合中不属于当前项目列表的状态。 */
export function toggleAllProjectGroups(
  collapsedGroupIds: ReadonlySet<string>,
  projectGroupIds: readonly string[],
): Set<string> {
  const next = new Set(collapsedGroupIds)
  const allCollapsed = projectGroupIds.length > 0
    && projectGroupIds.every((groupId) => collapsedGroupIds.has(groupId))

  for (const groupId of projectGroupIds) {
    if (allCollapsed) next.delete(groupId)
    else next.add(groupId)
  }
  return next
}

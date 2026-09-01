import type { WorkSidebarCustomGroup } from '../../types'

export interface WorkSidebarSessionItem {
  session: { id: string }
}

export interface GroupedWorkSidebarSessions<T extends WorkSidebarSessionItem> {
  groups: Array<{ group: WorkSidebarCustomGroup; items: T[] }>
  ungrouped: T[]
}

/**
 * 将会话移动到一个自定义分组。会话在任意时刻最多属于一个分组；targetGroupId 为 null 时回到未分组。
 */
export function assignSessionToCustomGroup(
  groups: readonly WorkSidebarCustomGroup[],
  sessionId: string,
  targetGroupId: string | null,
): WorkSidebarCustomGroup[] {
  return groups.map((group) => {
    const withoutSession = group.sessionIds.filter((id) => id !== sessionId)
    if (group.id !== targetGroupId) {
      return withoutSession.length === group.sessionIds.length
        ? group
        : { ...group, sessionIds: withoutSession }
    }
    return { ...group, sessionIds: [...withoutSession, sessionId] }
  })
}

/** 成员选择器中的切换行为：已在目标组则移回未分组，否则移动到目标组。 */
export function toggleSessionInCustomGroup(
  groups: readonly WorkSidebarCustomGroup[],
  sessionId: string,
  targetGroupId: string,
): WorkSidebarCustomGroup[] {
  const target = groups.find((group) => group.id === targetGroupId)
  return assignSessionToCustomGroup(
    groups,
    sessionId,
    target?.sessionIds.includes(sessionId) ? null : targetGroupId,
  )
}

/** 按当前可见会话顺序生成自定义分组，并把没有有效归属的会话留在未分组区。 */
export function groupWorkSidebarSessions<T extends WorkSidebarSessionItem>(
  items: readonly T[],
  groups: readonly WorkSidebarCustomGroup[],
): GroupedWorkSidebarSessions<T> {
  const assignedIds = new Set<string>()
  const grouped = groups.map((group) => {
    const memberIds = new Set(group.sessionIds)
    const groupItems = items.filter((item) => {
      const sessionId = item.session.id
      if (!memberIds.has(sessionId) || assignedIds.has(sessionId)) return false
      assignedIds.add(sessionId)
      return true
    })
    return { group, items: groupItems }
  })

  return {
    groups: grouped,
    ungrouped: items.filter((item) => !assignedIds.has(item.session.id)),
  }
}

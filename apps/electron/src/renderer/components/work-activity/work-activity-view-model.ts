import type { WorkSessionView } from '@domi/shared'

export interface WorkActivityFilters {
  query: string
  workspaceId: string
  source: string
}

export interface WorkActivityWorkspaceOption {
  id: string
  name: string
}

function workspaceKey(session: WorkSessionView): string {
  return session.workspaceId ?? session.workspaceName
}

export function collectWorkActivityWorkspaces(
  sessions: readonly WorkSessionView[],
): WorkActivityWorkspaceOption[] {
  return Array.from(new Map(
    sessions.map((session) => [
      workspaceKey(session),
      { id: workspaceKey(session), name: session.workspaceName },
    ]),
  ).values())
}

export function filterWorkActivitySessions(
  sessions: readonly WorkSessionView[],
  filters: WorkActivityFilters,
): WorkSessionView[] {
  const normalizedQuery = filters.query.trim().toLocaleLowerCase()
  return sessions.filter((session) => {
    if (filters.workspaceId !== 'all' && workspaceKey(session) !== filters.workspaceId) return false
    if (filters.source !== 'all' && session.source !== filters.source) return false
    if (!normalizedQuery) return true

    // 第一里程碑只搜索列表可见的轻量元数据，不读取会话正文、工具输出或文件内容。
    const searchableText = [
      session.title,
      session.workspaceName,
      session.phaseSummary,
      session.automationName ?? '',
    ].join(' ').toLocaleLowerCase()
    return searchableText.includes(normalizedQuery)
  })
}

export function describeWorkActivityRefreshError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const remoteReason = raw.match(/Error invoking remote method '[^']+':\s*(?:Error:\s*)?(.+)$/i)?.[1]
  const normalized = (remoteReason ?? raw)
    .replace(/^Error:\s*/i, '')
    .replace(/^读取工作动态失败[：:]\s*/u, '')
    .trim()

  if (/No handler registered/i.test(normalized)) {
    return '当前主进程未注册工作动态接口，请重启对应的开发实例'
  }
  if (/getWorkActivity.*(?:is not a function|undefined)/i.test(normalized)) {
    return '当前 Preload 未提供工作动态接口，请重启对应的开发实例'
  }
  if (!normalized) return '未知宿主错误'
  return normalized.length > 160 ? `${normalized.slice(0, 157)}…` : normalized
}

export function describeWorkActivityStopImpact(session: WorkSessionView): string {
  const runningChildCount = Math.max(
    0,
    session.activeSessionIds.filter((sessionId) => sessionId !== session.rootSessionId).length,
  )
  return runningChildCount > 0
    ? `当前执行和 ${runningChildCount} 个运行中的子 Agent 将被中断；已有文件改动会保留。`
    : '当前执行将被中断；已有文件改动会保留。'
}

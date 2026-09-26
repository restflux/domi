import type { AgentSessionMeta, AgentWorkspace } from '@domi/shared'

/** ZCode 的 Workspace → Task 分层映射：会话只作为 v2 Task 行的只读身份。 */
export interface WorkspaceTaskGroupV2 {
  workspace: AgentWorkspace
  sessions: AgentSessionMeta[]
  hiddenCount: number
}

const INITIAL_TASK_LIMIT = 24

export function selectWorkspaceTaskGroupsV2(
  workspaces: readonly AgentWorkspace[],
  sessions: readonly AgentSessionMeta[],
  visibleLimit = INITIAL_TASK_LIMIT,
): WorkspaceTaskGroupV2[] {
  const byWorkspace = new Map<string, AgentSessionMeta[]>()
  for (const session of sessions) {
    if (session.archived || session.sideChatParentSessionId || !session.workspaceId) continue
    const group = byWorkspace.get(session.workspaceId) ?? []
    group.push(session)
    byWorkspace.set(session.workspaceId, group)
  }
  return workspaces.map((workspace) => {
    const all = byWorkspace.get(workspace.id) ?? []
    all.sort((a, b) => b.updatedAt - a.updatedAt)
    return { workspace, sessions: all.slice(0, visibleLimit), hiddenCount: Math.max(0, all.length - visibleLimit) }
  })
}

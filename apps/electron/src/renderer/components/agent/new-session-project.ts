import type { AgentWorkspace, CreateAgentWorkspaceInput } from '@domi/shared'
import { normalizePathForCompare } from '@domi/shared'

interface LocalProjectSelection {
  path: string
  name: string
}

interface OpenLocalProjectDependencies {
  workspaces: readonly AgentWorkspace[]
  chooseFolder(): Promise<LocalProjectSelection | null>
  createWorkspace(input: CreateAgentWorkspaceInput): Promise<AgentWorkspace>
}

/** 已有目录优先复用项目；新目录只创建 workspace，不额外创建一个空白会话。 */
export async function selectLocalDraftProject({
  workspaces,
  chooseFolder,
  createWorkspace,
}: OpenLocalProjectDependencies): Promise<{ workspace: AgentWorkspace; created: boolean } | null> {
  const folder = await chooseFolder()
  if (!folder) return null
  const existing = workspaces.find((workspace) => workspace.projectRootPath
    && normalizePathForCompare(workspace.projectRootPath) === normalizePathForCompare(folder.path))
  if (existing) return { workspace: existing, created: false }
  const workspace = await createWorkspace({ name: folder.name, projectRootPath: folder.path })
  return { workspace, created: true }
}

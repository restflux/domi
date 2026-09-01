/** 轻量 Git 面板只读状态契约。Renderer 永远不能从这些类型获得物理 checkout 路径。 */

export type GitWorkspaceChangeLayer = 'conflict' | 'staged' | 'unstaged' | 'untracked'

export type GitWorkspaceChangeStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'conflicted'
  | 'untracked'

export interface GitWorkspaceFileChange {
  /** 相对于当前 Session Target 项目根的规范化路径。 */
  relativePath: string
  /** rename/copy 的旧路径，同样相对于 Session Target 项目根。 */
  previousPath?: string
  layer: GitWorkspaceChangeLayer
  status: GitWorkspaceChangeStatus
  additions: number
  deletions: number
}

export interface GitRepositorySnapshot {
  /** 不透明仓库标识；不能被 Renderer 当成路径。 */
  repositoryId: string
  /** 面向用户的仓库名或项目内相对目录名。 */
  displayName: string
  /** null 表示 Detached HEAD 或 unborn 状态。 */
  branch: string | null
  detached: boolean
  unborn: boolean
  headOid: string | null
  upstream: string | null
  ahead: number
  behind: number
  conflicts: GitWorkspaceFileChange[]
  staged: GitWorkspaceFileChange[]
  unstaged: GitWorkspaceFileChange[]
  untracked: GitWorkspaceFileChange[]
  /** 绑定本地 HEAD/index/worktree 状态的只读刷新令牌。 */
  stateToken: string
}

export type GitWorkspaceErrorCode =
  | 'target-unavailable'
  | 'git-unavailable'
  | 'scan-failed'
  | 'invalid-request'

export interface GitWorkspaceError {
  code: GitWorkspaceErrorCode
  message: string
}

export interface GitWorkspaceSnapshot {
  target: { kind: 'local' | 'isolated' }
  repositories: GitRepositorySnapshot[]
  scannedAt: number
  error?: GitWorkspaceError
}

export interface GitWorkspaceInspectInput {
  sessionId: string
  /** 手动刷新可绕过短期结果缓存，但仍复用同一时刻的 in-flight 扫描。 */
  force?: boolean
}

export interface GitWorkspaceDiffRequest {
  sessionId: string
  repositoryId: string
  relativePath: string
  layer: GitWorkspaceChangeLayer
}

export interface GitWorkspaceDiffContents {
  oldContent: string
  newContent: string
}

/** 历史条目 refs（tag 徽章数据源）。 */
export interface GitWorkspaceRef {
  kind: 'tag' | 'branch' | 'remote' | 'head'
  name: string
}

export interface GitWorkspaceLogEntry {
  oid: string
  shortOid: string
  subject: string
  authorName: string
  authorEmail: string
  /** Unix 秒。 */
  authorDate: number
  /** 按 %D 解析，保留 tag/branch 徽章所需。 */
  refs: GitWorkspaceRef[]
  parents: string[]
  /** true 表示该提交已推送到 upstream 跟踪分支（在远程可达历史内）。 */
  onRemote: boolean
  /** 提交正文（subject 之后的完整描述，可能含多行换行；无正文时省略）。 */
  body?: string
}

export interface GitWorkspaceHistoryRequest {
  sessionId: string
  repositoryId: string
  /** 默认 30，上限 200。 */
  limit?: number
}

export interface GitWorkspaceHistoryResult {
  entries: GitWorkspaceLogEntry[]
}

export interface GitWorkspaceBranchesRequest {
  sessionId: string
  repositoryId: string
}

export interface GitWorkspaceBranchesResult {
  /** 当前分支（detached 时为 null）。 */
  current: string | null
  local: string[]
}

export interface GitWorkspaceStageRequest {
  sessionId: string
  repositoryId: string
  /** 空数组表示全部。 */
  relativePaths: string[]
  action: 'stage' | 'unstage'
}

export interface GitWorkspaceDiscardRequest {
  sessionId: string
  repositoryId: string
  relativePaths: string[]
  layer: GitWorkspaceChangeLayer
}

export interface GitWorkspaceCommitRequest {
  sessionId: string
  repositoryId: string
  message: string
  push?: boolean
}

export interface GitWorkspaceCheckoutRequest {
  sessionId: string
  repositoryId: string
  branch: string
}

export interface GitWorkspacePullPushRequest {
  sessionId: string
  repositoryId: string
  /** fetch 仅刷新远端引用；sync 始终按 pull --ff-only → push 执行。 */
  action: 'fetch' | 'pull' | 'push' | 'sync'
}

export interface GitWorkspaceOperationResult {
  ok: boolean
  /** 失败时的用户可读信息（git stderr 摘要）。 */
  message?: string
}

export interface GitWorkspaceCommitFileEntry {
  relativePath: string
  status: GitWorkspaceChangeStatus
}

export interface GitWorkspaceCommitFilesRequest {
  sessionId: string
  repositoryId: string
  oid: string
}

export interface GitWorkspaceCommitFilesResult {
  files: GitWorkspaceCommitFileEntry[]
}

export interface GitWorkspaceCommitDiffRequest {
  sessionId: string
  repositoryId: string
  oid: string
  relativePath: string
}

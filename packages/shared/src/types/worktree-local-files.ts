/** 清单只声明路径；本机确认由 Main 单独持久化，不包含文件内容。 */
export interface WorktreeLocalFileEntry {
  path: string
  status: 'ready' | 'missing' | 'unapproved'
}

export interface WorktreeLocalFileOverwrite {
  path: string
  expectedFingerprint: string
}

export interface WorktreeLocalFilesTarget {
  sessionId: string
  revision: number
  canPrepare: boolean
  files: Array<{ path: string; exists: boolean; fingerprint: string }>
}

export interface WorktreeLocalFilesView {
  projectId: string
  manifestVersion: string
  entries: WorktreeLocalFileEntry[]
  target?: WorktreeLocalFilesTarget
}

export interface WorktreeLocalFilesCopyResult {
  copied: string[]
  skipped: string[]
}

export interface WorktreeLocalFilesError {
  code: string
  message: string
}

export type WorktreeLocalFilesResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: WorktreeLocalFilesError }

/** 只含项目相对路径与元数据，不包含文件内容或绝对源根。 */
export interface WorktreeLocalFilesNode {
  path: string
  name: string
  kind: 'file' | 'directory'
  selectable: boolean
  reason?: string
}

export interface WorktreeLocalFilesDirectory {
  directory: string
  entries: WorktreeLocalFilesNode[]
}

export interface WorktreeLocalFileSelectionIssue {
  path: string
  reason: string
}

export interface WorktreeLocalFileSelection {
  paths: string[]
  skipped: WorktreeLocalFileSelectionIssue[]
}

export interface WorktreeLocalFilesRendererApi {
  inspect(input: { projectId: string; sessionId?: string }): Promise<WorktreeLocalFilesResult<WorktreeLocalFilesView>>
  listDirectory(input: { projectId: string; directory: string; query?: string }): Promise<WorktreeLocalFilesResult<WorktreeLocalFilesDirectory>>
  resolveSelection(input: { projectId: string; paths: string[]; existingPaths: string[] }): Promise<WorktreeLocalFilesResult<WorktreeLocalFileSelection>>
  save(input: { projectId: string; expectedVersion: string; paths: string[] }): Promise<WorktreeLocalFilesResult<WorktreeLocalFilesView>>
  confirm(input: { projectId: string; expectedVersion: string }): Promise<WorktreeLocalFilesResult<WorktreeLocalFilesView>>
  prepare(input: { sessionId: string; expectedRevision: number; overwriteFiles?: WorktreeLocalFileOverwrite[] }): Promise<WorktreeLocalFilesResult<WorktreeLocalFilesCopyResult>>
}

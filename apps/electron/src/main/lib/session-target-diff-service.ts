import { isAbsolute, relative, win32 } from 'node:path'
import type {
  FileAccessOptions,
  SessionTargetFileRequest,
  UnstagedChangesResult,
  WorktreeInfo,
} from '@domi/shared'
import type {
  ActiveSessionDiffTarget,
  AuthorizedSessionDiffRequest,
} from './session-target-file-access-service.ts'

export type SessionTargetDiffRoute<T> =
  | { handled: false }
  | { handled: true; value: T }

interface SessionTargetDiffAccess {
  isActivePiSession(options?: FileAccessOptions): options is FileAccessOptions & { sessionId: string }
  resolveActiveDiffTarget(
    sessionId: string | undefined,
    submittedRoot?: unknown,
  ): Promise<ActiveSessionDiffTarget | null>
  authorizeDiffRequest(input: {
    sessionId?: string
    relativePath: string
  }): Promise<AuthorizedSessionDiffRequest | null>
}

interface DiffContents {
  oldContent: string
  newContent: string
}

export interface SessionTargetDiffDependencies {
  access: SessionTargetDiffAccess
  getUnstagedChanges(root: string): Promise<UnstagedChangesResult>
  getWorktreeChanges(root: string, baseOid: string): Promise<UnstagedChangesResult>
  getFileDiff(dirPath: string, filePath: string, gitRoot?: string): Promise<string>
  getUntrackedContent(dirPath: string, filePath: string, gitRoot?: string): Promise<string>
  revertFile(dirPath: string, filePath: string, gitRoot?: string, sourceRef?: string): Promise<void>
  getDiffContents(
    dirPath: string,
    filePath: string,
    gitRoot?: string,
    baseRef?: string,
  ): Promise<DiffContents | null>
  listWorktrees(root: string): Promise<WorktreeInfo[]>
}

const EMPTY_CHANGES: UnstagedChangesResult = {
  isGitRepo: false,
  files: [],
  untrackedFiles: [],
  gitRootNames: [],
}

const SESSION_TARGET_GIT_KEY = 'session-target'

function projectSessionChanges(
  value: UnstagedChangesResult,
  target: ActiveSessionDiffTarget,
): UnstagedChangesResult {
  if (!value.isGitRepo) return EMPTY_CHANGES
  const projectPrefix = relative(target.gitRoot, target.root).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
  if (projectPrefix === '..' || projectPrefix.startsWith('../') || isAbsolute(projectPrefix)) return EMPTY_CHANGES

  const projectPath = (reportedGitRoot: string, reportedPath: string): string | null => {
    const normalizedPath = reportedPath.replace(/\\/g, '/').replace(/^\.\//, '')
    if (
      !normalizedPath
      || isAbsolute(normalizedPath)
      || win32.isAbsolute(normalizedPath)
      || normalizedPath.split('/').includes('..')
      || (!isAbsolute(reportedGitRoot) && !win32.isAbsolute(reportedGitRoot))
    ) return null

    // getWorktreeChanges 已把 Git 子目录项目投影为项目相对路径；保留该结果。
    // 通用 Local diff 仍可能返回 repo-relative 路径，需在此剥离 project prefix。
    const nestedRootPrefix = relative(target.root, reportedGitRoot)
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/$/, '')
    if (!nestedRootPrefix) return normalizedPath
    if (
      nestedRootPrefix !== '..'
      && !nestedRootPrefix.startsWith('../')
      && !isAbsolute(nestedRootPrefix)
      && !win32.isAbsolute(nestedRootPrefix)
    ) {
      return `${nestedRootPrefix}/${normalizedPath}`
    }

    const reportedProjectPrefix = relative(reportedGitRoot, target.root)
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/\/$/, '')
    if (reportedProjectPrefix !== projectPrefix) return null
    if (!projectPrefix) return normalizedPath
    const prefix = `${projectPrefix}/`
    return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : null
  }

  return {
    isGitRepo: true,
    files: value.files.flatMap((file) => {
      const filePath = projectPath(file.gitRoot, file.filePath)
      return filePath ? [{ ...file, filePath, gitRoot: SESSION_TARGET_GIT_KEY }] : []
    }),
    untrackedFiles: value.untrackedFiles.flatMap((file) => {
      const filePath = projectPath(file.gitRoot, file.filePath)
      return filePath ? [{ filePath, gitRoot: SESSION_TARGET_GIT_KEY }] : []
    }),
    gitRootNames: ['Session Target'],
  }
}

/** 隐藏 active Pi 的 Session Base、checkout kind 与 Git 实现选择。 */
export class SessionTargetDiffService {
  constructor(private readonly dependencies: SessionTargetDiffDependencies) {}

  private activeSessionId(sessionId: string | undefined): string | null {
    const access: FileAccessOptions | undefined = sessionId ? { sessionId } : undefined
    return this.dependencies.access.isActivePiSession(access) ? access.sessionId : null
  }

  async getChanges(
    sessionId: string | undefined,
    submittedRoot?: unknown,
  ): Promise<SessionTargetDiffRoute<UnstagedChangesResult>> {
    const activeSessionId = this.activeSessionId(sessionId)
    if (!activeSessionId) return { handled: false }
    const target = await this.dependencies.access.resolveActiveDiffTarget(activeSessionId, submittedRoot)
    if (!target) return { handled: true, value: EMPTY_CHANGES }
    const rawValue = target.kind === 'isolated'
      ? await this.dependencies.getWorktreeChanges(target.root, target.baseOid)
      : await this.dependencies.getUnstagedChanges(target.root)
    return { handled: true, value: projectSessionChanges(rawValue, target) }
  }

  async getFileDiff(input: SessionTargetFileRequest): Promise<SessionTargetDiffRoute<string>> {
    const activeSessionId = this.activeSessionId(input.sessionId)
    if (!activeSessionId) return { handled: false }
    const authorized = await this.dependencies.access.authorizeDiffRequest(input)
    const value = authorized
      ? await this.dependencies.getFileDiff(authorized.dirPath, authorized.filePath, authorized.gitRoot)
      : ''
    return { handled: true, value }
  }

  async getUntrackedContent(input: SessionTargetFileRequest): Promise<SessionTargetDiffRoute<string>> {
    const activeSessionId = this.activeSessionId(input.sessionId)
    if (!activeSessionId) return { handled: false }
    const authorized = await this.dependencies.access.authorizeDiffRequest(input)
    const value = authorized
      ? await this.dependencies.getUntrackedContent(authorized.dirPath, authorized.filePath, authorized.gitRoot)
      : ''
    return { handled: true, value }
  }

  async revertFile(input: SessionTargetFileRequest): Promise<SessionTargetDiffRoute<void>> {
    const activeSessionId = this.activeSessionId(input.sessionId)
    if (!activeSessionId) return { handled: false }
    const authorized = await this.dependencies.access.authorizeDiffRequest(input)
    if (authorized) {
      await this.dependencies.revertFile(
        authorized.dirPath,
        authorized.filePath,
        authorized.gitRoot,
        authorized.baseOid,
      )
    }
    return { handled: true, value: undefined }
  }

  async getDiffContents(input: SessionTargetFileRequest): Promise<SessionTargetDiffRoute<DiffContents | null>> {
    const activeSessionId = this.activeSessionId(input.sessionId)
    if (!activeSessionId) return { handled: false }
    const authorized = await this.dependencies.access.authorizeDiffRequest(input)
    const value = authorized
      ? await this.dependencies.getDiffContents(
          authorized.dirPath,
          authorized.filePath,
          authorized.gitRoot,
          authorized.baseOid,
        )
      : null
    return { handled: true, value }
  }

  async listWorktrees(
    sessionId: string | undefined,
    submittedRoot: unknown,
  ): Promise<SessionTargetDiffRoute<WorktreeInfo[]>> {
    const activeSessionId = this.activeSessionId(sessionId)
    if (!activeSessionId) return { handled: false }
    await this.dependencies.access.resolveActiveDiffTarget(activeSessionId, submittedRoot)
    return { handled: true, value: [] }
  }

  async getWorktreeChanges(
    sessionId: string | undefined,
    submittedRoot: unknown,
  ): Promise<SessionTargetDiffRoute<UnstagedChangesResult>> {
    const activeSessionId = this.activeSessionId(sessionId)
    if (!activeSessionId) return { handled: false }
    const target = await this.dependencies.access.resolveActiveDiffTarget(activeSessionId, submittedRoot)
    return {
      handled: true,
      value: target
        ? projectSessionChanges(
            await this.dependencies.getWorktreeChanges(target.root, target.baseOid),
            target,
          )
        : EMPTY_CHANGES,
    }
  }
}

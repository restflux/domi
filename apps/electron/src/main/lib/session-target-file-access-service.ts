import { readdirSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import type { FileAccessOptions, SessionTargetFileInspection } from '@domi/shared'

export interface SessionTargetFileAccessSession {
  workspaceId?: string
  sessionTarget?: { kind: 'unselected' | 'local' | 'isolated' }
  attachedDirectories?: string[]
  attachedFiles?: string[]
}

export interface SessionTargetFileAccessWorkspace {
  slug: string
}

export interface SessionTargetInspection {
  baseOid: string
  kind: 'local' | 'isolated'
}

export interface SessionTargetFileAccessDependencies {
  getSession(sessionId: string): SessionTargetFileAccessSession | undefined
  getWorkspace(workspaceId: string): SessionTargetFileAccessWorkspace | undefined
  getProjectRoot(workspaceSlug: string): string
  getSessionWorkbenchRoot(sessionId: string): string | null
  getWorkspaceAttachedDirectories(workspaceSlug: string): string[]
  getWorkspaceAttachedFiles(workspaceSlug: string): string[]
  resolveTargetRoot(sessionId: string): Promise<string>
  inspectTarget(sessionId: string): Promise<SessionTargetInspection>
  resolveGitRoot(targetRoot: string): Promise<string | null>
}

export interface AuthorizedSessionDiffRequest {
  dirPath: string
  filePath: string
  gitRoot: string
  baseOid: string
}

export interface ActiveSessionDiffTarget {
  root: string
  gitRoot: string
  baseOid: string
  kind: 'local' | 'isolated'
}

export interface ActiveSessionSearchTarget {
  root: string
  attachedRoots: string[]
}

export interface ResolvedSessionTargetDirectory {
  /** 当前 lease 的 canonical 根，仅供主进程在同一次目录读取中复用。 */
  rootPath: string
  /** 已验证位于 rootPath 内的 canonical 目录。 */
  directoryPath: string
}

interface CanonicalCandidateOptions {
  allowMissingLeaf?: boolean
}

const PREVIEW_BASENAME_SEARCH_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', '__pycache__', '.venv', 'build', '.cache', 'target',
])
const PREVIEW_BASENAME_SEARCH_MAX_DEPTH = 8
const PREVIEW_BASENAME_SEARCH_MAX_DIRS = 2_000

function comparablePath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function canonicalExistingPath(path: string): string | null {
  try {
    return realpathSync(resolve(path))
  } catch {
    return null
  }
}

/**
 * 新文件只允许最后一级不存在。先 realpath 已存在父目录，再拼接 lexical leaf，
 * 避免 symlink/junction 父目录把写入导向租约外。
 */
function canonicalCandidatePath(path: string, options: CanonicalCandidateOptions = {}): string | null {
  const existing = canonicalExistingPath(path)
  if (existing) return existing
  if (!options.allowMissingLeaf) return null

  const lexicalPath = resolve(path)
  const leaf = basename(lexicalPath)
  if (!leaf || leaf === '.' || leaf === '..') return null
  const canonicalParent = canonicalExistingPath(dirname(lexicalPath))
  return canonicalParent ? join(canonicalParent, leaf) : null
}

function isUnderCanonicalRoot(candidate: string, canonicalRoot: string): boolean {
  const candidateForCompare = comparablePath(candidate)
  const rootForCompare = comparablePath(canonicalRoot)
  const relativePath = relative(rootForCompare, candidateForCompare)
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  )
}

function isCandidateAllowed(candidate: string, root: string): boolean {
  const canonicalRoot = canonicalExistingPath(root)
  if (!canonicalRoot) return false
  try {
    if (statSync(canonicalRoot).isFile()) {
      return comparablePath(candidate) === comparablePath(canonicalRoot)
    }
  } catch {
    return false
  }
  return isUnderCanonicalRoot(candidate, canonicalRoot)
}

/**
 * Agent Session Target 的文件能力边界。它保护 session-scoped IPC 与所有 Agent UI 调用。
 */
export class SessionTargetFileAccessService {
  constructor(private readonly dependencies: SessionTargetFileAccessDependencies) {}

  isActivePiSession(options?: FileAccessOptions): options is FileAccessOptions & { sessionId: string } {
    return typeof options?.sessionId === 'string'
      && this.dependencies.getSession(options.sessionId) !== undefined
  }

  /** Pi 缺省使用 checkout 相对路径；其他绝对路径空间必须显式声明。 */
  usesSessionTargetPathSpace(options?: FileAccessOptions): options is FileAccessOptions & {
    sessionId: string
    pathSpace?: 'session-target'
  } {
    return this.isActivePiSession(options)
      && options.pathSpace !== 'session-workbench'
      && options.pathSpace !== 'session-local-project'
  }

  private getAttachedRoots(sessionId: string): string[] {
    const session = this.dependencies.getSession(sessionId)
    if (!session) return []
    const roots = [
      ...(session.attachedDirectories ?? []),
      ...(session.attachedFiles ?? []),
    ]
    if (!session.workspaceId) return roots
    const workspace = this.dependencies.getWorkspace(session.workspaceId)
    if (!workspace) return roots
    roots.push(
      ...this.dependencies.getWorkspaceAttachedDirectories(workspace.slug),
      ...this.dependencies.getWorkspaceAttachedFiles(workspace.slug),
    )
    return roots
  }

  private async getAuthorizedRoots(sessionId: string): Promise<string[]> {
    return [
      await this.dependencies.resolveTargetRoot(sessionId),
      ...this.getAttachedRoots(sessionId),
    ]
  }

  /** 只接受当前会话私有 workbench 的精确根，供文件搜索安全选择路径空间。 */
  resolveSessionWorkbenchRoot(sessionId: string, submittedRoot: unknown): string | null {
    const options: FileAccessOptions = { sessionId }
    if (!this.isActivePiSession(options) || typeof submittedRoot !== 'string') return null
    const workbenchRoot = this.dependencies.getSessionWorkbenchRoot(sessionId)
    if (!workbenchRoot || !this.isExactRoot(submittedRoot, workbenchRoot)) return null
    return canonicalExistingPath(workbenchRoot)
  }

  isSessionWorkbenchRoot(sessionId: string, candidate: string): boolean {
    return this.resolveSessionWorkbenchRoot(sessionId, candidate) !== null
  }

  private async isSessionExplicitlyUnbound(sessionId: string): Promise<boolean> {
    const session = this.dependencies.getSession(sessionId)
    if (session?.sessionTarget?.kind !== 'unselected') return false
    try {
      // registry 中已有绑定时，以 checkout 事实为准，拒绝旧的 Local 浏览能力。
      await this.dependencies.inspectTarget(sessionId)
      return false
    } catch (error) {
      return Boolean(error && typeof error === 'object' && 'code' in error
        && error.code === 'target_unselected')
    }
  }

  /** 未绑定 Pi 会话可浏览默认 Local 项目，但不能借此穿透已绑定的 Isolated lease。 */
  async resolveSessionLocalProjectRoot(sessionId: string, submittedRoot: unknown): Promise<string | null> {
    const session = this.dependencies.getSession(sessionId)
    if (!await this.isSessionExplicitlyUnbound(sessionId)
      || !session?.workspaceId
      || typeof submittedRoot !== 'string') return null
    const workspace = this.dependencies.getWorkspace(session.workspaceId)
    if (!workspace) return null
    const projectRoot = this.dependencies.getProjectRoot(workspace.slug)
    if (!projectRoot || !this.isExactRoot(submittedRoot, projectRoot)) return null
    return canonicalExistingPath(projectRoot)
  }

  async authorizeSessionWorkbenchRequest(
    filePath: string,
    options?: FileAccessOptions,
    candidateOptions: CanonicalCandidateOptions = {},
  ): Promise<boolean> {
    if (!this.isActivePiSession(options) || options.pathSpace !== 'session-workbench') return false
    const workbenchRoot = this.dependencies.getSessionWorkbenchRoot(options.sessionId)
    const candidate = canonicalCandidatePath(filePath, candidateOptions)
    return Boolean(workbenchRoot && candidate && isCandidateAllowed(candidate, workbenchRoot))
  }

  async authorizeSessionLocalProjectRequest(
    filePath: string,
    options?: FileAccessOptions,
    candidateOptions: CanonicalCandidateOptions = {},
  ): Promise<boolean> {
    if (!this.isActivePiSession(options) || options.pathSpace !== 'session-local-project') return false
    const session = this.dependencies.getSession(options.sessionId)
    if (!await this.isSessionExplicitlyUnbound(options.sessionId) || !session?.workspaceId) return false
    const workspace = this.dependencies.getWorkspace(session.workspaceId)
    const candidate = canonicalCandidatePath(filePath, candidateOptions)
    return Boolean(workspace && candidate
      && isCandidateAllowed(candidate, this.dependencies.getProjectRoot(workspace.slug)))
  }

  /** renderer 的 pathSpace 只决定采用哪条精确授权边界，不扩张授权根。 */
  async authorizeFileRequest(
    filePath: string,
    options?: FileAccessOptions,
    candidateOptions: CanonicalCandidateOptions = {},
  ): Promise<boolean> {
    if (options?.pathSpace === 'session-workbench') {
      return this.authorizeSessionWorkbenchRequest(filePath, options, candidateOptions)
    }
    if (options?.pathSpace === 'session-local-project') {
      return this.authorizeSessionLocalProjectRequest(filePath, options, candidateOptions)
    }
    return this.authorizeSessionFileRequest(filePath, options, candidateOptions)
  }

  /**
   * 兼容历史消息、附件与工具结果中已经持久化的绝对路径。
   *
   * 该入口只供只读预览 IPC 使用：renderer 没有声明 pathSpace 时，主进程依据
   * 当前会话的真实授权根识别路径属于 Session Target、session workbench、
   * 已附加路径，还是尚未绑定 target 时的 Local 项目。调用方不能借此扩张授权根。
   */
  async resolveLegacyAbsolutePreviewPath(
    filePath: string,
    options?: FileAccessOptions,
  ): Promise<string | null> {
    if (!this.isActivePiSession(options)
      || options.pathSpace !== undefined
      || (!isAbsolute(filePath) && !win32.isAbsolute(filePath))) {
      return null
    }

    const candidate = canonicalCandidatePath(filePath)
    if (!candidate) return null

    const workbenchAccess: FileAccessOptions = {
      ...options,
      pathSpace: 'session-workbench',
    }
    if (await this.authorizeSessionWorkbenchRequest(candidate, workbenchAccess)) {
      return candidate
    }

    if (await this.authorizeSessionFileRequest(candidate, options)) {
      return candidate
    }

    const localProjectAccess: FileAccessOptions = {
      ...options,
      pathSpace: 'session-local-project',
    }
    return await this.authorizeSessionLocalProjectRequest(candidate, localProjectAccess)
      ? candidate
      : null
  }

  /**
   * 仅供只读预览兼容历史正文中的裸文件名。
   * 在当前 Session Target 内受限搜索，且只有唯一命中时才返回，避免同名文件误绑。
   */
  async resolveUniquePreviewBasename(sessionId: string, fileName: string): Promise<string | null> {
    const options: FileAccessOptions = { sessionId }
    if (!this.isActivePiSession(options)
      || typeof fileName !== 'string'
      || !fileName
      || fileName === '.'
      || fileName === '..'
      || fileName.includes('/')
      || fileName.includes('\\')
      || fileName.includes('\0')) return null

    try {
      const root = canonicalExistingPath(await this.dependencies.resolveTargetRoot(sessionId))
      if (!root) return null

      const expectedName = process.platform === 'win32' ? fileName.toLowerCase() : fileName
      let scannedDirs = 0
      let match: string | null = null
      let ambiguous = false

      const walk = (current: string, depth: number): void => {
        if (ambiguous || depth > PREVIEW_BASENAME_SEARCH_MAX_DEPTH || scannedDirs >= PREVIEW_BASENAME_SEARCH_MAX_DIRS) return
        scannedDirs++

        let entries: Dirent[]
        try {
          entries = readdirSync(current, { withFileTypes: true })
        } catch {
          return
        }

        for (const entry of entries) {
          if (!entry.isFile()) continue
          const entryName = process.platform === 'win32' ? entry.name.toLowerCase() : entry.name
          if (entryName !== expectedName) continue
          const candidate = canonicalExistingPath(join(current, entry.name))
          if (!candidate || !isUnderCanonicalRoot(candidate, root)) continue
          if (match && comparablePath(match) !== comparablePath(candidate)) {
            ambiguous = true
            return
          }
          match = candidate
        }

        for (const entry of entries) {
          if (ambiguous || scannedDirs >= PREVIEW_BASENAME_SEARCH_MAX_DIRS) return
          if (!entry.isDirectory()
            || entry.name.startsWith('.')
            || PREVIEW_BASENAME_SEARCH_SKIP_DIRS.has(entry.name)) continue
          walk(join(current, entry.name), depth + 1)
        }
      }

      walk(root, 0)
      return ambiguous ? null : match
    } catch {
      return null
    }
  }

  async resolveRelativeDirectory(
    sessionId: string,
    relativePath: string,
  ): Promise<ResolvedSessionTargetDirectory | null> {
    const options: FileAccessOptions = { sessionId }
    if (!this.isActivePiSession(options) || typeof relativePath !== 'string') return null
    const segments = relativePath.split(/[\\/]+/)
    if (isAbsolute(relativePath) || win32.isAbsolute(relativePath) || segments.includes('..')) return null

    // 目录列表必须让 checkout 解析错误冒泡给 UI，不能把暂时不可用伪装成空目录。
    const root = await this.dependencies.resolveTargetRoot(sessionId)
    const canonicalRoot = canonicalExistingPath(root)
    if (!canonicalRoot) throw new Error('工作目录暂时不可用')
    const directoryPath = canonicalCandidatePath(resolve(canonicalRoot, relativePath || '.'))
    if (!directoryPath || !isUnderCanonicalRoot(directoryPath, canonicalRoot)) return null
    return { rootPath: canonicalRoot, directoryPath }
  }

  async resolveRelative(
    sessionId: string,
    relativePath: string,
    allowMissingLeaf = false,
  ): Promise<string | null> {
    const options: FileAccessOptions = { sessionId }
    if (!this.isActivePiSession(options) || typeof relativePath !== 'string') return null
    const segments = relativePath.split(/[\\/]+/)
    if (isAbsolute(relativePath) || win32.isAbsolute(relativePath) || segments.includes('..')) return null

    try {
      if (!allowMissingLeaf) {
        return (await this.resolveRelativeDirectory(sessionId, relativePath))?.directoryPath ?? null
      }
      const root = await this.dependencies.resolveTargetRoot(sessionId)
      const canonicalRoot = canonicalExistingPath(root)
      if (!canonicalRoot) return null
      const candidate = canonicalCandidatePath(resolve(canonicalRoot, relativePath || '.'), { allowMissingLeaf: true })
      return candidate && isUnderCanonicalRoot(candidate, canonicalRoot) ? candidate : null
    } catch {
      return null
    }
  }

  /** 一次解析 Session Target 根并投影多个既有文件，避免历史产物列表逐项获取 checkout lease。 */
  async resolveExistingRelativeFiles(sessionId: string, relativePaths: readonly string[]): Promise<Map<string, string>> {
    const options: FileAccessOptions = { sessionId }
    const resolvedFiles = new Map<string, string>()
    if (!this.isActivePiSession(options) || relativePaths.length === 0) return resolvedFiles

    try {
      const root = await this.dependencies.resolveTargetRoot(sessionId)
      const canonicalRoot = canonicalExistingPath(root)
      if (!canonicalRoot) return resolvedFiles
      for (const relativePath of relativePaths) {
        if (typeof relativePath !== 'string') continue
        const segments = relativePath.split(/[\\/]+/)
        if (isAbsolute(relativePath) || win32.isAbsolute(relativePath) || segments.includes('..')) continue
        const candidate = canonicalCandidatePath(resolve(canonicalRoot, relativePath))
        if (candidate && isUnderCanonicalRoot(candidate, canonicalRoot)) {
          resolvedFiles.set(relativePath, candidate)
        }
      }
    } catch {
      // 历史 Worktree 暂不可用时返回空列表，不影响会话其余文件浏览。
    }
    return resolvedFiles
  }

  projectRelativePathFromRoot(rootPath: string, filePath: string): string | null {
    const root = canonicalExistingPath(rootPath)
    const candidate = canonicalExistingPath(filePath)
    if (!root || !candidate || !isUnderCanonicalRoot(candidate, root)) return null
    const projected = relative(root, candidate).replace(/\\/g, '/')
    return projected || '.'
  }

  async projectRelativePath(sessionId: string, filePath: string): Promise<string | null> {
    const options: FileAccessOptions = { sessionId }
    if (!this.isActivePiSession(options)) return null
    try {
      const root = await this.dependencies.resolveTargetRoot(sessionId)
      return this.projectRelativePathFromRoot(root, filePath)
    } catch {
      return null
    }
  }

  /**
   * 把 Agent 写工具提供的绝对或相对路径投影回当前 Session Target。
   * 只允许 target 内路径；renderer 永远拿不到实际 checkout 根。
   */
  async inspectTargetFile(
    sessionId: string,
    filePath: string,
    allowMissingLeaf = false,
  ): Promise<SessionTargetFileInspection | null> {
    const options: FileAccessOptions = { sessionId }
    if (!this.isActivePiSession(options) || typeof filePath !== 'string' || !filePath) return null

    try {
      const root = canonicalExistingPath(await this.dependencies.resolveTargetRoot(sessionId))
      if (!root) return null

      const absoluteInput = isAbsolute(filePath) || win32.isAbsolute(filePath)
      const segments = filePath.replace(/\\/g, '/').split('/').filter((segment) => segment && segment !== '.')
      if (!absoluteInput && (segments.length === 0 || segments.includes('..'))) return null

      const lexicalCandidate = absoluteInput ? filePath : resolve(root, ...segments)
      const existingCandidate = canonicalExistingPath(lexicalCandidate)
      const candidate = existingCandidate
        ?? canonicalCandidatePath(lexicalCandidate, { allowMissingLeaf })
      if (!candidate || !isUnderCanonicalRoot(candidate, root)) return null

      const relativePath = relative(root, candidate).replace(/\\/g, '/')
      if (!relativePath || relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath)) {
        return null
      }

      return {
        relativePath,
        exists: existingCandidate !== null,
        isGitRepo: Boolean(await this.dependencies.resolveGitRoot(root)),
      }
    } catch {
      return null
    }
  }

  async authorizeSessionFileRequest(
    filePath: string,
    options?: FileAccessOptions,
    candidateOptions: CanonicalCandidateOptions = {},
  ): Promise<boolean> {
    if (!this.isActivePiSession(options)) return false
    const candidate = canonicalCandidatePath(filePath, candidateOptions)
    if (!candidate) return false
    try {
      const roots = await this.getAuthorizedRoots(options.sessionId)
      return roots.some((root) => isCandidateAllowed(candidate, root))
    } catch {
      return false
    }
  }

  async resolveDirectoryRequest(dirPath: string, options?: FileAccessOptions): Promise<string | null> {
    if (!this.isActivePiSession(options)) return null
    try {
      const session = this.dependencies.getSession(options.sessionId)
      const workspace = session?.workspaceId
        ? this.dependencies.getWorkspace(session.workspaceId)
        : undefined
      const targetRoot = await this.dependencies.resolveTargetRoot(options.sessionId)
      const localAlias = workspace ? this.dependencies.getProjectRoot(workspace.slug) : undefined
      const requested = localAlias && this.isExactRoot(dirPath, localAlias) ? targetRoot : dirPath
      return await this.authorizeSessionFileRequest(requested, options) ? canonicalExistingPath(requested) : null
    } catch {
      return null
    }
  }

  async authorizeDiffRequest(input: {
    sessionId?: string
    relativePath: string
  }): Promise<AuthorizedSessionDiffRequest | null> {
    const options: FileAccessOptions | undefined = input.sessionId
      ? { sessionId: input.sessionId }
      : undefined
    if (!this.isActivePiSession(options)) return null

    const target = await this.resolveActiveDiffTarget(options.sessionId)
    if (!target) return null
    const resolvedFilePath = await this.resolveRelative(options.sessionId, input.relativePath, true)
    if (!resolvedFilePath) return null
    const repoRelativePath = relative(target.gitRoot, resolvedFilePath)
    if (!repoRelativePath || repoRelativePath === '..' || repoRelativePath.startsWith(`..${sep}`) || isAbsolute(repoRelativePath)) {
      return null
    }

    return {
      dirPath: target.root,
      filePath: repoRelativePath.replace(/\\/g, '/'),
      gitRoot: target.gitRoot,
      baseOid: target.baseOid,
    }
  }

  async resolveActiveDiffTarget(
    sessionId: string | undefined,
    submittedRoot?: unknown,
  ): Promise<ActiveSessionDiffTarget | null> {
    const options: FileAccessOptions | undefined = sessionId ? { sessionId } : undefined
    if (!this.isActivePiSession(options)) return null
    try {
      const root = await this.dependencies.resolveTargetRoot(options.sessionId)
      if (submittedRoot !== undefined
        && (typeof submittedRoot !== 'string' || !this.isExactRoot(submittedRoot, root))) {
        return null
      }
      const gitRoot = await this.dependencies.resolveGitRoot(root)
      if (!gitRoot) return null
      const inspection = await this.dependencies.inspectTarget(options.sessionId)
      return { root, gitRoot, baseOid: inspection.baseOid, kind: inspection.kind }
    } catch {
      return null
    }
  }

  async resolveActiveSearchTarget(
    sessionId: string | undefined,
    _submittedRoot?: unknown,
  ): Promise<ActiveSessionSearchTarget | null> {
    const options: FileAccessOptions | undefined = sessionId ? { sessionId } : undefined
    if (!this.isActivePiSession(options)) return null
    try {
      return {
        root: await this.dependencies.resolveTargetRoot(options.sessionId),
        // Session Target 搜索只投影 checkout 内相对路径；附加绝对路径保留给通用文件 UI。
        attachedRoots: [],
      }
    } catch {
      return null
    }
  }

  isExactRoot(candidateRoot: string, targetRoot: string): boolean {
    const candidate = canonicalExistingPath(candidateRoot)
    const target = canonicalExistingPath(targetRoot)
    return Boolean(candidate && target && comparablePath(candidate) === comparablePath(target))
  }
}

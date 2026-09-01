import type {
  GitWorkspaceBranchesRequest,
  GitWorkspaceBranchesResult,
  GitWorkspaceCheckoutRequest,
  GitWorkspaceCommitDiffRequest,
  GitWorkspaceCommitFilesRequest,
  GitWorkspaceCommitFilesResult,
  GitWorkspaceCommitRequest,
  GitWorkspaceDiffContents,
  GitWorkspaceDiffRequest,
  GitWorkspaceDiscardRequest,
  GitWorkspaceHistoryRequest,
  GitWorkspaceHistoryResult,
  GitWorkspaceInspectInput,
  GitWorkspaceOperationResult,
  GitWorkspacePullPushRequest,
  GitWorkspaceSnapshot,
  GitWorkspaceStageRequest,
} from '@domi/shared'
import { GitWorkspaceModule } from './git-workspace-module.ts'

export interface SessionGitWorkspaceTarget {
  root: string
  kind: 'local' | 'isolated'
}

interface SessionGitWorkspaceServiceDependencies {
  resolveTarget(sessionId: string): Promise<SessionGitWorkspaceTarget>
  module?: GitWorkspaceModule
  now?: () => number
}

function unavailableSnapshot(
  code: 'target-unavailable' | 'invalid-request',
  message: string,
  now: () => number,
): GitWorkspaceSnapshot {
  return {
    target: { kind: 'local' },
    repositories: [],
    scannedAt: now(),
    error: { code, message },
  }
}

/** checkout 需要恢复时给出可操作的提示，而不是泛化的「暂不可用」。 */
function recoveryUnavailableMessage(error: unknown): string | null {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  return code === 'recovery_required'
    ? '工作环境需要恢复后才能查看文件改动，请先在状态卡中完成恢复'
    : null
}

export class SessionGitWorkspaceService {
  private readonly module: GitWorkspaceModule
  private readonly now: () => number

  constructor(private readonly dependencies: SessionGitWorkspaceServiceDependencies) {
    this.module = dependencies.module ?? new GitWorkspaceModule()
    this.now = dependencies.now ?? Date.now
  }

  async inspect(input: GitWorkspaceInspectInput): Promise<GitWorkspaceSnapshot> {
    if (!input || typeof input.sessionId !== 'string' || !input.sessionId.trim()) {
      return unavailableSnapshot('invalid-request', '缺少有效的 Agent 会话。', this.now)
    }
    try {
      const target = await this.dependencies.resolveTarget(input.sessionId)
      return await this.module.inspect(target.root, target.kind, input.force === true)
    } catch (error) {
      return unavailableSnapshot(
        'target-unavailable',
        recoveryUnavailableMessage(error) ?? '工作环境暂不可用，请稍后重试',
        this.now,
      )
    }
  }

  async getDiff(input: GitWorkspaceDiffRequest): Promise<GitWorkspaceDiffContents | null> {
    if (!input
      || typeof input.sessionId !== 'string'
      || !input.sessionId.trim()
      || typeof input.repositoryId !== 'string'
      || !/^repo-[a-f0-9]{16}$/.test(input.repositoryId)
      || typeof input.relativePath !== 'string'
      || !input.relativePath
      || input.relativePath.length > 4_096
      || !['conflict', 'staged', 'unstaged', 'untracked'].includes(input.layer)) {
      return null
    }
    try {
      const target = await this.dependencies.resolveTarget(input.sessionId)
      return await this.module.getDiffContents(target.root, target.kind, {
        repositoryId: input.repositoryId,
        relativePath: input.relativePath,
        layer: input.layer,
      })
    } catch {
      return null
    }
  }

  private validRepositoryId(value: unknown): string | null {
    return typeof value === 'string' && /^repo-[a-f0-9]{16}$/.test(value) ? value : null
  }

  /** 相对路径安全校验：非绝对、无 `..` 穿越、无 NUL、长度受限。 */
  private safePathList(paths: unknown): string[] | null {
    if (!Array.isArray(paths)) return null
    const result: string[] = []
    for (const path of paths) {
      if (typeof path !== 'string'
        || !path
        || path.length > 4_096
        || path.includes('\\')
        || path.split('/').includes('..')
        || path.startsWith('/')
        || /^[A-Za-z]:/.test(path)
        || path.includes('\0')) {
        return null
      }
      result.push(path)
    }
    return result
  }

  async stage(input: GitWorkspaceStageRequest): Promise<GitWorkspaceOperationResult> {
    if (typeof input?.sessionId !== 'string' || !input.sessionId.trim()) {
      return { ok: false, message: '缺少会话。' }
    }
    const repositoryId = this.validRepositoryId(input.repositoryId)
    const paths = this.safePathList(input.relativePaths)
    if (!repositoryId || !paths || (input.action !== 'stage' && input.action !== 'unstage')) {
      return { ok: false, message: '无效请求。' }
    }
    try {
      const target = await this.dependencies.resolveTarget(input.sessionId)
      return await this.module.stageFiles(target.root, {
        repositoryId, relativePaths: paths, action: input.action,
      })
    } catch {
      return { ok: false, message: '工作环境暂不可用。' }
    }
  }

  async discard(input: GitWorkspaceDiscardRequest): Promise<GitWorkspaceOperationResult> {
    if (typeof input?.sessionId !== 'string' || !input.sessionId.trim()) {
      return { ok: false, message: '缺少会话。' }
    }
    const repositoryId = this.validRepositoryId(input.repositoryId)
    const paths = this.safePathList(input.relativePaths)
    if (!repositoryId || !paths || paths.length === 0
      || !['staged', 'unstaged', 'untracked'].includes(input.layer)) {
      return { ok: false, message: '无效请求。' }
    }
    try {
      const target = await this.dependencies.resolveTarget(input.sessionId)
      return await this.module.discardFiles(target.root, {
        repositoryId,
        relativePaths: paths,
        layer: input.layer,
      })
    } catch {
      return { ok: false, message: '工作环境暂不可用。' }
    }
  }

  async commit(input: GitWorkspaceCommitRequest): Promise<GitWorkspaceOperationResult> {
    if (typeof input?.sessionId !== 'string' || !input.sessionId.trim()) {
      return { ok: false, message: '缺少会话。' }
    }
    const repositoryId = this.validRepositoryId(input.repositoryId)
    if (!repositoryId || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 10_000) {
      return { ok: false, message: '无效请求。' }
    }
    try {
      const target = await this.dependencies.resolveTarget(input.sessionId)
      return await this.module.commitFiles(target.root, {
        repositoryId, message: input.message, push: input.push === true,
      })
    } catch {
      return { ok: false, message: '工作环境暂不可用。' }
    }
  }

  async checkout(input: GitWorkspaceCheckoutRequest): Promise<GitWorkspaceOperationResult> {
    if (typeof input?.sessionId !== 'string' || !input.sessionId.trim()) {
      return { ok: false, message: '缺少会话。' }
    }
    const repositoryId = this.validRepositoryId(input.repositoryId)
    if (!repositoryId || typeof input.branch !== 'string' || !input.branch || input.branch.length > 256) {
      return { ok: false, message: '无效请求。' }
    }
    try {
      const target = await this.dependencies.resolveTarget(input.sessionId)
      return await this.module.checkoutBranch(target.root, { repositoryId, branch: input.branch })
    } catch {
      return { ok: false, message: '工作环境暂不可用。' }
    }
  }

  async pullPush(input: GitWorkspacePullPushRequest): Promise<GitWorkspaceOperationResult> {
    if (typeof input?.sessionId !== 'string' || !input.sessionId.trim()) {
      return { ok: false, message: '缺少会话。' }
    }
    const repositoryId = this.validRepositoryId(input.repositoryId)
    if (!repositoryId || !['fetch', 'pull', 'push', 'sync'].includes(input.action)) {
      return { ok: false, message: '无效请求。' }
    }
    try {
      const target = await this.dependencies.resolveTarget(input.sessionId)
      return await this.module.pullPush(target.root, { repositoryId, action: input.action })
    } catch {
      return { ok: false, message: '工作环境暂不可用。' }
    }
  }

  async getHistory(input: GitWorkspaceHistoryRequest): Promise<GitWorkspaceHistoryResult> {
    const repositoryId = this.validRepositoryId(input?.repositoryId)
    if (typeof input?.sessionId !== 'string' || !input.sessionId.trim() || !repositoryId) {
      return { entries: [] }
    }
    try {
      const target = await this.dependencies.resolveTarget(input.sessionId)
      return await this.module.inspectHistory(target.root, {
        repositoryId,
        limit: typeof input.limit === 'number' ? input.limit : undefined,
      })
    } catch {
      return { entries: [] }
    }
  }

  async getBranches(input: GitWorkspaceBranchesRequest): Promise<GitWorkspaceBranchesResult> {
    const repositoryId = this.validRepositoryId(input?.repositoryId)
    if (typeof input?.sessionId !== 'string' || !input.sessionId.trim() || !repositoryId) {
      return { current: null, local: [] }
    }
    try {
      const target = await this.dependencies.resolveTarget(input.sessionId)
      return await this.module.listLocalBranches(target.root, repositoryId)
    } catch {
      return { current: null, local: [] }
    }
  }

  async getCommitFiles(input: GitWorkspaceCommitFilesRequest): Promise<GitWorkspaceCommitFilesResult> {
    const repositoryId = this.validRepositoryId(input?.repositoryId)
    if (typeof input?.sessionId !== 'string' || !input.sessionId.trim() || !repositoryId
      || typeof input.oid !== 'string' || !/^[0-9a-f]{7,40}$/.test(input.oid)) {
      return { files: [] }
    }
    try {
      const target = await this.dependencies.resolveTarget(input.sessionId)
      return await this.module.getCommitFiles(target.root, { repositoryId, oid: input.oid })
    } catch {
      return { files: [] }
    }
  }

  async getCommitDiff(input: GitWorkspaceCommitDiffRequest): Promise<GitWorkspaceDiffContents | null> {
    const repositoryId = this.validRepositoryId(input?.repositoryId)
    if (typeof input?.sessionId !== 'string' || !input.sessionId.trim() || !repositoryId
      || typeof input.oid !== 'string' || !/^[0-9a-f]{7,40}$/.test(input.oid)
      || typeof input.relativePath !== 'string' || !input.relativePath || input.relativePath.length > 4_096) {
      return null
    }
    try {
      const target = await this.dependencies.resolveTarget(input.sessionId)
      return await this.module.getCommitDiffContents(target.root, {
        repositoryId,
        oid: input.oid,
        relativePath: input.relativePath,
      })
    } catch {
      return null
    }
  }
}

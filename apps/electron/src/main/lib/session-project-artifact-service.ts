import { basename } from 'node:path'
import type { SessionProjectArtifact, SessionTargetView, UnstagedChangesResult } from '@domi/shared'
import { collectSessionProjectArtifactPaths } from './session-project-artifacts.ts'

const EMPTY_CHANGES: UnstagedChangesResult = {
  isGitRepo: false,
  files: [],
  untrackedFiles: [],
  gitRootNames: [],
}

export interface SessionProjectArtifactServiceDependencies {
  inspectTarget(sessionId: string): Promise<SessionTargetView | null>
  readPersistedChangedFiles(sessionId: string): string[]
  readCheckpointPaths(sessionId: string): string[]
  getCurrentChanges(sessionId: string): Promise<UnstagedChangesResult>
  resolveExistingFiles(sessionId: string, relativePaths: readonly string[]): Promise<Map<string, string>>
  statFile(absolutePath: string): { isFile(): boolean; size: number; mtimeMs: number }
}

function shouldIncludeCurrentChanges(target: SessionTargetView | null): boolean {
  if (!target || target.checkout.kind === 'local') return true
  const state = target.delivery?.state
  return state === undefined
    || state === 'working'
    || state === 'ready_for_review'
    || state === 'preview_active'
    || state === 'preview_detached'
}

/** 聚合一个会话当前仍可读取的项目产物，不向 renderer 暴露 Local/Worktree 真实根路径。 */
export class SessionProjectArtifactService {
  constructor(private readonly dependencies: SessionProjectArtifactServiceDependencies) {}

  async list(sessionId: string): Promise<SessionProjectArtifact[]> {
    const target = await this.dependencies.inspectTarget(sessionId).catch(() => null)
    const currentChanges = shouldIncludeCurrentChanges(target)
      ? await this.dependencies.getCurrentChanges(sessionId).catch(() => EMPTY_CHANGES)
      : EMPTY_CHANGES
    const relativePaths = collectSessionProjectArtifactPaths({
      sessionId,
      checkoutRecords: [],
      checkpointPaths: [
        ...this.dependencies.readPersistedChangedFiles(sessionId),
        ...this.dependencies.readCheckpointPaths(sessionId),
      ],
      currentChangedPaths: [
        ...currentChanges.files.map((entry) => entry.filePath),
        ...currentChanges.untrackedFiles.map((entry) => entry.filePath),
      ],
      deletedPaths: currentChanges.files
        .filter((entry) => entry.status === 'deleted')
        .map((entry) => entry.filePath),
    })
    const resolvedFiles = await this.dependencies.resolveExistingFiles(sessionId, relativePaths)
    const artifacts: SessionProjectArtifact[] = []

    for (const relativePath of relativePaths) {
      const absolutePath = resolvedFiles.get(relativePath)
      if (!absolutePath) continue
      try {
        const stats = this.dependencies.statFile(absolutePath)
        if (!stats.isFile()) continue
        artifacts.push({
          relativePath,
          name: basename(relativePath),
          size: stats.size,
          mtime: stats.mtimeMs,
        })
      } catch {
        // 文件在聚合期间被移动或删除时忽略，下一次刷新会重新计算。
      }
    }
    return artifacts
  }
}

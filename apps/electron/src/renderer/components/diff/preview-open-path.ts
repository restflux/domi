import type { FileAccessOptions } from '@domi/shared'
import type { PreviewFile } from '@/atoms/preview-atoms'

export function isAbsoluteFilePath(filePath: string): boolean {
  return filePath.startsWith('/') || filePath.startsWith('\\\\') || /^[A-Za-z]:[\\/]/.test(filePath)
}

function uniqueTruthyPaths(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of paths) {
    if (!path || seen.has(path)) continue
    seen.add(path)
    result.push(path)
  }
  return result
}

/**
 * 相对路径预览必须携带会话工作目录；历史工具调用通常只持久化了 filePath。
 * 将调用方已有候选目录与其上下文目录合并，以便 .context/plan/*.md 等文件正确解析。
 */
export function getPreviewCandidateBasePaths(
  basePaths: readonly string[] | undefined,
  ...contextPaths: Array<string | null | undefined>
): string[] {
  return uniqueTruthyPaths([...(basePaths ?? []), ...contextPaths])
}

/** 工具调用记录优先以消息所属会话目录解析，再尝试附件等补充目录。 */
export function getToolPreviewBasePaths(
  basePath?: string,
  basePaths?: readonly string[],
): string[] {
  return uniqueTruthyPaths([basePath, ...(basePaths ?? [])])
}

/** 调用方快照是当前审批对象，存在时必须优先于可能同名或已变化的磁盘文件。 */
export function selectPreviewTextContent(
  diskContent: string | null | undefined,
  snapshotContent: string | undefined,
): string {
  return snapshotContent ?? diskContent ?? ''
}

/**
 * 默认应用与内联预览必须提交同一个原始路径；主进程再按 Session Target 优先级和
 * candidateBasePaths 统一解析，避免同名文件在两个入口中指向不同位置。
 */
export function getDefaultAppTargetPath(file: PreviewFile, _sessionPath: string): string {
  return file.filePath
}

export function getPreviewFileAccess(
  sessionId: string,
  file: PreviewFile,
  sessionPath: string,
): FileAccessOptions {
  if (file.sessionTarget) return { sessionId, pathSpace: 'session-target' }
  return {
    sessionId,
    ...(file.pathSpace ? { pathSpace: file.pathSpace } : {}),
    candidateBasePaths: getPreviewCandidateBasePaths(
      file.basePaths,
      file.gitRoot,
      file.dirPath,
      sessionPath,
    ),
  }
}

import type { FileAccessOptions, FileIndexEntry, SessionTargetFileRequest } from '@domi/shared'

export interface AgentFileSourceRoute {
  usesSessionTarget: boolean
  pathSpace?: FileAccessOptions['pathSpace']
}

/** Pi 项目文件走已绑定 checkout；首次发送前只浏览默认 Local 项目；会话文件使用私有 workbench。 */
export function getAgentFileSourceRoute(
  usesSessionTarget: boolean,
  source: 'session' | 'project',
  hasBoundSessionTarget = true,
): AgentFileSourceRoute {
  if (!usesSessionTarget) return { usesSessionTarget: false }
  if (source === 'session') return { usesSessionTarget: false, pathSpace: 'session-workbench' }
  return hasBoundSessionTarget
    ? { usesSessionTarget: true, pathSpace: 'session-target' }
    : { usesSessionTarget: false, pathSpace: 'session-local-project' }
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/')
    || path.startsWith('\\\\')
    || /^[A-Za-z]:[\\/]/.test(path)
}

/** Active Pi renderer 只保留 Session Target 相对路径，不接触 checkout lease。 */
export function normalizeSessionTargetRelativePath(path: string): string | null {
  if (typeof path !== 'string' || !path || isAbsolutePath(path)) return null
  const segments = path.replace(/\\/g, '/').split('/').filter((segment) => segment && segment !== '.')
  if (segments.includes('..')) return null
  return segments.join('/') || (path === '.' ? '.' : null)
}

export function createSessionTargetFileRequest(
  sessionId: string,
  path: string,
): SessionTargetFileRequest | null {
  if (!sessionId) return null
  const relativePath = normalizeSessionTargetRelativePath(path)
  return relativePath ? { sessionId, relativePath } : null
}

export function getAgentFileTreeRoot(usesSessionTarget: boolean, legacyRoot: string | null): string | null {
  return usesSessionTarget ? '.' : legacyRoot
}

interface ResolveAgentSearchResultPathInput {
  usesSessionTarget: boolean
  entryPath: string
  source: FileIndexEntry['source']
  workspaceRoot: string | null
  sessionRoot: string | null
}

/** 搜索点击保持与对应文件树同一种路径空间：Session Target 为相对路径，通用文件树为绝对路径。 */
export function resolveAgentSearchResultPath(input: ResolveAgentSearchResultPathInput): string | null {
  if (input.usesSessionTarget) return normalizeSessionTargetRelativePath(input.entryPath)
  if (isAbsolutePath(input.entryPath)) return input.entryPath
  const base = input.source === 'workspace' ? input.workspaceRoot : input.sessionRoot
  if (!base) return input.entryPath
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return `${base.replace(/[\\/]+$/, '')}${separator}${input.entryPath}`
}

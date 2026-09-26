import type { FileAccessOptions } from '@domi/shared'

export interface SessionSourceCapabilities {
  readAccess: (FileAccessOptions & { sessionId: string }) | null
  canMutate: boolean
}

export interface SessionSourceContext {
  sessionId: string
  sessionPath: string | null
  attachedFiles: readonly string[]
  attachedDirectories: readonly string[]
}

function underRoot(root: string, candidate: string): boolean {
  if (!root || !candidate) return false
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedCandidate = candidate.replace(/\\/g, '/')
  if (!normalizedRoot || !normalizedCandidate) return false
  if (normalizedCandidate.split('/').some((segment) => segment === '..' || segment === '.')) return false
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
}

/** 仅用于菜单显隐；Main 始终再次检查当前 Session、canonical 路径与文件操作权限。 */
export function getSessionSourceOpenMode(
  source: { isImage: boolean; isDirectory: boolean },
  capabilities: SessionSourceCapabilities,
): 'lightbox' | 'preview' | 'browse' | 'unavailable' {
  if (source.isDirectory) return 'browse'
  if (!capabilities.readAccess) return 'unavailable'
  return source.isImage ? 'lightbox' : 'preview'
}

export function getSessionSourceCapabilities(path: string, context: SessionSourceContext): SessionSourceCapabilities {
  if (context.sessionPath && underRoot(context.sessionPath, path)) {
    const normalizedRoot = context.sessionPath.replace(/\\/g, '/').replace(/\/+$/, '')
    return {
      readAccess: { sessionId: context.sessionId, pathSpace: 'session-workbench' },
      canMutate: path.replace(/\\/g, '/') !== normalizedRoot,
    }
  }
  if (context.attachedFiles.includes(path)
    || context.attachedDirectories.some((root) => underRoot(root, path))) {
    return { readAccess: { sessionId: context.sessionId }, canMutate: false }
  }
  return { readAccess: null, canMutate: false }
}

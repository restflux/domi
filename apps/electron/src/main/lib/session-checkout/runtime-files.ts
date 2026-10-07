import { isAbsolute, relative, resolve } from 'node:path'
import type { ManagedCheckoutsRegistry } from './ports.ts'
import { isLocalFileTemporaryPath } from '../worktree-local-files/temporary-path.ts'

export const MAX_RECORDED_LOCAL_FILES = 128

/** 只接受宿主持久化的明确文件路径；损坏凭证不能降级为“无排除”。 */
export function isRuntimeFilePath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 1024
    && !path.includes('\0') && !/[\\:*?\[\]\r\n]/.test(path) && !isAbsolute(path)
    && path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && segment.toLowerCase() !== '.git')
}

function pathKey(path: string): string {
  return path.normalize('NFD').toLowerCase()
}

/** 返回指定 Git 根内的配置路径；同时保护 Local 原件和对应 Worktree 副本。 */
export function collectRuntimeFilePaths(registry: ManagedCheckoutsRegistry, gitRoot: string): string[] {
  const root = resolve(gitRoot)
  const paths = new Set<string>()
  for (const record of Object.values(registry.managedCheckouts)) {
    if (!record.localFiles) continue
    if (!record.localFiles.paths.every(isRuntimeFilePath)) throw new Error('本地配置准备凭证损坏，已停止生成快照')
    for (const projectRoot of [record.localRoot, record.managedRoot]) {
      const prefix = relative(root, resolve(projectRoot)).replace(/\\/g, '/')
      if (prefix === '..' || prefix.startsWith('../') || isAbsolute(prefix)) continue
      for (const path of record.localFiles.paths) paths.add(prefix ? `${prefix}/${path}` : path)
    }
  }
  return [...paths]
}

export function isRuntimeFile(registry: ManagedCheckoutsRegistry, targetRoot: string, filePath: string): boolean {
  const path = relative(resolve(targetRoot), resolve(filePath)).replace(/\\/g, '/')
  if (path === '..' || path.startsWith('../') || isAbsolute(path)) return false
  return isLocalFileTemporaryPath(path) || collectRuntimeFilePaths(registry, targetRoot).some((entry) => pathKey(entry) === pathKey(path))
}

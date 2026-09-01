import { posix, win32 } from 'node:path'

export type PathCanonicalizer = (path: string) => Promise<string>

function usesWindowsPaths(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\')
}

export function resolvePortablePath(path: string, cwd: string): string {
  if (usesWindowsPaths(path) || usesWindowsPaths(cwd)) {
    return win32.resolve(cwd, path)
  }
  return posix.resolve(cwd, path)
}

/**
 * 将 Git Bash / MSYS 风格的盘符路径（/g/foo → G:/foo）归一化为 Windows 路径。
 * 仅匹配 /<单字母>/ 前缀，避免把 /usr、/tmp 等 POSIX 目录误判为盘符。
 */
export function normalizeMsysPath(path: string): string {
  return path.replace(/^\/([A-Za-z])\//, (_match, drive: string) => `${drive.toUpperCase()}:/`)
}

function comparablePath(path: string): { value: string; separator: string } {
  if (usesWindowsPaths(path)) {
    return {
      value: win32.normalize(path).replace(/[\\/]+$/, '').toLowerCase(),
      separator: '\\',
    }
  }
  return { value: posix.resolve(path).replace(/\/+$/, ''), separator: '/' }
}

export function isWithinWorkspace(target: string, workspaceRoot: string): boolean {
  const targetPath = comparablePath(target)
  const rootPath = comparablePath(workspaceRoot)
  if (targetPath.separator !== rootPath.separator) return false
  return targetPath.value === rootPath.value
    || targetPath.value.startsWith(`${rootPath.value}${rootPath.separator}`)
}

export async function findWorkspaceBoundaryCrossing(input: {
  paths: readonly string[]
  cwd: string
  workspaceRoot: string
  canonicalize: PathCanonicalizer
}): Promise<string | undefined> {
  const canonicalRoot = await input.canonicalize(resolvePortablePath(input.workspaceRoot, input.workspaceRoot))
  const resolvedCwd = resolvePortablePath(input.cwd, input.workspaceRoot)
  const canonicalCwd = await input.canonicalize(resolvedCwd)
  if (!isWithinWorkspace(canonicalCwd, canonicalRoot)) return canonicalCwd

  for (const path of input.paths) {
    const canonicalTarget = await input.canonicalize(resolvePortablePath(path, resolvedCwd))
    if (!isWithinWorkspace(canonicalTarget, canonicalRoot)) return canonicalTarget
  }
  return undefined
}

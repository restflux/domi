import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export function resolveTerminalCwd(targetRoots: string | readonly string[], requestedCwd?: string): string {
  const roots = (Array.isArray(targetRoots) ? targetRoots : [targetRoots]) as readonly string[]
  if (roots.length === 0) throw new Error('终端缺少授权目录。')
  const canonicalPrimaryRoot = canonicalDirectory(roots[0]!, 'Session Target 根目录')
  const canonicalRoots = [
    canonicalPrimaryRoot,
    ...roots.slice(1).flatMap((root) => {
      try {
        return [canonicalDirectory(root, '终端附加授权目录')]
      } catch {
        return []
      }
    }),
  ]
  const requested = requestedCwd?.trim()
  const candidate = requested
    ? isAbsolute(requested) ? resolve(requested) : resolve(canonicalRoots[0]!, requested)
    : canonicalRoots[0]!
  if (!canonicalRoots.some((root) => isPathWithinRoot(root, candidate))) {
    throw new Error('终端工作目录必须位于当前 Session Target 或附加授权范围内。')
  }
  const canonicalCandidate = canonicalDirectory(candidate, '终端工作目录')
  if (!canonicalRoots.some((root) => isPathWithinRoot(root, canonicalCandidate))) {
    throw new Error('终端工作目录通过链接逃离了当前 Session Target 或附加授权范围。')
  }
  return canonicalCandidate
}

function canonicalDirectory(path: string, label: string): string {
  let canonical: string
  try {
    canonical = realpathSync(path)
  } catch {
    throw new Error(`${label}不存在或无法访问：${path}`)
  }
  try {
    if (!statSync(canonical).isDirectory()) throw new Error()
  } catch {
    throw new Error(`${label}不是目录：${path}`)
  }
  return canonical
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root
  const normalizedCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  const rel = relative(normalizedRoot, normalizedCandidate)
  return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

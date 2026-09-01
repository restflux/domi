import { lstatSync, realpathSync } from 'node:fs'
import { posix, resolve, win32 } from 'node:path'

export interface VisionRelayPathGrant {
  /** Canonical path captured when the trusted main process builds the run scope. */
  path: string
  dev: number
  ino: number
}

export interface VisionRelayAccessScope {
  /** Canonical directory grants. Descendants are authorized while the directory identity remains stable. */
  roots: VisionRelayPathGrant[]
  /** Canonical exact-file grants. Their parent directories are not authorized. */
  files: VisionRelayPathGrant[]
}

export interface BuildVisionRelayAccessScopeInput {
  targetRoot?: string
  sessionWorkbenchRoot?: string
  attachedDirectories?: string[]
}

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix
}

function comparisonKey(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? value.toLowerCase() : value
}

function normalizeAbsolutePath(value: string, platform: NodeJS.Platform): string | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return pathApi(platform).normalize(pathApi(platform).resolve(trimmed))
}

function snapshotGrant(value: string | undefined, kind: 'directory' | 'file'): VisionRelayPathGrant | undefined {
  if (!value?.trim()) return undefined
  try {
    const canonicalPath = realpathSync(resolve(value.trim()))
    const stats = lstatSync(canonicalPath)
    if (kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) return undefined
    return { path: canonicalPath, dev: stats.dev, ino: stats.ino }
  } catch {
    return undefined
  }
}

function uniqueGrants(values: Array<string | undefined>, kind: 'directory' | 'file'): VisionRelayPathGrant[] {
  const result: VisionRelayPathGrant[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const grant = snapshotGrant(value, kind)
    if (!grant) continue
    const key = comparisonKey(grant.path, process.platform)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(grant)
  }
  return result
}

/** Build an immutable run-scope snapshot from trusted, main-process-owned attachment metadata. */
export function buildVisionRelayAccessScope(input: BuildVisionRelayAccessScopeInput): VisionRelayAccessScope {
  return {
    roots: uniqueGrants([
      input.targetRoot,
      input.sessionWorkbenchRoot,
      ...(input.attachedDirectories ?? []),
    ], 'directory'),
    files: [],
  }
}

export function filterStableVisionRelayAccessScope(scope: VisionRelayAccessScope): VisionRelayAccessScope {
  const stable = (grant: VisionRelayPathGrant, kind: 'directory' | 'file'): boolean => {
    try {
      const stats = lstatSync(grant.path)
      return (kind === 'directory' ? stats.isDirectory() : stats.isFile())
        && stats.dev === grant.dev
        && stats.ino === grant.ino
    } catch {
      return false
    }
  }
  return {
    roots: scope.roots.filter((grant) => stable(grant, 'directory')),
    files: scope.files.filter((grant) => stable(grant, 'file')),
  }
}

function isPathWithinRoot(candidate: string, root: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform)
  const relative = api.relative(root, candidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !api.isAbsolute(relative))
}

/** Candidate must already be a canonical real path. Grant identities are validated separately. */
export function isCanonicalVisionPathAuthorized(
  candidatePath: string,
  scope: VisionRelayAccessScope,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const candidate = normalizeAbsolutePath(candidatePath, platform)
  if (!candidate) return false
  const candidateKey = comparisonKey(candidate, platform)
  if (scope.files.some((file) => comparisonKey(file.path, platform) === candidateKey)) return true
  return scope.roots.some((root) => isPathWithinRoot(candidate, root.path, platform))
}

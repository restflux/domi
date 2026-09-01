import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { MAX_ATTACHMENT_SIZE } from '@domi/shared'
import type {
  AgentSaveWorkspaceFilesInput,
  AgentSavedFile,
  AgentSessionMeta,
  AgentWorkspace,
} from '@domi/shared'

export interface WorkspaceFileSaveDependencies {
  getSession(sessionId: string): AgentSessionMeta | undefined
  getWorkspaceBySlug(workspaceSlug: string): AgentWorkspace | undefined
  resolveTargetRoot(sessionId: string): Promise<string>
}

function comparablePath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function isPathContained(root: string, candidate: string): boolean {
  const relativePath = relative(comparablePath(root), comparablePath(candidate))
  return relativePath === '' || (
    relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath)
  )
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function resolveSafeWorkspaceFilePath(workspaceRoot: string, filename: string): string {
  const hasParentTraversal = filename.split(/[\\/]+/).some((segment) => segment === '..')
  if (!filename || isAbsolute(filename) || win32.isAbsolute(filename) || hasParentTraversal) {
    throw new Error(`项目文件名不安全，拒绝保存: ${filename}`)
  }

  let canonicalRoot: string
  try {
    canonicalRoot = realpathSync(resolve(workspaceRoot))
    if (!statSync(canonicalRoot).isDirectory()) throw new Error('not a directory')
  } catch {
    throw new Error(`项目文件名不安全，拒绝保存: ${filename}`)
  }

  const targetPath = resolve(canonicalRoot, filename)
  const pathWithinRoot = relative(canonicalRoot, targetPath)
  const escapesRoot = pathWithinRoot === '..'
    || pathWithinRoot.startsWith(`..${sep}`)
    || isAbsolute(pathWithinRoot)

  if (!pathWithinRoot || escapesRoot) {
    throw new Error(`项目文件名不安全，拒绝保存: ${filename}`)
  }
  return targetPath
}

function prepareCanonicalTarget(workspaceRoot: string, targetPath: string, filename: string): string {
  const canonicalRoot = realpathSync(resolve(workspaceRoot))
  let existingAncestor = dirname(targetPath)
  while (!pathEntryExists(existingAncestor)) {
    const parent = dirname(existingAncestor)
    if (parent === existingAncestor) {
      throw new Error(`项目文件名不安全，拒绝保存: ${filename}`)
    }
    existingAncestor = parent
  }

  let canonicalAncestor: string
  try {
    canonicalAncestor = realpathSync(existingAncestor)
  } catch {
    throw new Error(`项目文件名不安全，拒绝保存: ${filename}`)
  }
  if (!isPathContained(canonicalRoot, canonicalAncestor)) {
    throw new Error(`项目文件名不安全，拒绝保存: ${filename}`)
  }

  mkdirSync(dirname(targetPath), { recursive: true })
  const canonicalParent = realpathSync(dirname(targetPath))
  if (!isPathContained(canonicalRoot, canonicalParent)) {
    throw new Error(`项目文件名不安全，拒绝保存: ${filename}`)
  }
  return join(canonicalParent, targetPath.slice(dirname(targetPath).length + 1))
}

/** 保存上传文件到会话当前 Session Target。 */
export async function saveWorkspaceFiles(
  input: AgentSaveWorkspaceFilesInput,
  dependencies: WorkspaceFileSaveDependencies,
): Promise<AgentSavedFile[]> {
  const session = dependencies.getSession(input.sessionId)
  if (!session) throw new Error(`Agent 会话不存在: ${input.sessionId}`)
  const workspace = dependencies.getWorkspaceBySlug(input.workspaceSlug)
  if (!workspace) throw new Error(`指定的 Agent 项目不存在或已删除: ${input.workspaceSlug}`)
  if (session.workspaceId !== workspace.id) throw new Error('Agent 会话与项目不匹配')

  const workspaceRoot = await dependencies.resolveTargetRoot(session.id)
  const files = input.files.map((file) => ({
    file,
    initialTargetPath: resolveSafeWorkspaceFilePath(workspaceRoot, file.filename),
  }))
  const results: AgentSavedFile[] = []
  const usedPaths = new Set<string>()

  for (const { file, initialTargetPath } of files) {
    let targetPath = initialTargetPath
    if (usedPaths.has(targetPath) || pathEntryExists(targetPath)) {
      const relativeFilename = relative(workspaceRoot, targetPath)
      const dotIndex = relativeFilename.lastIndexOf('.')
      const baseName = dotIndex > 0 ? relativeFilename.slice(0, dotIndex) : relativeFilename
      const extension = dotIndex > 0 ? relativeFilename.slice(dotIndex) : ''
      let counter = 1
      let candidate = resolveSafeWorkspaceFilePath(workspaceRoot, `${baseName}-${counter}${extension}`)
      while (usedPaths.has(candidate) || pathEntryExists(candidate)) {
        counter += 1
        candidate = resolveSafeWorkspaceFilePath(workspaceRoot, `${baseName}-${counter}${extension}`)
      }
      targetPath = candidate
    }
    targetPath = prepareCanonicalTarget(workspaceRoot, targetPath, file.filename)
    usedPaths.add(targetPath)

    if (file.data.length * 0.75 > MAX_ATTACHMENT_SIZE) {
      console.warn(`[Agent 服务] 项目文件超过 100MB 限制，跳过: ${file.filename}`)
      continue
    }

    const buffer = Buffer.from(file.data, 'base64')
    writeFileSync(targetPath, buffer, { flag: 'wx' })
    const legacyRelativePath = relative(workspaceRoot, targetPath)
    const sessionRelativePath = legacyRelativePath.replace(/\\/g, '/')
    results.push({
      filename: sessionRelativePath,
      targetPath: sessionRelativePath,
    })
    console.log(`[Agent 服务] 工作区文件已保存: ${targetPath} (${buffer.length} bytes)`)
  }

  return results
}

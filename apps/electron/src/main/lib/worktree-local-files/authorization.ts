import { lstat, mkdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { canonicalRoot, readSnapshot, removeTemporary, safeLocation, writeTemporary, type FileSnapshot, type SafeLocation } from './filesystem'
import { validatePaths } from './manifest'
import { WorktreeLocalFilesError } from './errors'
import { publishFile } from './replace'

const MAX_STORAGE_BYTES = 256 * 1024
export interface Approval { id: string; root: string; rootIdentity: string; paths: string[] }
async function rootIdentity(root: string): Promise<string> {
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorktreeLocalFilesError('invalid_root', '项目根目录身份已变化')
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
}
interface ApprovalDocument { version: 1; projects: Approval[] }
interface AuthorizationSnapshot { document: ApprovalDocument; snapshot: FileSnapshot | null; location: SafeLocation }

function decodeDocument(bytes: Uint8Array): ApprovalDocument {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1
      || !('projects' in value) || !Array.isArray(value.projects) || value.projects.length > 1000) throw new Error('schema')
    const projects: Approval[] = []
    for (const project of value.projects as unknown[]) {
      if (!project || typeof project !== 'object' || !('id' in project) || typeof project.id !== 'string' || !project.id
        || !('root' in project) || typeof project.root !== 'string' || !project.root
        || !('rootIdentity' in project) || typeof project.rootIdentity !== 'string' || !project.rootIdentity
        || !('paths' in project) || !Array.isArray(project.paths) || !project.paths.every((path: unknown) => typeof path === 'string')) throw new Error('schema')
      const paths = validatePaths(project.paths as string[])
      if (paths.length !== project.paths.length || projects.some(entry => entry.id === project.id && entry.root === project.root)) throw new Error('duplicate')
      projects.push({ id: project.id, root: project.root, rootIdentity: project.rootIdentity, paths })
    }
    return { version: 1, projects }
  } catch {
    throw new WorktreeLocalFilesError('authorization_corrupt', '本机本地文件授权信息损坏，拒绝准备文件')
  }
}

export class AuthorizationStore {
  private static readonly lockedPaths = new Set<string>()
  private readonly path: string
  constructor(storagePath: string) { this.path = resolve(storagePath) }

  private async location(): Promise<SafeLocation> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const root = await canonicalRoot(dirname(this.path))
    return safeLocation(root, basename(this.path))
  }

  private async snapshot(): Promise<AuthorizationSnapshot> {
    try {
      const location = await this.location()
      const snapshot = location.stat ? await readSnapshot(location, MAX_STORAGE_BYTES) : null
      return { location, snapshot, document: snapshot ? decodeDocument(snapshot.bytes) : { version: 1, projects: [] } }
    } catch (error) {
      if (error instanceof WorktreeLocalFilesError && error.code === 'authorization_corrupt') throw error
      throw new WorktreeLocalFilesError('authorization_corrupt', '无法安全读取本机本地文件授权信息')
    }
  }

  async approved(id: string, root: string): Promise<ReadonlySet<string>> {
    const { document } = await this.snapshot()
    const identity = await rootIdentity(root)
    return new Set(document.projects.find(entry => entry.id === id && entry.root === root && entry.rootIdentity === identity)?.paths ?? [])
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const location = await this.location()
    // Domi Main 由应用单实例锁保护；同进程所有 Store 共用 canonical key，
    // 不留下崩溃后无法自动判定所有权的磁盘锁。文件写入另有内容 CAS。
    const key = location.path
    if (AuthorizationStore.lockedPaths.has(key)) throw new WorktreeLocalFilesError('operation_busy', '另一个本地文件操作正在进行，请稍后重试')
    AuthorizationStore.lockedPaths.add(key)
    try { return await operation() } finally { AuthorizationStore.lockedPaths.delete(key) }
  }

  async approve(id: string, root: string, paths: readonly string[]): Promise<void> {
    const { document, snapshot, location } = await this.snapshot()
    const projects = document.projects.filter(entry => entry.id !== id || entry.root !== root)
    projects.push({ id, root, rootIdentity: await rootIdentity(root), paths: validatePaths(paths) })
    const bytes = Buffer.from(`${JSON.stringify({ version: 1, projects })}\n`, 'utf8')
    if (bytes.length > MAX_STORAGE_BYTES || projects.length > 1000) throw new WorktreeLocalFilesError('limit_exceeded', '本机本地文件授权数量超过限制')
    const temporary = await writeTemporary(location, bytes, 0o600)
    try { const publication = await publishFile(location, temporary, snapshot, bytes); await publication.finish() } finally { await removeTemporary(location, temporary) }
  }
}

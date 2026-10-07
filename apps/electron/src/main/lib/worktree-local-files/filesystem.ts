import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { isMissing, WorktreeLocalFilesError } from './errors'

export const MAX_FILE_BYTES = 4 * 1024 * 1024
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024

export interface DirectoryIdentity { path: string; dev: number; ino: number }
export interface SafeLocation {
  path: string
  stat: Stats | null
  parents: DirectoryIdentity[]
}
export interface FileSnapshot {
  bytes: Buffer
  fingerprint: string
  stat: Stats
}

export function fingerprint(stat: Stats, bytes: Uint8Array): string {
  return createHash('sha256').update(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}:`).update(bytes).digest('hex')
}

export async function canonicalRoot(root: string): Promise<string> {
  const canonical = await realpath(root)
  const stat = await lstat(canonical)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorktreeLocalFilesError('invalid_root', '项目根目录无效')
  return canonical
}

export async function safeLocation(root: string, relative: string, createParents = false): Promise<SafeLocation> {
  const parts = relative.split('/')
  const parents: DirectoryIdentity[] = []
  let current = root
  for (let index = 0; index < parts.length; index++) {
    const parentStat = await lstat(current)
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
      throw new WorktreeLocalFilesError('unsafe_file', '本地文件的父目录不能是符号链接或特殊文件')
    }
    parents.push({ path: current, dev: parentStat.dev, ino: parentStat.ino })
    if (current !== root) {
      let nestedRepository = false
      try { await lstat(join(current, '.git')); nestedRepository = true } catch (error) { if (!isMissing(error)) throw error }
      if (nestedRepository) throw new WorktreeLocalFilesError('unsafe_file', '不能准备嵌套 Git 仓库中的本地文件')
    }
    current = join(current, parts[index]!)
    let stat: Stats
    try { stat = await lstat(current) } catch (error) {
      if (!isMissing(error)) throw error
      if (index === parts.length - 1 || !createParents) return { path: join(root, relative), stat: null, parents }
      try { await mkdir(current, { mode: 0o700 }) } catch (mkdirError) {
        if (!(mkdirError instanceof Error && 'code' in mkdirError && mkdirError.code === 'EEXIST')) throw mkdirError
      }
      await assertParents(parents)
      stat = await lstat(current)
    }
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new WorktreeLocalFilesError('unsafe_file', '本地文件不能是符号链接、目录或特殊文件')
    }
    if (index === parts.length - 1) return { path: current, stat, parents }
  }
  throw new WorktreeLocalFilesError('invalid_path', '本地文件路径不能为空')
}

export async function assertParents(parents: readonly DirectoryIdentity[]): Promise<void> {
  for (const parent of parents) {
    const stat = await lstat(parent.path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== parent.dev || stat.ino !== parent.ino) {
      throw new WorktreeLocalFilesError('file_changed', '本地文件的父目录在操作期间发生变化')
    }
  }
}

async function readBounded(handle: FileHandle, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let length = 0
  while (length <= maximum) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, maximum + 1 - length))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, length)
    if (!bytesRead) return Buffer.concat(chunks, length)
    chunks.push(buffer.subarray(0, bytesRead))
    length += bytesRead
  }
  throw new WorktreeLocalFilesError('limit_exceeded', '本地文件超过允许的大小')
}

function sameStat(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.mode === right.mode
}

export async function readSnapshot(location: SafeLocation, maximum = MAX_FILE_BYTES): Promise<FileSnapshot> {
  if (!location.stat) throw new WorktreeLocalFilesError('missing_file', '本地文件不存在')
  await assertParents(location.parents)
  const handle = await open(location.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const before = await handle.stat()
    if (!before.isFile() || !sameStat(before, location.stat)) throw new WorktreeLocalFilesError('file_changed', '本地文件在读取前发生变化')
    if (before.size > maximum) throw new WorktreeLocalFilesError('limit_exceeded', '本地文件超过允许的大小')
    const bytes = await readBounded(handle, maximum)
    const after = await handle.stat()
    const named = await lstat(location.path)
    await assertParents(location.parents)
    if (!sameStat(before, after) || !sameStat(before, named) || named.isSymbolicLink() || bytes.length !== before.size) {
      throw new WorktreeLocalFilesError('file_changed', '本地文件在读取期间发生变化')
    }
    return { bytes, fingerprint: fingerprint(before, bytes), stat: before }
  } finally { await handle.close() }
}

export async function writeTemporary(location: SafeLocation, bytes: Uint8Array, mode: number): Promise<string> {
  await assertParents(location.parents)
  const temporary = join(dirname(location.path), `.domi-local-${randomUUID()}.tmp`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode & 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
    await assertParents(location.parents)
  } catch (error) {
    await removeTemporary(location, temporary).catch(() => {})
    throw error
  } finally { await handle.close() }
  return temporary
}

export async function removeTemporary(location: SafeLocation, path: string): Promise<void> {
  // 父目录被替换时不能沿新的路径清理，否则可能删除授权范围外的同名文件。
  await assertParents(location.parents)
  await unlink(path)
}

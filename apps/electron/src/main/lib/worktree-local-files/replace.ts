import { link, lstat, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { assertParents, readSnapshot, type FileSnapshot, type SafeLocation } from './filesystem'
import { isMissing, WorktreeLocalFilesError } from './errors'

export interface PublishedFile {
  verify(): Promise<void>
  finish(): Promise<void>
  rollback(): Promise<void>
}

async function removeIfOwned(path: string, dev: number, ino: number): Promise<void> {
  try {
    const stat = await lstat(path)
    if (!stat.isSymbolicLink() && stat.dev === dev && stat.ino === ino) await unlink(path)
  } catch (error) { if (!isMissing(error)) throw error }
}

// 通过排他 hard link 发布独立临时文件。覆盖先认领旧 inode，再检查内容并排他发布；
// 不直接向旧 inode 写入，避免影响 hard link 和其他读取者。所有调用者保留回滚句柄。
export async function publishFile(location: SafeLocation, temporary: string, expected: FileSnapshot | null, intendedBytes: Uint8Array): Promise<PublishedFile> {
  await assertParents(location.parents)
  const tempStat = await lstat(temporary)
  const staged = await readSnapshot({ ...location, path: temporary, stat: tempStat }, intendedBytes.length)
  if (!staged.bytes.equals(intendedBytes)) throw new WorktreeLocalFilesError('target_changed', '待发布文件在操作期间发生变化')
  const backup = join(dirname(location.path), `.domi-local-${randomUUID()}.previous`)
  let claimed = false
  let published = false
  const restore = async (): Promise<void> => {
    await assertParents(location.parents)
    if (published) await removeIfOwned(location.path, tempStat.dev, tempStat.ino)
    if (claimed) {
      try { await link(backup, location.path) } catch (error) {
        // 不覆盖竞争者；旧文件仍保留在本目录，供用户恢复。
        throw new WorktreeLocalFilesError('target_changed', `目标文件发生竞争，旧文件保留为 ${backup.split(/[\\/]/u).at(-1)}`)
      }
      await unlink(backup)
      claimed = false
    }
  }
  try {
    await assertParents(location.parents)
    if (expected) {
      const fresh = await readSnapshot({ ...location, stat: await lstat(location.path) }, expected.bytes.length)
      if (fresh.fingerprint !== expected.fingerprint) throw new WorktreeLocalFilesError('target_changed', '目标文件已变化，请重新确认覆盖')
      await assertParents(location.parents)
      await rename(location.path, backup)
      claimed = true
      const moved = await readSnapshot({ ...location, path: backup, stat: await lstat(backup) }, expected.bytes.length)
      if (moved.stat.dev !== expected.stat.dev || moved.stat.ino !== expected.stat.ino
        || moved.stat.mode !== expected.stat.mode || moved.stat.mtimeMs !== expected.stat.mtimeMs
        || !moved.bytes.equals(expected.bytes)) {
        throw new WorktreeLocalFilesError('target_changed', '目标文件在覆盖期间发生变化')
      }
    }
    await assertParents(location.parents)
    try { await link(temporary, location.path) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new WorktreeLocalFilesError('target_changed', '目标文件已存在或发生竞争，未执行覆盖')
      }
      throw error
    }
    published = true
    await assertParents(location.parents)
    const named = await lstat(location.path)
    if (named.isSymbolicLink() || named.dev !== tempStat.dev || named.ino !== tempStat.ino) {
      throw new WorktreeLocalFilesError('target_changed', '目标文件在发布期间发生变化')
    }
    const snapshot = await readSnapshot({ ...location, stat: named }, intendedBytes.length)
    if (!snapshot.bytes.equals(intendedBytes)) throw new WorktreeLocalFilesError('target_changed', '目标文件在发布期间发生变化')
    return {
      verify: async () => {
        try {
          if ((await readSnapshot({ ...location, stat: await lstat(location.path) }, intendedBytes.length)).fingerprint !== snapshot.fingerprint) {
            throw new Error('changed')
          }
        } catch { throw new WorktreeLocalFilesError('target_changed', '目标文件在复制期间发生变化') }
      },
      finish: async () => { await assertParents(location.parents); if (claimed) { await unlink(backup); claimed = false } },
      rollback: restore,
    }
  } catch (error) {
    await restore()
    throw error
  }
}

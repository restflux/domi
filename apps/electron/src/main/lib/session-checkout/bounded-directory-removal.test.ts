import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeDirectoryBounded } from './bounded-directory-removal.ts'

describe('有界目录清理', () => {
  test('删除普通目录树，不删除同级目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'domi-removal-'))
    try {
      const target = join(root, 'target')
      await mkdir(join(target, 'nested'), { recursive: true })
      await writeFile(join(target, 'nested', 'a.txt'), 'a')
      await writeFile(join(root, 'keep.txt'), 'keep')
      await removeDirectoryBounded(target)
      expect(existsSync(target)).toBe(false)
      expect(existsSync(join(root, 'keep.txt'))).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test('预算耗尽时终止清理进程后才返回，允许后续重试', async () => {
    const root = await mkdtemp(join(tmpdir(), 'domi-removal-'))
    try {
      await writeFile(join(root, 'a.txt'), 'a')
      await expect(removeDirectoryBounded(root, 0)).rejects.toMatchObject({ code: 'ETIMEDOUT' })
      await removeDirectoryBounded(root)
      expect(existsSync(root)).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  test('拒绝将普通文件作为目录删除', async () => {
    const root = await mkdtemp(join(tmpdir(), 'domi-removal-'))
    try {
      const file = join(root, 'keep.txt')
      await writeFile(file, 'keep')
      await expect(removeDirectoryBounded(file)).rejects.toThrow()
      expect(existsSync(file)).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

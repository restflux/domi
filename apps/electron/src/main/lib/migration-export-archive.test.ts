import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import AdmZip from 'adm-zip'
import { MigrationExportArchive, writeMigrationArchive } from './migration-export-archive.ts'

describe('流式备份归档', () => {
  test('Given 输出流打开失败 When finalize Then 正常拒绝并可释放资源', async () => {
    const root = await mkdtemp(join(tmpdir(), 'domi-stream-'))
    const archive = new MigrationExportArchive(join(root, 'missing', 'backup.zip'))
    try {
      archive.addFile('large.bin', randomBytes(1024 * 1024))
      await expect(archive.finish()).rejects.toBeDefined()
    } finally {
      await archive.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 3000)
  test('Given 图片和文字 When 流式导出 Then 完成前落盘且旧读取器可完整读取', async () => {
    const root = await mkdtemp(join(tmpdir(), 'domi-stream-'))
    try {
      const output = join(root, 'backup.domi-backup')
      const source = join(root, 'image.png')
      const image = randomBytes(4 * 1024 * 1024)
      await writeFile(source, image)
      await writeMigrationArchive(output, async archive => {
        archive.addFile('manifest.json', Buffer.from('{"version":"2.0"}'))
        await archive.addLocalFile(source, 'sessions/image.png')
        await archive.addLocalFile(source, 'sessions\\image-copy.png')
        const temporary = (await readdir(root)).find(name => name.endsWith('.tmp'))!
        expect((await stat(join(root, temporary))).size).toBeGreaterThan(1024 * 1024)
      })
      const zip = new AdmZip(output)
      expect(zip.readFile('sessions/image.png')).toEqual(image)
      expect(zip.readFile('sessions/image-copy.png')).toEqual(image)
      zip.extractAllTo(join(root, 'restored'))
      expect(await readFile(join(root, 'restored', 'sessions', 'image.png'))).toEqual(image)
      expect(zip.getEntry('sessions/image.png')!.header.method).toBe(0)
      expect(zip.readAsText('manifest.json')).toBe('{"version":"2.0"}')
      expect((await readdir(root)).some(name => name.endsWith('.tmp'))).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('Given 已有备份 When 收集失败 Then 拒绝并清理临时文件且保留旧备份', async () => {
    const root = await mkdtemp(join(tmpdir(), 'domi-stream-'))
    const output = join(root, 'backup.domi-backup')
    try {
      await writeFile(output, '原备份')
      await expect(writeMigrationArchive(output, async archive => {
        archive.addFile('partial.txt', Buffer.from('未完成'))
        throw new Error('模拟读取失败')
      })).rejects.toThrow('模拟读取失败')
      expect(await readFile(output, 'utf8')).toBe('原备份')
      expect(await readdir(root)).toEqual(['backup.domi-backup'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test('Given 目标是目录 When 发布归档失败 Then 正常拒绝而不一直等待', async () => {
    const root = await mkdtemp(join(tmpdir(), 'domi-stream-'))
    const output = join(root, 'blocked')
    try {
      await mkdir(output)
      await expect(writeMigrationArchive(output, async archive => {
        archive.addFile('file.txt', Buffer.from('内容'))
      })).rejects.toBeDefined()
      expect(await readdir(root)).toEqual(['blocked'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

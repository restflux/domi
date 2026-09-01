import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildAgentGalleryDirectories,
  collectImagesFromMessages,
  dedupeAndSortImages,
  scanImageDirectory,
  type GalleryCoreImageItem,
} from './gallery-core'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'domi-gallery-'))
  tempDirs.push(dir)
  return dir
}

function item(overrides: Partial<GalleryCoreImageItem>): GalleryCoreImageItem {
  return {
    localPath: '/tmp/image.png',
    filename: 'image.png',
    mediaType: 'image/png',
    size: 10,
    mtime: 1,
    source: 'chat',
    ...overrides,
  }
}

describe('buildAgentGalleryDirectories', () => {
  test('Given a project cwd shared by sessions When listing one session gallery Then only its attachment directory is scanned', () => {
    expect(buildAgentGalleryDirectories('/attachments/session-b', '/workspace/project', 'project')).toEqual([
      { dir: '/attachments/session-b', source: 'agent-attachment' },
    ])
  })

  test('Given a legacy private session cwd When listing its gallery Then workspace images remain compatible', () => {
    expect(buildAgentGalleryDirectories('/attachments/session-a', '/workbench/session-a', undefined)).toEqual([
      { dir: join('/workbench/session-a', 'generated-images'), source: 'agent-workspace' },
      { dir: '/attachments/session-a', source: 'agent-attachment' },
    ])
  })
})

describe('collectImagesFromMessages', () => {
  test('仅收集 assistant 消息中的图片附件', () => {
    const result = collectImagesFromMessages([
      {
        role: 'assistant',
        createdAt: 200,
        attachments: [
          { localPath: 'c/image.png', filename: 'image.png', mediaType: 'image/png', size: 12 },
          { localPath: 'c/file.txt', filename: 'file.txt', mediaType: 'text/plain', size: 5 },
        ],
      },
      {
        role: 'user',
        createdAt: 300,
        attachments: [{ localPath: 'c/user.png', filename: 'user.png', mediaType: 'image/png', size: 9 }],
      },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      localPath: 'c/image.png',
      filename: 'image.png',
      mediaType: 'image/png',
      size: 12,
      mtime: 200,
      source: 'chat',
    })
  })
})

describe('scanImageDirectory', () => {
  test('扫描已知图片扩展名并跳过子目录与非图片', () => {
    const dir = makeTempDir()
    writeFileSync(join(dir, 'a.png'), Buffer.from('same-image'))
    writeFileSync(join(dir, 'b.WEBP'), Buffer.from('another-image'))
    writeFileSync(join(dir, 'notes.txt'), 'ignore')
    mkdirSync(join(dir, 'nested'))
    writeFileSync(join(dir, 'nested', 'inside.png'), Buffer.from('ignore-nested'))

    const result = scanImageDirectory(dir, 'agent-workspace')
    expect(result.map((entry) => entry.filename).sort()).toEqual(['a.png', 'b.WEBP'])
    expect(result.every((entry) => entry.source === 'agent-workspace')).toBe(true)
    expect(result.every((entry) => typeof entry.contentHash === 'string')).toBe(true)
  })

  test('目录不存在时返回空数组', () => {
    expect(scanImageDirectory(join(makeTempDir(), 'missing'), 'agent-attachment')).toEqual([])
  })
})

describe('dedupeAndSortImages', () => {
  test('按路径去重并保留较新的条目', () => {
    const result = dedupeAndSortImages([
      item({ localPath: '/same.png', mtime: 1, filename: 'old.png' }),
      item({ localPath: '/same.png', mtime: 3, filename: 'new.png' }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.filename).toBe('new.png')
  })

  test('同内容的 Agent 双份落盘优先保留可读文件名的工作目录条目', () => {
    const result = dedupeAndSortImages([
      item({ localPath: '/workspace/logo.png', source: 'agent-workspace', contentHash: 'same', mtime: 20 }),
      item({ localPath: '/attachments/uuid.png', source: 'agent-attachment', contentHash: 'same', mtime: 10 }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      localPath: '/workspace/logo.png',
      source: 'agent-workspace',
    })
    expect('contentHash' in result[0]!).toBe(false)
  })

  test('不同图片按 mtime 倒序', () => {
    const result = dedupeAndSortImages([
      item({ localPath: '/older.png', mtime: 10, contentHash: 'older' }),
      item({ localPath: '/newer.png', mtime: 30, contentHash: 'newer' }),
      item({ localPath: '/middle.png', mtime: 20, contentHash: 'middle' }),
    ])
    expect(result.map((entry) => entry.localPath)).toEqual(['/newer.png', '/middle.png', '/older.png'])
  })
})

import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSideChatImages } from './image-storage'
import { validateSideChatImages } from './images'

const png = { filename: '截图.png', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWP4z8BAEmIY1cAwGkr/h2vSAACQ+f8BxdOlvwAAAABJRU5ErkJggg==' }

test('Given 宿主 child workbench When 保存同名图片 Then 保留原文件且所有新文件留在 child', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'side-chat-images-'))
  try {
    writeFileSync(join(root, png.filename), 'existing')
    const refs = saveSideChatImages(root, validateSideChatImages([png, png]))
    expect(refs).toHaveLength(2)
    expect(refs[0]!.path).not.toBe(refs[1]!.path)
    for (const ref of refs) {
      expect(ref.path.startsWith(root)).toBe(true)
      expect(ref.label).toBe(png.filename)
      expect(readFileSync(ref.path).toString('base64')).toBe(png.data)
    }
    expect(readFileSync(join(root, png.filename), 'utf8')).toBe('existing')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Given workbench 被替换为链接 When 保存 Then 拒绝且不写入外部目录', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'side-chat-links-'))
  const outside = mkdtempSync(join(realpathSync(tmpdir()), 'side-chat-outside-'))
  try {
    symlinkSync(outside, join(root, 'child'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => saveSideChatImages(join(root, 'child'), validateSideChatImages([png]))).toThrow()
    expect(readdirSync(outside)).toEqual([])
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }) }
})

import { describe, expect, test } from 'bun:test'
import { getFileName, resolveSessionTargetDiffTarget } from './file-path-chip'
import { isImageFilePath } from './file-path-kind'

describe('resolveSessionTargetDiffTarget', () => {
  test('文件存在且 Session Target 为 Git 仓库时返回 Diff 目标', () => {
    expect(resolveSessionTargetDiffTarget({ relativePath: 'src/a.ts', exists: true, isGitRepo: true }))
      .toEqual({ relativePath: 'src/a.ts' })
  })

  test('非 Git 仓库、文件不存在或无检查结果时回退纯预览', () => {
    expect(resolveSessionTargetDiffTarget({ relativePath: 'notes/x.md', exists: true, isGitRepo: false })).toBeNull()
    expect(resolveSessionTargetDiffTarget({ relativePath: 'gone.ts', exists: false, isGitRepo: true })).toBeNull()
    expect(resolveSessionTargetDiffTarget(null)).toBeNull()
    expect(resolveSessionTargetDiffTarget(undefined)).toBeNull()
  })
})

describe('getFileName', () => {
  test.each([
    ['D:\\workspace\\domi\\out\\fast-history\\2026-08-07T08-19-36-221Z\\', '2026-08-07T08-19-36-221Z'],
    ['/tmp/output/archive/', 'archive'],
    ['D:\\workspace\\domi\\report.md', 'report.md'],
  ])('extracts the final file or directory name from %s', (filePath, expected) => {
    expect(getFileName(filePath)).toBe(expected)
  })
})

describe('isImageFilePath', () => {
  test.each([
    'preview.png',
    'photo.JPG',
    'asset.jpeg',
    'animation.gif',
    'capture.webp',
    'diagram.svg',
    'bitmap.bmp',
    'favicon.ico',
    'C:\\workspace\\screenshots\\result.PNG',
    '/tmp/output/image.jpg:42',
    '/tmp/output/image.jpg:42:7',
  ])('recognizes previewable image path %s', (filePath) => {
    expect(isImageFilePath(filePath)).toBe(true)
  })

  test.each([
    'notes.md',
    'archive.png.zip',
    'image',
    'image.png.txt',
    '/tmp/folder.png/',
  ])('rejects non-image path %s', (filePath) => {
    expect(isImageFilePath(filePath)).toBe(false)
  })
})

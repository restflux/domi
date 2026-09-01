import { describe, expect, test } from 'bun:test'
import { getFileName } from './file-path-chip'
import { isImageFilePath } from './file-path-kind'

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

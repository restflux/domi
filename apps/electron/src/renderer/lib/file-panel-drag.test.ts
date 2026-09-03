import { describe, expect, test } from 'bun:test'
import { getMediaTypeFromFilename } from './file-panel-drag.ts'

describe('getMediaTypeFromFilename', () => {
  test('识别右侧文件面板可直接预览的常见图片格式', () => {
    expect(getMediaTypeFromFilename('image.png')).toBe('image/png')
    expect(getMediaTypeFromFilename('photo.JPG')).toBe('image/jpeg')
    expect(getMediaTypeFromFilename('diagram.webp')).toBe('image/webp')
    expect(getMediaTypeFromFilename('icon.svg')).toBe('image/svg+xml')
  })

  test('非图片文件保持通用二进制类型', () => {
    expect(getMediaTypeFromFilename('README.md')).toBe('application/octet-stream')
    expect(getMediaTypeFromFilename('report.pdf')).toBe('application/octet-stream')
  })
})

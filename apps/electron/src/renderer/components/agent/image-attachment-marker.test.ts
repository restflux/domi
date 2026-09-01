import { describe, expect, test } from 'bun:test'
import { extractImageAttachmentMarkers } from './image-attachment-marker'

describe('extractImageAttachmentMarkers', () => {
  test('无标记时原样返回文本', () => {
    expect(extractImageAttachmentMarkers('普通工具结果')).toEqual({
      cleanText: '普通工具结果',
      markers: [],
    })
  })

  test('提取合法标记并从文本剥离', () => {
    const marker = JSON.stringify({
      localPath: 'session-1/image.png',
      filename: 'logo.png',
      mediaType: 'image/png',
    })
    expect(extractImageAttachmentMarkers(`生成完成\n[DOMI_IMAGE_ATTACHMENT:${marker}]\n共 1 张`)).toEqual({
      cleanText: '生成完成\n\n共 1 张',
      markers: [{
        localPath: 'session-1/image.png',
        filename: 'logo.png',
        mediaType: 'image/png',
      }],
    })
  })

  test('缺少 filename 时从 Windows 路径推导文件名', () => {
    const marker = JSON.stringify({
      localPath: 'C:\\Users\\Lucky\\image.webp',
      mediaType: 'image/webp',
    })
    const result = extractImageAttachmentMarkers(`[DOMI_IMAGE_ATTACHMENT:${marker}]`)
    expect(result.cleanText).toBe('')
    expect(result.markers[0]?.filename).toBe('image.webp')
  })

  test('支持路径和文件名字符串中的方括号与花括号', () => {
    const marker = JSON.stringify({
      localPath: 'C:\\images\\folder]\\image}.png',
      filename: 'image}.png',
      mediaType: 'image/png',
    })
    expect(extractImageAttachmentMarkers(`[DOMI_IMAGE_ATTACHMENT:${marker}]`)).toEqual({
      cleanText: '',
      markers: [{
        localPath: 'C:\\images\\folder]\\image}.png',
        filename: 'image}.png',
        mediaType: 'image/png',
      }],
    })
  })

  test('支持同一结果中的多个标记并保持顺序', () => {
    const first = JSON.stringify({ localPath: 's/a.png', filename: 'a.png', mediaType: 'image/png' })
    const second = JSON.stringify({ localPath: 's/b.jpg', filename: 'b.jpg', mediaType: 'image/jpeg' })
    const result = extractImageAttachmentMarkers(
      `[DOMI_IMAGE_ATTACHMENT:${first}]\n[DOMI_IMAGE_ATTACHMENT:${second}]`,
    )
    expect(result.markers.map((item) => item.filename)).toEqual(['a.png', 'b.jpg'])
    expect(result.cleanText).toBe('')
  })

  test('损坏 JSON 或缺少必填字段时原样保留', () => {
    const malformed = '[DOMI_IMAGE_ATTACHMENT:{not-json}]'
    const missingPath = '[DOMI_IMAGE_ATTACHMENT:{"mediaType":"image/png"}]'
    expect(extractImageAttachmentMarkers(`${malformed}\n${missingPath}`)).toEqual({
      cleanText: `${malformed}\n${missingPath}`,
      markers: [],
    })
  })
})

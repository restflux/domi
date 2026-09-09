import { expect, test } from 'bun:test'
import { SIDE_CHAT_MAX_IMAGE_BYTES, SIDE_CHAT_MAX_IMAGES, SIDE_CHAT_MAX_TOTAL_IMAGE_BYTES } from '@domi/shared'
import { validateSideChatImages } from './images'
import sharp from 'sharp'

const pngImage = { filename: '截图.png', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWP4z8BAEmIY1cAwGkr/h2vSAACQ+f8BxdOlvwAAAABJRU5ErkJggg==' }

test('Given 图片上传 When 校验 Then 只允许匹配 magic bytes 的四种图片和标准 base64', () => {
  expect(() => validateSideChatImages([pngImage])).not.toThrow()
  for (const invalid of [
    { ...pngImage, data: 'not-an-image' },
    { ...pngImage, data: `data:image/png;base64,${pngImage.data}` },
    { ...pngImage, data: `${pngImage.data}\n` },
    { ...pngImage, data: 'a===' },
    { ...pngImage, data: Buffer.from('<svg/>').toString('base64') },
    { ...pngImage, mediaType: 'image/jpeg' },
    { ...pngImage, mediaType: 'image/svg+xml' },
    { ...pngImage, filename: 'script.html' },
  ]) expect(() => validateSideChatImages([invalid])).toThrow()
})

test('Given 目录/保留名/控制字符 When 上传 Then 跨平台拒绝', () => {
  for (const filename of ['../a.png', '..\\a.png', '/a.png', 'C:\\a.png', 'a/b.png', 'a:stream.png', 'NUL.png', 'CON.png', 'CON .png', 'com1.png', 'LPT².png', 'a.png.', 'a.png ', '.hidden.png', 'a\n.png', 'a<.png']) {
    expect(() => validateSideChatImages([{ ...pngImage, filename }])).toThrow('文件名')
  }
})

test('Given 附件超过数量/单文件/总字节限制 When 校验 Then 在启动前拒绝', () => {
  expect(() => validateSideChatImages(Array.from({ length: SIDE_CHAT_MAX_IMAGES + 1 }, () => pngImage))).toThrow('10')
  const bytes = Buffer.alloc(SIDE_CHAT_MAX_IMAGE_BYTES + 1)
  Buffer.from(pngImage.data, 'base64').copy(bytes)
  expect(() => validateSideChatImages([{ ...pngImage, data: bytes.toString('base64') }])).toThrow('10 MB')
  const nearLimit = { ...pngImage, data: bytes.subarray(0, SIDE_CHAT_MAX_IMAGE_BYTES).toString('base64') }
  expect(SIDE_CHAT_MAX_TOTAL_IMAGE_BYTES).toBe(20 * 1024 * 1024)
  expect(() => validateSideChatImages([nearLimit, nearLimit, pngImage])).toThrow('20 MB')
})

test('Given PNG/JPEG/GIF/WebP 合法图片 When 校验 Then 四种类型均保留原始字节', async () => {
  for (const format of ['png', 'jpeg', 'gif', 'webp'] as const) {
    const bytes = await sharp(Buffer.from(pngImage.data, 'base64')).toFormat(format).toBuffer()
    const image = { filename: `图片.${format}`, mediaType: `image/${format}` as const, data: bytes.toString('base64') }
    const [validated] = validateSideChatImages([image])
    expect(validated!.mediaType).toBe(image.mediaType)
    expect(validated!.bytes.equals(bytes)).toBe(true)
  }
})

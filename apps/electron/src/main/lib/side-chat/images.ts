import { extname } from 'node:path'
import { SIDE_CHAT_IMAGE_MEDIA_TYPES, SIDE_CHAT_MAX_IMAGE_FILENAME_LENGTH, SIDE_CHAT_MAX_IMAGE_BYTES, SIDE_CHAT_MAX_TOTAL_IMAGE_BYTES, SIDE_CHAT_MAX_IMAGES } from '@domi/shared'

export interface ValidatedSideChatImage {
  filename: string
  mediaType: typeof SIDE_CHAT_IMAGE_MEDIA_TYPES[number]
  bytes: Buffer
}
const extensions: Record<ValidatedSideChatImage['mediaType'], readonly string[]> = {
  'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'], 'image/gif': ['.gif'], 'image/webp': ['.webp'],
}
function imageMediaType(bytes: Buffer): ValidatedSideChatImage['mediaType'] | undefined {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') return 'image/png'
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return 'image/webp'
  return undefined
}

/** IPC 是不可信输入；先限制编码长度，再严格解码，避免宽松 Buffer.from 静默吞掉脏数据。 */
export function validateSideChatImages(images: unknown): ValidatedSideChatImage[] {
  if (images === undefined) return []
  if (!Array.isArray(images)) throw new Error('侧聊图片列表无效')
  if (images.length > SIDE_CHAT_MAX_IMAGES) throw new Error('侧聊每次最多上传 10 张图片')
  const result: ValidatedSideChatImage[] = []
  let total = 0
  for (const image of images) {
    if (!image || typeof image !== 'object') throw new Error('侧聊图片无效')
    const name: unknown = image.filename
    // 不接受子目录、Windows ADS/设备名、控制字符或可破坏附件引用块的名称。
    if (typeof name !== 'string' || !name.trim() || name.length > SIDE_CHAT_MAX_IMAGE_FILENAME_LENGTH
      || /[\\/<>:"|?*\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(name)
      || name !== name.trim() || /[. ]$/u.test(name) || /^\./u.test(name)
      || /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:[ .]*\.|$)/iu.test(name)) {
      throw new Error('侧聊图片文件名无效，请使用不含路径的普通图片名称')
    }
    const data: unknown = image.data
    if (typeof data !== 'string' || !data.length) throw new Error('侧聊图片 base64 编码无效')
    if (data.length > Math.ceil(SIDE_CHAT_MAX_IMAGE_BYTES / 3) * 4) throw new Error('侧聊单张图片不能超过 10 MB')
    if (data.length % 4 || /[^A-Za-z0-9+/=]/u.test(data)) throw new Error('侧聊图片 base64 编码无效')
    const bytes = Buffer.from(data, 'base64')
    if (bytes.toString('base64') !== data) throw new Error('侧聊图片 base64 编码无效')
    if (bytes.length > SIDE_CHAT_MAX_IMAGE_BYTES) throw new Error('侧聊单张图片不能超过 10 MB')
    total += bytes.length
    if (total > SIDE_CHAT_MAX_TOTAL_IMAGE_BYTES) throw new Error('侧聊图片总大小不能超过 20 MB')
    const mediaType = imageMediaType(bytes)
    if (!mediaType || mediaType !== image.mediaType || !extensions[mediaType].includes(extname(name).toLowerCase())) {
      throw new Error('侧聊仅支持内容、类型和扩展名一致的 PNG、JPEG、GIF、WebP 图片')
    }
    result.push({ filename: name, mediaType, bytes })
  }
  return result
}

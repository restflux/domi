import { SIDE_CHAT_IMAGE_MEDIA_TYPES, SIDE_CHAT_MAX_IMAGES, SIDE_CHAT_MAX_IMAGE_BYTES, SIDE_CHAT_MAX_TOTAL_IMAGE_BYTES, type SideChatImageInput } from '@domi/shared'
import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import { fileToBase64 } from '@/lib/file-utils'
import { makeUniqueAttachmentName } from '@/lib/clipboard-text-attachment'

export interface SideChatPendingImage extends SideChatImageInput {
  id: string
  size: number
}

// 草稿只属于对应父会话的侧聊，不复用主输入框的附件或全局活动会话。
export const sideChatImagesAtomFamily = atomFamily((_parentId: string) => atom<SideChatPendingImage[]>([]))
export const sideChatImageLoadingAtomFamily = atomFamily((_parentId: string) => atom(false))
export const sideChatComposerErrorAtomFamily = atomFamily((_parentId: string) => atom(''))

export function imagePreview(image: SideChatPendingImage): string {
  return `data:${image.mediaType};base64,${image.data}`
}

/** 选择与粘贴共享主输入框的 File 读取/命名能力；宿主仍会独立校验全部字节。 */
export async function prepareSideChatImages(
  files: readonly File[],
  existing: readonly SideChatPendingImage[],
  read: (file: File) => Promise<string> = fileToBase64,
): Promise<SideChatPendingImage[]> {
  if (existing.length + files.length > SIDE_CHAT_MAX_IMAGES) throw new Error(`每次最多发送 ${SIDE_CHAT_MAX_IMAGES} 张图片`)
  if (existing.reduce((sum, image) => sum + image.size, 0) + files.reduce((sum, file) => sum + file.size, 0) > SIDE_CHAT_MAX_TOTAL_IMAGE_BYTES) {
    throw new Error('图片总大小不能超过 20MB')
  }
  const names = existing.map((image) => image.filename)
  const result: SideChatPendingImage[] = []
  for (const file of files) {
    if (!SIDE_CHAT_IMAGE_MEDIA_TYPES.some((mediaType) => mediaType === file.type) || file.size === 0) {
      throw new Error('请选择 PNG、JPEG、GIF 或 WebP 图片')
    }
    if (file.size > SIDE_CHAT_MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 10MB')
    const filename = makeUniqueAttachmentName(file.name, names)
    names.push(filename)
    result.push({ id: crypto.randomUUID(), filename, mediaType: file.type, data: await read(file), size: file.size })
  }
  return result
}

export function removeSentSideChatImages(current: readonly SideChatPendingImage[], sent: readonly SideChatPendingImage[]): SideChatPendingImage[] {
  const ids = new Set(sent.map((image) => image.id))
  return current.filter((image) => !ids.has(image.id))
}

/**
 * 生成图片画廊（Gallery）相关类型
 *
 * 聚合 Chat / Agent 会话中由生图工具（GPT Image、Nano Banana）产出的图片，
 * 供会话级画廊抽屉浏览与预览。
 */

/** 单张生成图片条目 */
export interface GeneratedImageItem {
  /** 本地绝对路径 */
  localPath: string
  /** 文件名 */
  filename: string
  /** MIME 类型（image/png 等） */
  mediaType: string
  /** 文件大小（字节） */
  size: number
  /** 修改时间（毫秒时间戳） */
  mtime: number
  /** 来源：chat=会话消息附件；agent-workspace=Agent 工作目录 generated-images；agent-attachment=会话附件目录 */
  source: 'chat' | 'agent-workspace' | 'agent-attachment'
}

/** 画廊列表请求：Chat 会话按 conversationId 收集消息附件，Agent 会话按 sessionId 扫描工作目录与附件目录 */
export type GeneratedImagesRequest =
  | { kind: 'chat'; conversationId: string }
  | { kind: 'agent'; sessionId: string }

export const GALLERY_IPC_CHANNELS = {
  /** 列出会话的生成图片 */
  LIST_GENERATED_IMAGES: 'gallery:list-generated-images',
  /** 读取当前会话画廊内的一张图片（base64） */
  READ_GENERATED_IMAGE: 'gallery:read-generated-image',
  /** 将当前会话画廊内的一张图片另存为 */
  SAVE_GENERATED_IMAGE_AS: 'gallery:save-generated-image-as',
} as const

export type GalleryListGeneratedImagesChannel = typeof GALLERY_IPC_CHANNELS.LIST_GENERATED_IMAGES

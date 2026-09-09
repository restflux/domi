import type { SDKMessage } from './agent'

export const SIDE_CHAT_IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export const SIDE_CHAT_MAX_IMAGES = 10
export const SIDE_CHAT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const SIDE_CHAT_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
export const SIDE_CHAT_MAX_IMAGE_FILENAME_LENGTH = 160

/** 仅传图片字节；存储目录和父子会话归属由宿主决定。 */
export interface SideChatImageInput {
  filename: string
  mediaType: string
  /** 标准 base64，不含 data: 前缀。 */
  data: string
}

export interface SideChatOpenInput { parentSessionId: string }
export interface SideChatSendInput {
  parentSessionId: string
  message: string
  channelId?: string
  modelId?: string
  quotedText?: string
  images?: SideChatImageInput[]
}
export interface SideChatView {
  parentSessionId: string
  sessionId: string
  messages: SDKMessage[]
  isRunning: boolean
  channelId?: string
  modelId?: string
}
export interface SideChatAPI {
  openSideChat(input: SideChatOpenInput): Promise<SideChatView>
  getSideChat(parentSessionId: string): Promise<SideChatView | null>
  sendSideChat(input: SideChatSendInput): Promise<void>
  stopSideChat(parentSessionId: string): Promise<void>
}
export const SIDE_CHAT_IPC_CHANNELS = {
  OPEN: 'side-chat:open', GET: 'side-chat:get', SEND: 'side-chat:send', STOP: 'side-chat:stop',
} as const

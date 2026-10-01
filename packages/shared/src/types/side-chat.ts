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

export interface SideChatOpenInput {
  parentSessionId: string
  /** 斜杠命令等入口强制新开一个侧聊；划选入口复用当前活动侧聊。 */
  forceNew?: boolean
}
export interface SideChatSendInput {
  parentSessionId: string
  /** 多开侧聊的目标子会话；缺省时由宿主解析当前活动子会话。 */
  childSessionId?: string
  message: string
  channelId?: string
  modelId?: string
  quotedText?: string
  images?: SideChatImageInput[]
}
export interface SideChatStopInput {
  parentSessionId: string
  childSessionId?: string
}
export interface SideChatCloseInput {
  parentSessionId: string
  childSessionId: string
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
  /** 打开（或新建）侧聊并返回活动子会话视图。 */
  openSideChat(input: SideChatOpenInput): Promise<SideChatView>
  /** 列出父会话下全部侧聊子会话，按创建顺序排列。 */
  listSideChats(parentSessionId: string): Promise<SideChatView[]>
  /** 关闭并删除一个侧聊子会话；返回剩余列表。运行中的子会话拒绝关闭。 */
  closeSideChat(input: SideChatCloseInput): Promise<SideChatView[]>
  sendSideChat(input: SideChatSendInput): Promise<void>
  stopSideChat(input: SideChatStopInput): Promise<void>
}
export const SIDE_CHAT_IPC_CHANNELS = {
  OPEN: 'side-chat:open', LIST: 'side-chat:list', CLOSE: 'side-chat:close', SEND: 'side-chat:send', STOP: 'side-chat:stop',
} as const

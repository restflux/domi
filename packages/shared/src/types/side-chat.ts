import type { SDKMessage } from './agent'

export interface SideChatOpenInput { parentSessionId: string }
export interface SideChatSendInput {
  parentSessionId: string
  message: string
  channelId?: string
  modelId?: string
  quotedText?: string
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

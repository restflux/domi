import { SIDE_CHAT_IPC_CHANNELS, type SideChatAPI, type SideChatSendInput } from '@domi/shared'
import { validateSideChatSend } from '../lib/side-chat/service'

interface SideChatIpcRegistrar {
  handle(channel: string, listener: (event: unknown, input: unknown) => Promise<unknown>): void
}
function parentId(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 512) throw new Error('父会话标识无效')
  return input
}
export function registerSideChatIpc(ipc: SideChatIpcRegistrar, service: SideChatAPI): void {
  ipc.handle(SIDE_CHAT_IPC_CHANNELS.OPEN, async (_, input) => {
    if (!input || typeof input !== 'object' || !('parentSessionId' in input)) throw new Error('侧聊参数无效')
    return service.openSideChat({ parentSessionId: parentId(input.parentSessionId) })
  })
  ipc.handle(SIDE_CHAT_IPC_CHANNELS.GET, async (_, input) => service.getSideChat(parentId(input)))
  ipc.handle(SIDE_CHAT_IPC_CHANNELS.SEND, async (_, input) => {
    validateSideChatSend(input as SideChatSendInput)
    // 丢弃任意额外字段，不接收 child ID、权限或自定义工具。
    const { parentSessionId, message, channelId, modelId, quotedText, images } = input as SideChatSendInput
    return service.sendSideChat({ parentSessionId, message, channelId, modelId, quotedText,
      ...(images === undefined ? {} : { images: images.map(({ filename, mediaType, data }) => ({ filename, mediaType, data })) }),
    })
  })
  ipc.handle(SIDE_CHAT_IPC_CHANNELS.STOP, async (_, input) => service.stopSideChat(parentId(input)))
}

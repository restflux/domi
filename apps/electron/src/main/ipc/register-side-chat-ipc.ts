import { SIDE_CHAT_IPC_CHANNELS, type SideChatAPI, type SideChatSendInput } from '@domi/shared'
import { validateSideChatSend } from '../lib/side-chat/service'

interface SideChatIpcRegistrar {
  handle(channel: string, listener: (event: unknown, input: unknown) => Promise<unknown>): void
}
function parentId(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 512) throw new Error('父会话标识无效')
  return input
}
function childId(input: unknown): string | undefined {
  if (input === undefined || input === null || input === '') return undefined
  if (typeof input !== 'string' || !input.trim() || input.length > 512) throw new Error('侧聊子会话标识无效')
  return input
}
export function registerSideChatIpc(ipc: SideChatIpcRegistrar, service: SideChatAPI): void {
  ipc.handle(SIDE_CHAT_IPC_CHANNELS.OPEN, async (_, input) => {
    if (!input || typeof input !== 'object' || !('parentSessionId' in input)) throw new Error('侧聊参数无效')
    const { forceNew } = input as { forceNew?: unknown }
    return service.openSideChat({
      parentSessionId: parentId((input as { parentSessionId: unknown }).parentSessionId),
      ...(forceNew === true ? { forceNew: true } : {}),
    })
  })
  ipc.handle(SIDE_CHAT_IPC_CHANNELS.LIST, async (_, input) => service.listSideChats(parentId(input)))
  ipc.handle(SIDE_CHAT_IPC_CHANNELS.CLOSE, async (_, input) => {
    if (!input || typeof input !== 'object' || !('parentSessionId' in input) || !('childSessionId' in input)) throw new Error('侧聊参数无效')
    return service.closeSideChat({
      parentSessionId: parentId((input as { parentSessionId: unknown }).parentSessionId),
      childSessionId: childId((input as { childSessionId: unknown }).childSessionId)!,
    })
  })
  ipc.handle(SIDE_CHAT_IPC_CHANNELS.SEND, async (_, input) => {
    validateSideChatSend(input as SideChatSendInput)
    // 丢弃任意额外字段；childSessionId 归属由宿主校验，不接收权限或自定义工具。
    const { parentSessionId, childSessionId, message, channelId, modelId, quotedText, images } = input as SideChatSendInput
    return service.sendSideChat({
      parentSessionId, ...(childSessionId ? { childSessionId } : {}), message, channelId, modelId, quotedText,
      ...(images === undefined ? {} : { images: images.map(({ filename, mediaType, data }) => ({ filename, mediaType, data })) }),
    })
  })
  ipc.handle(SIDE_CHAT_IPC_CHANNELS.STOP, async (_, input) => {
    if (typeof input === 'string') return service.stopSideChat({ parentSessionId: input })
    if (!input || typeof input !== 'object' || !('parentSessionId' in input)) throw new Error('侧聊参数无效')
    return service.stopSideChat({
      parentSessionId: parentId((input as { parentSessionId: unknown }).parentSessionId),
      ...(childId((input as { childSessionId?: unknown }).childSessionId) ? { childSessionId: childId((input as { childSessionId?: unknown }).childSessionId) } : {}),
    })
  })
}

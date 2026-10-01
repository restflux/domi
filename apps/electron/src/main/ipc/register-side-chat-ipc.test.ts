import { expect, test } from 'bun:test'
import { SIDE_CHAT_IPC_CHANNELS, type SideChatAPI, type SideChatView } from '@domi/shared'
import { registerSideChatIpc } from './register-side-chat-ipc'

function view(parentSessionId: string, sessionId: string): SideChatView {
  return { parentSessionId, sessionId, messages: [], isRunning: false }
}

test('IPC只接受父子会话标识和用户意图，不传递伪造权限或工具配置', async () => {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
  const calls: unknown[] = []
  const service: SideChatAPI = {
    openSideChat: async input => view(input.parentSessionId, 'child'),
    listSideChats: async () => [view('p', 'child')],
    closeSideChat: async input => [view(input.parentSessionId, 'child2')],
    sendSideChat: async input => { calls.push(input) },
    stopSideChat: async input => { calls.push(input) },
  }
  registerSideChatIpc({ handle: (channel, fn) => { handlers.set(channel, fn) } }, service)
  await handlers.get(SIDE_CHAT_IPC_CHANNELS.SEND)!({}, { parentSessionId: 'p', childSessionId: 'child', message: '问题', sessionId: 'foreign-child', workflowOverride: 'direct', customTools: ['bash'] })
  expect(calls).toEqual([{ parentSessionId: 'p', childSessionId: 'child', message: '问题', channelId: undefined, modelId: undefined, quotedText: undefined }])
  await expect(handlers.get(SIDE_CHAT_IPC_CHANNELS.SEND)!({}, { parentSessionId: 'p', message: '' })).rejects.toThrow()
  // 未知字段被丢弃（sessionId 不再是合法 child 标识）；缺 parentSessionId 仍拒绝。
  await expect(handlers.get(SIDE_CHAT_IPC_CHANNELS.STOP)!({}, { parentSessionId: 'p', sessionId: 'foreign' })).resolves.toBeUndefined()
  expect(calls[1]).toEqual({ parentSessionId: 'p' })
  await expect(handlers.get(SIDE_CHAT_IPC_CHANNELS.STOP)!({}, { childSessionId: 'foreign' })).rejects.toThrow()
  expect(await handlers.get(SIDE_CHAT_IPC_CHANNELS.OPEN)!({}, { parentSessionId: 'p' })).toMatchObject({ sessionId: 'child', isRunning: false })
  expect(await handlers.get(SIDE_CHAT_IPC_CHANNELS.OPEN)!({}, { parentSessionId: 'p', forceNew: true })).toMatchObject({ sessionId: 'child' })
  expect(await handlers.get(SIDE_CHAT_IPC_CHANNELS.LIST)!({}, 'p')).toHaveLength(1)
  expect(await handlers.get(SIDE_CHAT_IPC_CHANNELS.CLOSE)!({}, { parentSessionId: 'p', childSessionId: 'child' })).toHaveLength(1)
  // stop 兼容字符串旧签名
  await handlers.get(SIDE_CHAT_IPC_CHANNELS.STOP)!({}, 'p')
  expect(calls[2]).toEqual({ parentSessionId: 'p' })
})

test('Given Renderer 图片负载 When IPC 转交 Then 仅传字节协议并拒绝路径和伪造内容', async () => {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
  const calls: unknown[] = []
  const service: SideChatAPI = {
    openSideChat: async () => { throw new Error('unused') },
    listSideChats: async () => [],
    closeSideChat: async () => [],
    sendSideChat: async input => { calls.push(input) }, stopSideChat: async () => {},
  }
  registerSideChatIpc({ handle: (channel, fn) => { handlers.set(channel, fn) } }, service)
  const image = { filename: '截图.png', mediaType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWP4z8BAEmIY1cAwGkr/h2vSAACQ+f8BxdOlvwAAAABJRU5ErkJggg==' }
  const send = handlers.get(SIDE_CHAT_IPC_CHANNELS.SEND)!
  await send({}, { parentSessionId: 'p', message: '', images: [{ ...image, path: 'C:\foreign', childId: 'other' }], workspaceId: 'other', sessionId: 'other' })
  expect(calls).toEqual([{ parentSessionId: 'p', message: '', channelId: undefined, modelId: undefined, quotedText: undefined, images: [image] }])
  for (const images of [null, {}, ['not-an-image'], [{ ...image, filename: '..\escape.png' }], [{ ...image, data: 'ZmFrZQ==' }]]) {
    await expect(send({}, { parentSessionId: 'p', message: '看图', images })).rejects.toThrow()
  }
  expect(calls).toHaveLength(1)
})

import { expect, test } from 'bun:test'
import { SIDE_CHAT_IPC_CHANNELS, type SideChatAPI } from '@domi/shared'
import { registerSideChatIpc } from './register-side-chat-ipc'

test('IPC只接受父会话标识和用户意图，不传递伪造 child、权限或工具配置', async () => {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
  const calls: unknown[] = []
  const service: SideChatAPI = {
    openSideChat: async input => ({ parentSessionId: input.parentSessionId, sessionId: 'child', messages: [], isRunning: false }),
    getSideChat: async () => null,
    sendSideChat: async input => { calls.push(input) },
    stopSideChat: async input => { calls.push(input) },
  }
  registerSideChatIpc({ handle: (channel, fn) => { handlers.set(channel, fn) } }, service)
  await handlers.get(SIDE_CHAT_IPC_CHANNELS.SEND)!({}, { parentSessionId: 'p', message: '问题', sessionId: 'foreign-child', workflowOverride: 'direct', customTools: ['bash'] })
  expect(calls).toEqual([{ parentSessionId: 'p', message: '问题', channelId: undefined, modelId: undefined, quotedText: undefined }])
  await expect(handlers.get(SIDE_CHAT_IPC_CHANNELS.SEND)!({}, { parentSessionId: 'p', message: '' })).rejects.toThrow()
  await expect(handlers.get(SIDE_CHAT_IPC_CHANNELS.STOP)!({}, { parentSessionId: 'p', sessionId: 'foreign' })).rejects.toThrow()
  expect(await handlers.get(SIDE_CHAT_IPC_CHANNELS.OPEN)!({}, { parentSessionId: 'p' })).toMatchObject({ sessionId: 'child', isRunning: false })
})

test('Given Renderer 图片负载 When IPC 转交 Then 仅传字节协议并拒绝路径和伪造内容', async () => {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
  const calls: unknown[] = []
  const service: SideChatAPI = {
    openSideChat: async () => { throw new Error('unused') }, getSideChat: async () => null,
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

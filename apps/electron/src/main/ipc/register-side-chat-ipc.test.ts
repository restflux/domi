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

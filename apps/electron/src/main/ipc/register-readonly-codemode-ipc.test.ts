import { expect, test } from 'bun:test'
import { AGENT_IPC_CHANNELS, type AgentSessionMeta } from '@domi/shared'
import { registerReadonlyCodemodeIpc } from './register-readonly-codemode-ipc.ts'

type Handler = (event: unknown, sessionId: unknown, enabled: unknown) => Promise<AgentSessionMeta>
function harness() {
  const handlers = new Map<string, Handler>()
  const calls: Array<{ sessionId: string; readonlyCodemode: boolean }> = []
  registerReadonlyCodemodeIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, {
    update(sessionId, updates) {
      calls.push({ sessionId, ...updates })
      return { id: sessionId, title: '主任务', createdAt: 1, updatedAt: 1, ...updates }
    },
  })
  return { calls, handler: handlers.get(AGENT_IPC_CHANNELS.UPDATE_SESSION_READONLY_CODEMODE)! }
}

test('IPC仅保存指定会话的严格boolean选择，没有热改工具或授权的能力', async () => {
  const { calls, handler } = harness()
  expect(await handler({}, 'main', true)).toMatchObject({ id: 'main', readonlyCodemode: true })
  expect(await handler({}, 'main', false)).toMatchObject({ id: 'main', readonlyCodemode: false })
  expect(calls).toEqual([{ sessionId: 'main', readonlyCodemode: true }, { sessionId: 'main', readonlyCodemode: false }])
})

test('IPC拒绝非法ID/值和带授权字段的对象，不触发持久化', async () => {
  const { calls, handler } = harness()
  for (const sessionId of [null, {}, '', '  ', 1]) await expect(handler({}, sessionId, true)).rejects.toThrow('ID')
  for (const value of ['true', 1, null, undefined, { enabled: true, workflow: 'direct' }]) {
    await expect(handler({}, 'main', value)).rejects.toThrow('boolean')
  }
  expect(calls).toEqual([])
})

test('持久化失败明确返回错误，不能回报虚假的启用成功', async () => {
  let handler: Handler | undefined
  registerReadonlyCodemodeIpc({ handle: (_channel, callback) => { handler = callback } }, {
    update() { throw new Error('disk unavailable') },
  })
  await expect(handler!({}, 'main', true)).rejects.toThrow('disk unavailable')
})

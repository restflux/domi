import { describe, expect, test } from 'bun:test'
import { TERMINAL_IPC_CHANNELS } from '@domi/shared'
import { registerTerminalIpc } from './register-terminal-ipc.ts'

class FakeIpc {
  handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => unknown>()
  handle(channel: string, listener: (event: { sender: { id: number } }, input: unknown) => unknown): void {
    this.handlers.set(channel, listener)
  }
}

describe('registerTerminalIpc', () => {
  test('guards the renderer sender before dispatching to the service', async () => {
    const ipc = new FakeIpc()
    let called = false
    registerTerminalIpc(ipc, {
      createUserShell: async () => { called = true; return {} as never },
      list: async () => [], inspect: async () => ({} as never), snapshot: async () => ({} as never),
      input: async () => {}, resize: async () => {}, interrupt: async () => true, close: async () => true,
    }, { assertSender: () => { throw new Error('blocked') } })

    await expect(ipc.handlers.get(TERMINAL_IPC_CHANNELS.CREATE)?.(
      { sender: { id: 2 } },
      { ownerSessionId: 's1', cols: 80, rows: 24 },
    )).rejects.toThrow('blocked')
    expect(called).toBe(false)
  })

  test('accepts a bounded cwd while rejecting extra IPC keys and oversized terminal input', async () => {
    const ipc = new FakeIpc()
    let receivedCwd: string | undefined
    registerTerminalIpc(ipc, {
      createUserShell: async (_ownerSessionId, input) => { receivedCwd = input.cwd; return {} as never }, list: async () => [], inspect: async () => ({} as never),
      snapshot: async () => ({} as never), input: async () => {}, resize: async () => {},
      interrupt: async () => true, close: async () => true,
    }, { assertSender: () => {} })

    await ipc.handlers.get(TERMINAL_IPC_CHANNELS.CREATE)?.(
      { sender: { id: 1 } },
      { ownerSessionId: 's1', cols: 80, rows: 24, cwd: 'apps/electron' },
    )
    expect(receivedCwd).toBe('apps/electron')
    await expect(ipc.handlers.get(TERMINAL_IPC_CHANNELS.CREATE)?.(
      { sender: { id: 1 } },
      { ownerSessionId: 's1', cols: 80, rows: 24, cwd: 'bad\0path' },
    )).rejects.toThrow('终端 IPC 请求无效')
    await expect(ipc.handlers.get(TERMINAL_IPC_CHANNELS.INPUT)?.(
      { sender: { id: 1 } },
      { ownerSessionId: 's1', terminalId: 't1', data: 'x'.repeat(65_537) },
    )).rejects.toThrow('终端 IPC 请求无效')
  })
})

import { describe, expect, test } from 'bun:test'
import { isJsonRpcRequest } from '@earendil-works/pi-mcp'
import type { JsonRpcRequest } from '@earendil-works/pi-mcp'
import { createInMemoryTransportPair } from '@earendil-works/pi-mcp/testing'
import { PiMcpClientManager } from './pi-mcp-client.ts'
import { createPiMcpConnection } from './pi-mcp-connection.ts'
import { memoryMcpServer, mcpTool } from './fixtures/pi-mcp-memory-server.ts'

describe('Pi MCP 连接生命周期', () => {
  test('Given 并发同配置和后续配置变化 When 列出/调用 Then 连接按配置共享且关闭后重建不影响其他配置', async () => {
    const servers: Array<Awaited<ReturnType<typeof memoryMcpServer>>> = []
    const manager = new PiMcpClientManager(async (name, config, options) => {
      const server = await memoryMcpServer()
      servers.push(server)
      return createPiMcpConnection(name, config, { ...options, nativeTransport: server.client })
    })
    const config = { type: 'stdio', command: 'unused', env: { A: 'a', B: 'b' } }
    try {
      await Promise.all([
        manager.listTools('same', config),
        manager.listTools('same', { ...config, env: { B: 'b', A: 'a' } }),
      ])
      expect(servers).toHaveLength(1)
      await manager.listTools('same', { ...config, env: { A: 'changed' } })
      expect(servers).toHaveLength(2)
      await servers[0]!.server.close()
      expect((await manager.callTool('same', { ...config, env: { A: 'changed' } }, 'inspect', {})).content).toEqual([{ type: 'text', text: 'ok' }])
      await manager.listTools('same', config)
      expect(servers).toHaveLength(3)
      await servers[0]!.server.close()
      await manager.listTools('same', config)
      expect(servers).toHaveLength(3)
    } finally {
      await manager.dispose()
      for (const server of servers) await server.server.close()
    }
  })


  test('Given 多个调用共享启动中的连接 When 一个用户取消等待 Then 立即释放该调用且不取消其他会话连接', async () => {
    const pair = createInMemoryTransportPair()
    const initialized = Promise.withResolvers<JsonRpcRequest>()
    pair.server.onMessage(message => {
      if (!isJsonRpcRequest(message)) return
      if (message.method === 'initialize') initialized.resolve(message)
      else void pair.server.send({ jsonrpc: '2.0', id: message.id, result: { tools: [mcpTool()] } })
    })
    await pair.server.start()
    const manager = new PiMcpClientManager((name, config, options) => createPiMcpConnection(name, config, {
      ...options, nativeTransport: pair.client,
    }))
    const controller = new AbortController()
    const pending = manager.callTool('shared', { type: 'stdio', command: 'unused' }, 'inspect', {}, { signal: controller.signal }).catch(error => error)
    const initializeRequest = await initialized.promise
    controller.abort(new Error('user cancelled'))
    try {
      const settled = await Promise.race([pending, Bun.sleep(100).then(() => 'still waiting')])
      expect(settled).toBeInstanceOf(Error)
      await pair.server.send({ jsonrpc: '2.0', id: initializeRequest.id, result: {
        protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'shared', version: '1' },
      } })
      expect(await manager.listTools('shared', { type: 'stdio', command: 'unused' })).toHaveLength(1)
    } finally { await manager.dispose(); await pair.server.close(); await pending }
  })

  test('Given initialize 尚未返回 When 宿主关闭连接 Then 立即取消启动而不是等待启动超时', async () => {
    const pair = createInMemoryTransportPair()
    const initialized = Promise.withResolvers<void>()
    pair.server.onMessage(message => {
      if (isJsonRpcRequest(message) && message.method === 'initialize') initialized.resolve()
    })
    await pair.server.start()
    const manager = new PiMcpClientManager((name, config, options) => createPiMcpConnection(name, config, {
      ...options, nativeTransport: pair.client,
    }))
    const listing = manager.listTools('pending', { type: 'stdio', command: 'unused-test-only' }).catch(error => error)
    await initialized.promise
    const disposed = manager.dispose()
    try {
      expect(await Promise.race([disposed.then(() => true), Bun.sleep(100).then(() => false)])).toBe(true)
      expect(await listing).toBeInstanceOf(Error)
    } finally {
      await pair.server.close()
      await disposed
      await listing
    }
  })
})

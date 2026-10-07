import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { McpAbortError, McpTimeoutError, StdioTransport, StreamableHttpTransport, isJsonRpcRequest, parseJsonRpcMessage } from '@earendil-works/pi-mcp'
import type { JsonRpcId, JsonRpcRequest } from '@earendil-works/pi-mcp'
import * as runtime from '@earendil-works/pi-mcp'
import { createPiMcpConnection, createPiNativeMcpTransport } from './pi-mcp-connection.ts'
import { memoryMcpServer, mcpParams, isRecord } from './fixtures/pi-mcp-memory-server.ts'
import { httpMcpServer } from './fixtures/pi-mcp-http-server.ts'

const CONFIG = { type: 'stdio', command: 'unused-memory-test' }

function progressToken(request: JsonRpcRequest): number | string {
  const meta = mcpParams(request)._meta
  if (!meta || typeof meta !== 'object' || !('progressToken' in meta)) throw new Error('missing progress token')
  const token = meta.progressToken
  if (typeof token !== 'number' && typeof token !== 'string') throw new Error('invalid progress token')
  return token
}

describe('Pi MCP 原生 transport', () => {
  test('Given stdio 和 HTTP 配置 When 创建 transport Then 两者使用公开 Pi 类型且不会混入 SSE', () => {
    const stdio = createPiNativeMcpTransport({ type: 'stdio', command: 'unused', args: ['a', 3], env: { EXPLICIT: 'yes', BAD: 3 } }, runtime)
    expect(stdio).toBeInstanceOf(StdioTransport)
    if (!(stdio instanceof StdioTransport)) throw new Error('not native stdio')
    expect(stdio.options.inheritEnv).toBe(false)
    expect(stdio.options.args).toEqual(['a'])
    expect(stdio.options.env?.EXPLICIT).toBe('yes')
    expect(stdio.options.env?.BAD).toBeUndefined()
    const http = createPiNativeMcpTransport({ type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'test-only', BAD: 3 } }, runtime)
    expect(http).toBeInstanceOf(StreamableHttpTransport)
    if (!(http instanceof StreamableHttpTransport)) throw new Error('not native HTTP')
    expect(http.options.headers).toEqual({ Authorization: 'test-only' })
    expect(() => createPiNativeMcpTransport({ type: 'sse', url: 'https://example.invalid/sse' }, runtime)).toThrow('原生 MCP 不支持')
  })

  test('Given 真实 stdio 子进程 When 调用并关闭 Then 显式 env/cwd 保留而宿主私有凭据不继承且仅关闭自有进程', async () => {
    const previous = process.env.DOMI_MCP_TEST_PRIVATE_KEY
    process.env.DOMI_MCP_TEST_PRIVATE_KEY = 'test-secret-not-inherited'
    try {
      const connection = await createPiMcpConnection('stdio-test', {
        type: 'stdio', command: process.execPath,
        args: [fileURLToPath(new URL('./fixtures/pi-mcp-server.cjs', import.meta.url))],
        env: { DOMI_MCP_TEST_ALLOWED: 'explicit-value' },
      })
      let pid: number | undefined
      try {
        expect((await connection.listTools()).map(tool => tool.name)).toEqual(['inspect'])
        const result = await connection.callTool('inspect', {})
        const blocks = result.content
        const first: unknown = Array.isArray(blocks) ? blocks[0] : undefined
        if (!isRecord(first) || first.type !== 'text' || typeof first.text !== 'string') throw new Error('expected text result')
        const info: { pid: number; cwd: string; privateCredential: string | null; explicit: string } = JSON.parse(first.text)
        pid = info.pid
        expect(info.cwd).toBe(process.cwd())
        expect(info.privateCredential).toBeNull()
        expect(info.explicit).toBe('explicit-value')
        expect(() => process.kill(pid!, 0)).not.toThrow()
      } finally { await connection.close() }
      expect(pid).toBeDefined()
      expect(() => process.kill(pid!, 0)).toThrow()
      expect(() => process.kill(process.pid, 0)).not.toThrow()
    } finally {
      if (previous === undefined) delete process.env.DOMI_MCP_TEST_PRIVATE_KEY
      else process.env.DOMI_MCP_TEST_PRIVATE_KEY = previous
    }
  })
})

describe('Pi MCP HTTP 与 SSE 兼容', () => {
  test('Given HTTP 响应流中断并提供 event ID When Pi 恢复 Then 使用 Last-Event-ID GET 取原结果而不重放 POST', async () => {
    const methods: Array<{ method: string; cursor: string | null }> = []
    let callId: JsonRpcId | undefined
    const transport = new StreamableHttpTransport({
      url: 'https://example.invalid/mcp', openGetStream: false, reconnect: { initialDelayMs: 0 },
      fetch: async (input, init) => {
        const request = new Request(input, init)
        methods.push({ method: request.method, cursor: request.headers.get('last-event-id') })
        if (request.method === 'DELETE') return new Response(null, { status: 204 })
        if (request.method === 'GET') return new Response(`event: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0', id: callId, result: { content: [{ type: 'text', text: 'resumed' }] },
        })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
        const message = parseJsonRpcMessage(await request.json())
        if (!isJsonRpcRequest(message)) return new Response(null, { status: 202 })
        if (message.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: message.id, result: {
          protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'resume-test', version: '1' },
        } }, { headers: { 'Mcp-Session-Id': 'resume-test' } })
        callId = message.id
        return new Response(`id: cursor-1\nevent: message\ndata: ${JSON.stringify({
          jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: progressToken(message), progress: 1 },
        })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
      },
    })
    const connection = await createPiMcpConnection('resume', { type: 'http' }, { nativeTransport: transport })
    try {
      expect((await connection.callTool('inspect', {})).content).toEqual([{ type: 'text', text: 'resumed' }])
      expect(methods.filter(request => request.method === 'POST')).toHaveLength(3)
      expect(methods.filter(request => request.method === 'GET')).toEqual([{ method: 'GET', cursor: 'cursor-1' }])
    } finally { await connection.close() }
  })


  for (const legacySse of [false, true]) {
    test(`Given ${legacySse ? '旧 SSE' : 'Streamable HTTP'} 渠道带 headers When 列出/调用/关闭 Then 原协议和认证 headers 保持兼容`, async () => {
      const server = httpMcpServer({ legacySse })
      try {
        const connection = await createPiMcpConnection('headers-test', {
          type: legacySse ? 'sse' : 'http', url: server.url, headers: { Authorization: 'Bearer test-only' },
        })
        try {
          expect(await connection.listTools()).toHaveLength(1)
          expect((await connection.callTool('inspect', {})).content).toEqual([{ type: 'text', text: 'ok' }])
        } finally { await connection.close() }
        expect(server.requests.length).toBeGreaterThan(2)
        expect(server.requests.every(request => request.authorization === 'Bearer test-only')).toBe(true)
      } finally { server.server.stop(true) }
    })
  }
})

describe('Pi MCP 公开请求生命周期', () => {
  test('Given 工具调用进行中 When 用户取消 Then 原生取消通知发出且连接仍可复用', async () => {
    const called = Promise.withResolvers<JsonRpcRequest>()
    const server = await memoryMcpServer(request => { called.resolve(request) })
    const connection = await createPiMcpConnection('cancel', CONFIG, { nativeTransport: server.client })
    try {
      const controller = new AbortController()
      const result = connection.callTool('inspect', {}, { signal: controller.signal }).catch(error => error)
      const request = await called.promise
      controller.abort('user cancelled')
      expect(await result).toBeInstanceOf(McpAbortError)
      await Bun.sleep(0)
      expect(server.messages).toContainEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {
        requestId: request.id, reason: 'user cancelled',
      } })
      expect(await connection.listTools()).toHaveLength(1)
    } finally { await connection.close(); await server.server.close() }
  })

  test('Given 已取消的输入 When 调用工具 Then 不向服务器提交 tools/call', async () => {
    const server = await memoryMcpServer()
    const connection = await createPiMcpConnection('cancelled', CONFIG, { nativeTransport: server.client })
    try {
      await expect(connection.callTool('inspect', {}, { signal: AbortSignal.abort('cancelled') })).rejects.toBeInstanceOf(McpAbortError)
      expect(server.messages.filter(message => 'method' in message && message.method === 'tools/call')).toEqual([])
    } finally { await connection.close(); await server.server.close() }
  })

  test('Given 工具持续发送进度 When 总耗时超出单次期限 Then 原生续期并转发进度后交付最终结果', async () => {
    const server = await memoryMcpServer(async (request, transport) => {
      const token = progressToken(request)
      for (let progress = 1; progress <= 4; progress++) {
        await Bun.sleep(25)
        await transport.send({ jsonrpc: '2.0', method: 'notifications/progress', params: {
          progressToken: token, progress, total: 4, message: `step-${progress}`,
        } })
      }
      await transport.send({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'done' }] } })
    })
    const connection = await createPiMcpConnection('progress', CONFIG, { nativeTransport: server.client, requestTimeoutMs: 70 })
    try {
      const progress: number[] = []
      const result = await connection.callTool('inspect', {}, { onProgress: update => { progress.push(update.progress) } })
      expect(progress).toEqual([1, 2, 3, 4])
      expect(result.content).toEqual([{ type: 'text', text: 'done' }])
    } finally { await connection.close(); await server.server.close() }
  })

  test('Given 服务器不返回结果 When 请求超时 Then 原生失败和取消通知保留且不重放工具', async () => {
    const server = await memoryMcpServer(() => {})
    const connection = await createPiMcpConnection('timeout', CONFIG, { nativeTransport: server.client, requestTimeoutMs: 30 })
    try {
      await expect(connection.callTool('inspect', {})).rejects.toBeInstanceOf(McpTimeoutError)
      await Bun.sleep(0)
      expect(server.messages.filter(message => 'method' in message && message.method === 'tools/call')).toHaveLength(1)
      expect(server.messages.filter(message => 'method' in message && message.method === 'notifications/cancelled')).toHaveLength(1)
    } finally { await connection.close(); await server.server.close() }
  })

  test('Given 工具正在运行 When 服务器关闭连接 Then 请求失败且重复关闭安全', async () => {
    const called = Promise.withResolvers<void>()
    const server = await memoryMcpServer(() => { called.resolve() })
    const connection = await createPiMcpConnection('closed', CONFIG, { nativeTransport: server.client })
    const result = connection.callTool('inspect', {}).catch(error => error)
    await called.promise
    await server.server.close()
    expect(await result).toBeInstanceOf(Error)
    await connection.close()
    await connection.close()
  })
})

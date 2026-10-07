import { describe, expect, test } from 'bun:test'
import { isJsonRpcRequest, parseJsonRpcMessage } from '@earendil-works/pi-mcp'
import { mcpParams } from './fixtures/pi-mcp-memory-server.ts'
import { buildPiMcpToolName, buildPiMcpTools, convertMcpResultForPi, disposePiMcpConnections, getPiMcpStartupTimeoutMs } from './pi-mcp-tools.ts'

describe('Pi MCP 原生客户端行为', () => {
  test('Given 工具列表有多页 When 从真实 HTTP MCP 构建工具 Then 全部页面进入原有名称空间', async () => {
    const cursors: unknown[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        if (request.method !== 'POST') return new Response(null, { status: 405 })
        const message = parseJsonRpcMessage(await request.json())
        if (!isJsonRpcRequest(message)) return new Response(null, { status: 202 })
        if (message.method === 'initialize') return Response.json({
          jsonrpc: '2.0', id: message.id,
          result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'local-test', version: '1' } },
        })
        const params = mcpParams(message)
        cursors.push(params.cursor)
        const second = params.cursor === 'page-2'
        return Response.json({ jsonrpc: '2.0', id: message.id, result: {
          tools: [{ name: second ? 'second' : 'first', inputSchema: { type: 'object', properties: {} } }],
          ...(second ? {} : { nextCursor: 'page-2' }),
        } })
      },
    })
    try {
      const result = await buildPiMcpTools({ paged: { type: 'http', url: server.url.href } })
      expect(result.tools.map(tool => tool.name)).toEqual(['mcp__paged__first', 'mcp__paged__second'])
      expect(cursors).toEqual([undefined, 'page-2'])
    } finally {
      await disposePiMcpConnections()
      server.stop(true)
    }
  })
})

describe('Pi MCP 安全边界', () => {
  test('Given MCP 明确返回工具失败 When 转换为 Pi 结果 Then 错误标记和结构化详情不被丢弃', () => {
    const result = convertMcpResultForPi({
      content: [{ type: 'text', text: '找不到记录' }], isError: true, structuredContent: { code: 'not_found' },
    })
    expect(result.isError).toBe(true)
    expect(result.details).toMatchObject({ isError: true, structuredContent: { code: 'not_found' } })
    expect(result.content).toContainEqual({ type: 'text', text: 'MCP tool returned isError=true.' })
  })

  test('Given 外部服务器和工具名含分隔符 When 规范化 Then 可与 Domi 产品工具保留名精确碰撞检测', () => {
    expect(buildPiMcpToolName('planning', 'create-todo')).toBe('mcp__planning__create_todo')
    expect(buildPiMcpToolName('plan-ning', 'create__todo')).toBe('mcp__plan_ning__create_todo')
  })

  test('Given 没有 MCP 服务器 When 构建工具 Then 工具和能力元数据都为空', async () => {
    expect(await buildPiMcpTools({})).toEqual({ tools: [], toolAnnotations: {} })
  })

  test('Given 外部 MCP 配置超长启动超时 When 解析 Then 宿主硬上限为 60 秒', () => {
    expect(getPiMcpStartupTimeoutMs({ startup_timeout_sec: 1e12 })).toBe(60_000)
    expect(getPiMcpStartupTimeoutMs({ timeout: 45 })).toBe(45_000)
    expect(getPiMcpStartupTimeoutMs({ timeout: -1 })).toBe(30_000)
  })
})

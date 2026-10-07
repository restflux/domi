import { isJsonRpcRequest } from '@earendil-works/pi-mcp'
import type { JsonRpcMessage, JsonRpcRequest, Tool } from '@earendil-works/pi-mcp'
import { createInMemoryTransportPair } from '@earendil-works/pi-mcp/testing'
import type { InMemoryTransport } from '@earendil-works/pi-mcp/testing'

export function mcpParams(request: JsonRpcRequest): Record<string, unknown> {
  const value = request.params
  if (value === undefined) return {}
  if (isRecord(value)) return value
  throw new Error('MCP 测试服务器要求对象参数')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function mcpTool(name = 'inspect'): Tool {
  return { name, description: 'Local test tool', inputSchema: { type: 'object', properties: {} } }
}

/** 真实 Pi 客户端/transport；只模拟服务器，不替换 SDK 的请求、分页或取消实现。 */
export async function memoryMcpServer(onCall?: (request: JsonRpcRequest, server: InMemoryTransport) => void | Promise<void>) {
  const pair = createInMemoryTransportPair()
  const messages: JsonRpcMessage[] = []
  pair.server.onMessage(message => {
    messages.push(message)
    if (!isJsonRpcRequest(message)) return
    if (message.method === 'tools/call' && onCall) {
      void onCall(message, pair.server)
      return
    }
    const result = message.method === 'initialize'
      ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'memory-test', version: '1' } }
      : message.method === 'tools/list' ? { tools: [mcpTool()] }
      : { content: [{ type: 'text', text: 'ok' }] }
    void pair.server.send({ jsonrpc: '2.0', id: message.id, result }).catch(() => {})
  })
  await pair.server.start()
  return { ...pair, messages }
}

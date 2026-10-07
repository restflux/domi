import { isJsonRpcRequest, parseJsonRpcMessage } from '@earendil-works/pi-mcp'
import type { CallToolResult, JsonRpcMessage, Tool } from '@earendil-works/pi-mcp'
import { mcpTool } from './pi-mcp-memory-server.ts'

interface HttpServerOptions {
  legacySse?: boolean
  tools?: Tool[]
  callResult?: CallToolResult
}

/** 本地 HTTP/SSE 协议服务器，记录真实请求而非 mock 客户端实现。 */
export function httpMcpServer(options: HttpServerOptions = {}) {
  const messages: JsonRpcMessage[] = []
  const requests: Array<{ method: string; authorization: string | null }> = []
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  const encoder = new TextEncoder()
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      requests.push({ method: request.method, authorization: request.headers.get('authorization') })
      if (request.method === 'DELETE') return new Response(null, { status: 204 })
      if (request.method === 'GET') {
        if (!options.legacySse) return new Response(null, { status: 405 })
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller
            controller.enqueue(encoder.encode('event: endpoint\ndata: /messages\n\n'))
          },
          cancel() { stream = undefined },
        }), { headers: { 'Content-Type': 'text/event-stream' } })
      }
      const message = parseJsonRpcMessage(await request.json())
      messages.push(message)
      if (!isJsonRpcRequest(message)) return new Response(null, { status: 202 })
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'local-http-test', version: '1' } }
        : message.method === 'tools/list' ? { tools: options.tools ?? [mcpTool()] }
        : options.callResult ?? { content: [{ type: 'text', text: 'ok' }] }
      const reply = { jsonrpc: '2.0', id: message.id, result }
      if (options.legacySse) {
        stream?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(reply)}\n\n`))
        return new Response(null, { status: 202 })
      }
      return Response.json(reply, { headers: { 'Mcp-Session-Id': 'local-test-session' } })
    },
  })
  return { server, url: server.url.href, messages, requests }
}

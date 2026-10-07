import { createHash } from 'node:crypto'
import { createPiMcpConnection } from './pi-mcp-connection.ts'
import type { McpCallToolResult, PiMcpCallOptions, PiMcpConnection, PiMcpServerConfig } from './pi-mcp-connection.ts'
import type { Tool } from '@earendil-works/pi-mcp'

interface CachedConnection {
  connection: PiMcpConnection
  tools?: Tool[]
}

interface ConnectionEntry {
  controller: AbortController
  pending: Promise<CachedConnection>
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`
}

/** 只取消当前等待者，不关闭可能被其他 Work Session 共享的连接。 */
function waitForConnection(pending: Promise<CachedConnection>, signal?: AbortSignal): Promise<CachedConnection> {
  if (!signal) return pending
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new DOMException('MCP 调用已取消', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(value => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
    if (signal.aborted) onAbort()
  })
}

/** Domi 仅管理配置身份和连接共享；协议、分页和请求生命周期归客户端所有。 */
export class PiMcpClientManager {
  private readonly connections = new Map<string, ConnectionEntry>()
  private disposing?: Promise<void>

  constructor(private readonly connect = createPiMcpConnection) {}

  async dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    const entries = [...this.connections.values()]
    this.connections.clear()
    // 已连上的请求由 client.close 释放；启动中的连接必须先取消，不能等待握手期限。
    for (const entry of entries) entry.controller.abort(new Error('MCP 连接已关闭'))
    this.disposing = Promise.allSettled(entries.map(async entry => (await entry.pending).connection.close())).then(() => {})
    try { await this.disposing } finally { this.disposing = undefined }
  }

  async listTools(serverName: string, config: PiMcpServerConfig): Promise<Tool[]> {
    const entry = await this.getConnection(serverName, config)
    entry.tools ??= await entry.connection.listTools()
    return entry.tools
  }

  async callTool(serverName: string, config: PiMcpServerConfig, toolName: string, args: Record<string, unknown>, options: PiMcpCallOptions = {}): Promise<McpCallToolResult> {
    options.signal?.throwIfAborted()
    const entry = await waitForConnection(this.getConnection(serverName, config), options.signal)
    options.signal?.throwIfAborted()
    return entry.connection.callTool(toolName, args, options)
  }

  private getConnection(serverName: string, config: PiMcpServerConfig): Promise<CachedConnection> {
    if (this.disposing) return Promise.reject(new Error('MCP 连接正在关闭'))
    const hash = createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 16)
    const key = `${serverName}:${hash}`
    const existing = this.connections.get(key)
    if (existing) return existing.pending
    const controller = new AbortController()
    const entry: ConnectionEntry = {
      controller,
      // 延迟 factory，先登记身份；同步失败/关闭回调也不能误删后续同配置连接。
      pending: Promise.resolve().then(() => this.connect(serverName, config, {
        signal: controller.signal,
        onClose: () => { if (this.connections.get(key) === entry) this.connections.delete(key) },
      })).then(async connection => {
        if (controller.signal.aborted) {
          await connection.close()
          controller.signal.throwIfAborted()
        }
        return { connection }
      }).catch(error => {
        if (this.connections.get(key) === entry) this.connections.delete(key)
        throw error
      }),
    }
    this.connections.set(key, entry)
    return entry.pending
  }
}

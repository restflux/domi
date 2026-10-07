import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { CallToolResult, McpTransport, ProgressNotification, Tool } from '@earendil-works/pi-mcp'

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

export interface PiMcpServerConfig {
  type?: unknown
  command?: unknown
  args?: unknown
  env?: unknown
  url?: unknown
  headers?: unknown
  startup_timeout_sec?: unknown
  timeout?: unknown
  trustReadOnlyAnnotations?: unknown
}

export type McpCallToolResult = CallToolResult | Awaited<ReturnType<Client['callTool']>>

export interface PiMcpCallOptions {
  signal?: AbortSignal
  onProgress?: (progress: Pick<ProgressNotification, 'progress' | 'total' | 'message'>) => void
}

export interface PiMcpConnection {
  listTools(): Promise<Tool[]>
  callTool(name: string, args: Record<string, unknown>, options?: PiMcpCallOptions): Promise<McpCallToolResult>
  close(): Promise<void>
}

export interface PiMcpConnectionOptions {
  signal?: AbortSignal
  onClose?: () => void
  /** 可注入公开 transport 测试真实协议；生产入口始终按 Domi 配置创建。 */
  nativeTransport?: McpTransport
  requestTimeoutMs?: number
}

export function getPiMcpStartupTimeoutMs(config: PiMcpServerConfig): number {
  const seconds = typeof config.startup_timeout_sec === 'number' ? config.startup_timeout_sec
    : typeof config.timeout === 'number' ? config.timeout : undefined
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return 30_000
  return Math.min(seconds * 1_000, 60_000)
}

function stringValues(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

export function createPiNativeMcpTransport(config: PiMcpServerConfig, runtime: typeof import('@earendil-works/pi-mcp')): McpTransport {
  if (config.type === 'stdio') {
    if (typeof config.command !== 'string' || !config.command.trim()) throw new Error('MCP stdio 配置缺少 command')
    return new runtime.StdioTransport({
      command: config.command,
      args: Array.isArray(config.args) ? config.args.filter((arg): arg is string => typeof arg === 'string') : undefined,
      // Pi 默认继承整个 process.env；保留原 SDK 的安全环境名单，不能把宿主凭据传给外部进程。
      inheritEnv: false,
      env: { ...getDefaultEnvironment(), ...stringValues(config.env) },
      stderr: 'inherit',
    })
  }
  if (config.type === 'http') {
    if (typeof config.url !== 'string' || !config.url.trim()) throw new Error('MCP HTTP 配置缺少 url')
    return new runtime.StreamableHttpTransport({ url: config.url, headers: stringValues(config.headers) })
  }
  throw new Error(`原生 MCP 不支持此传输类型: ${String(config.type)}`)
}

/** 启动期限涵盖 transport.start，不能仅依赖 initialize 请求自身的超时。 */
async function connectBeforeDeadline(name: string, config: PiMcpServerConfig, start: () => Promise<unknown>, close: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    await Promise.race([
      start(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`MCP 服务器 ${name} 启动超时`)), getPiMcpStartupTimeoutMs(config))
        onAbort = () => reject(signal?.reason ?? new Error('MCP 连接已取消'))
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) onAbort()
      }),
    ])
    signal?.throwIfAborted()
  } catch (error) {
    await close().catch(() => {})
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

/** 只为 legacy HTTP+SSE 保留官方 SDK；不为 HTTP 配置自动回退到该协议。 */
async function createLegacySseConnection(name: string, config: PiMcpServerConfig, options: PiMcpConnectionOptions): Promise<PiMcpConnection> {
  if (typeof config.url !== 'string' || !config.url.trim()) throw new Error('MCP SSE 配置缺少 url')
  const headers = stringValues(config.headers)
  const transport = new SSEClientTransport(new URL(config.url), {
    requestInit: headers ? { headers } : undefined,
    eventSourceInit: headers ? { fetch: (input, init) => {
      const merged = new Headers(init?.headers)
      for (const [key, value] of Object.entries(headers)) merged.set(key, value)
      return fetch(input, { ...init, headers: merged })
    } } : undefined,
  })
  const client = new Client({ name: 'domi-pi-agent-mcp-bridge', version: '0.1.0' }, { capabilities: {} })
  client.onclose = options.onClose
  let closing: Promise<void> | undefined
  client.onerror = (error) => { if (!closing) console.warn(`[Pi MCP] MCP 服务器 ${name} transport error:`, error) }
  const close = () => closing ??= client.close()
  await connectBeforeDeadline(name, config,
    () => client.connect(transport, { timeout: getPiMcpStartupTimeoutMs(config) }), close, options.signal)
  const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  return {
    listTools: async () => (await client.listTools(undefined, { timeout })).tools,
    callTool: (toolName, args, call = {}) => client.callTool({ name: toolName, arguments: args }, undefined, {
      signal: call.signal, timeout, resetTimeoutOnProgress: true, onprogress: call.onProgress,
    }),
    close,
  }
}

export async function createPiMcpConnection(name: string, config: PiMcpServerConfig, options: PiMcpConnectionOptions = {}): Promise<PiMcpConnection> {
  options.signal?.throwIfAborted()
  if (config.type === 'sse') return createLegacySseConnection(name, config, options)
  // Electron main.cjs 必须保留原生 dynamic import，不能静态 require ESM-only Pi。
  const runtime = await import('@earendil-works/pi-mcp')
  options.signal?.throwIfAborted()
  const transport = options.nativeTransport ?? createPiNativeMcpTransport(config, runtime)
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const client = new runtime.McpClient({
    name: 'domi-pi-agent-mcp-bridge', version: '0.1.0', capabilities: {},
    requestTimeoutMs: getPiMcpStartupTimeoutMs(config),
  })
  if (options.onClose) client.onClose(options.onClose)
  let closing: Promise<void> | undefined
  client.onError(error => { if (!closing) console.warn(`[Pi MCP] MCP 服务器 ${name} transport error:`, error) })
  const close = () => closing ??= client.close()
  await connectBeforeDeadline(name, config, () => client.connect(transport), close, options.signal)
  return {
    listTools: () => client.listTools({ timeoutMs }),
    callTool: (toolName, args, call = {}) => client.callTool(toolName, args, {
      signal: call.signal, timeoutMs,
      // 提供 callback 才会声明 progressToken，Pi 才能按服务端进度续期请求超时。
      onProgress: call.onProgress ?? (() => {}),
    }),
    close,
  }
}

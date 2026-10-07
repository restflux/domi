/**
 * Pi Runtime 用户 MCP 工具桥接层
 *
 * Domi 保留配置、工具身份与权限桥接；stdio/Streamable HTTP 由 Pi 原生客户端负责，
 * legacy HTTP+SSE 保留官方 SDK 兼容路径，不加载 Pi CLI MCP 配置或凭据。
 */

import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { TextContent, ImageContent } from '@earendil-works/pi-ai'
import type { TSchema } from 'typebox'
import { Type } from 'typebox'
import type { AgentToolAnnotationsMap } from '../agent-tool-annotations.ts'
import { resolveEffectiveMcpToolAnnotations } from './pi-mcp-trust.ts'

import { PiMcpClientManager } from './pi-mcp-client.ts'
import type { McpCallToolResult, PiMcpServerConfig } from './pi-mcp-connection.ts'
import type { Tool as McpToolInfo } from '@earendil-works/pi-mcp'
export { getPiMcpStartupTimeoutMs } from './pi-mcp-connection.ts'
export type { McpCallToolResult, PiMcpServerConfig } from './pi-mcp-connection.ts'

type PiMcpServers = Record<string, Record<string, unknown>>

interface McpToolBinding {
  serverName: string
  originalToolName: string
  tool: McpToolInfo
  manager: PiMcpClientManager
  managerConfig: PiMcpServerConfig
}

function normalizeToolSegment(segment: string): string {
  const normalized = segment.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (!normalized) return 'unnamed'
  return /^[A-Za-z_]/.test(normalized) ? normalized : `_${normalized}`
}

export function buildPiMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeToolSegment(serverName)}__${normalizeToolSegment(toolName)}`
}

function isObjectSchema(schema: unknown): schema is Record<string, unknown> {
  return !!schema && typeof schema === 'object' && !Array.isArray(schema)
}

function toTypeBoxSchema(schema: unknown): TSchema {
  if (!isObjectSchema(schema)) return Type.Object({})
  if (schema.type !== 'object') return Type.Object({})
  return Type.Unsafe(schema)
}

function stringifyForTool(content: unknown): string {
  if (typeof content === 'string') return content
  try {
    return JSON.stringify(content, null, 2)
  } catch {
    return String(content)
  }
}

function sanitizeMcpResultDetails(result: McpCallToolResult): Record<string, unknown> {
  const details = { ...result } as Record<string, unknown>
  if ('content' in result && Array.isArray(result.content)) {
    details.content = result.content.map((block) => block.type === 'image'
      ? { type: 'image', mimeType: block.mimeType, dataOmitted: true }
      : block)
  }
  return details
}

/** 将 MCP 原始结果转换为 Pi tool result；图片随后由 AgentSession 统一归一化。 */
export function convertMcpResultForPi(result: McpCallToolResult): AgentToolResult<unknown> {
  const content: Array<TextContent | ImageContent> = []

  if ('content' in result && Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text') {
        content.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        content.push({ type: 'image', data: block.data, mimeType: block.mimeType })
      } else {
        content.push({ type: 'text', text: stringifyForTool(block) })
      }
    }
  } else if ('toolResult' in result) {
    content.push({ type: 'text', text: stringifyForTool(result.toolResult) })
  }

  if ('structuredContent' in result && result.structuredContent !== undefined) {
    content.push({ type: 'text', text: `structuredContent:\n${stringifyForTool(result.structuredContent)}` })
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: stringifyForTool(result) })
  }

  if ('isError' in result && result.isError) {
    content.unshift({ type: 'text', text: 'MCP tool returned isError=true.' })
  }

  return {
    content,
    ...(result.isError === true ? { isError: true } : {}),
    // content 已经进入标准 tool result；details 只保留可展示元数据，避免原始图片
    // Base64 与归一化后的图片一起进入 transcript、IPC 和会话持久化。
    details: sanitizeMcpResultDetails(result),
  }
}

const manager = new PiMcpClientManager()

function createPiMcpToolDefinition(binding: McpToolBinding): ToolDefinition {
  const toolName = buildPiMcpToolName(binding.serverName, binding.originalToolName)
  const description = binding.tool.description || `Call MCP tool ${binding.originalToolName} from server ${binding.serverName}`

  return {
    name: toolName,
    label: toolName,
    description,
    promptSnippet: `${toolName}: ${description}`,
    parameters: toTypeBoxSchema(binding.tool.inputSchema),
    async execute(_toolCallId, params, signal, onUpdate) {
      const args = isObjectSchema(params) ? params : {}
      const result = await binding.manager.callTool(binding.serverName, binding.managerConfig, binding.originalToolName, args, {
        signal,
        onProgress: onUpdate ? progress => onUpdate({
          content: [{ type: 'text', text: progress.message ?? 'MCP 工具执行中' }],
          details: { progress: progress.progress, total: progress.total },
        }) : undefined,
      })
      return convertMcpResultForPi(result)
    },
  }
}

/**
 * 将 Domi 已构建的 MCP server 配置转换为 Pi customTools。
 *
 * 注意：本函数是 Domi 唯一的 Agent MCP transport 入口。
 */
export interface PiMcpToolsResult {
  tools: ToolDefinition[]
  toolAnnotations: AgentToolAnnotationsMap
}

export async function buildPiMcpTools(
  mcpServers: PiMcpServers,
  reservedToolNames: ReadonlySet<string> = new Set(),
): Promise<PiMcpToolsResult> {
  const tools: ToolDefinition[] = []
  const toolAnnotations: AgentToolAnnotationsMap = {}
  const seenToolNames = new Set<string>()

  // 并行连接所有 MCP 服务器，避免串行等待导致启动慢
  const entries = Object.entries(mcpServers).filter(([, rawConfig]) => {
    const type = (rawConfig as PiMcpServerConfig).type
    return type === 'stdio' || type === 'http' || type === 'sse'
  })

  const results = await Promise.allSettled(
    entries.map(async ([serverName, rawConfig]) => {
      const config = rawConfig as PiMcpServerConfig
      const mcpTools = await manager.listTools(serverName, config)
      return { serverName, config, mcpTools }
    }),
  )

  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('[Pi MCP] 连接或列出 MCP 服务器工具失败，已跳过:', result.reason)
      continue
    }
    const { serverName, config, mcpTools } = result.value
    for (const tool of mcpTools) {
      const piToolName = buildPiMcpToolName(serverName, tool.name)
      if (reservedToolNames.has(piToolName)) {
        console.warn(`[Pi MCP] 工具名 ${piToolName} 与 Domi 产品工具冲突，已跳过 ${serverName}/${tool.name}`)
        continue
      }
      if (seenToolNames.has(piToolName)) {
        console.warn(`[Pi MCP] 工具名冲突 ${piToolName}，已跳过 ${serverName}/${tool.name}`)
        continue
      }
      seenToolNames.add(piToolName)
      const annotations = resolveEffectiveMcpToolAnnotations({
        config,
        toolName: piToolName,
        serverAnnotations: tool.annotations,
      })
      if (annotations) toolAnnotations[piToolName] = annotations
      tools.push(createPiMcpToolDefinition({
        serverName,
        originalToolName: tool.name,
        tool,
        manager,
        managerConfig: config,
      }))
    }
  }

  if (tools.length > 0) {
    console.log(`[Pi MCP] 已桥接 ${tools.length} 个用户 MCP 工具到 Pi customTools`)
  }

  return { tools, toolAnnotations }
}

/**
 * 关闭所有 MCP 连接。应在 app quit 时调用以清理 stdio 子进程。
 */
export async function disposePiMcpConnections(): Promise<void> {
  await manager.dispose()
}

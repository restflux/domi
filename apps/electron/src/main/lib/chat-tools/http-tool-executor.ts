/**
 * HTTP 工具执行器（自定义工具用）
 *
 * 根据 ChatToolMeta 中的 httpConfig 配置执行 HTTP 请求。
 * 支持 URL/Body 模板占位符替换、超时控制、响应路径提取。
 */

import type { ToolCall, ToolResult } from '@domi/core'
import type { ChatToolMeta, ChatToolHttpConfig } from '@domi/shared'
import { getChatToolsConfig, getToolCredentials } from '../chat-tool-config.ts'
import { ManagedWebAccess, ManagedWebAccessDeniedError } from '../managed-web-access/managed-web-access.ts'
import { getManagedWebAccess } from '../managed-web-access/managed-web-runtime.ts'
import {
  MissingHttpToolCredentialError,
  resolveHttpTemplate,
} from './http-tool-credentials.ts'

/** HTTP 请求超时（30 秒） */
const HTTP_TIMEOUT_MS = 30_000

/**
 * 判断是否为自定义 HTTP 工具调用
 *
 * 通过查找 customTools 配置判断 toolName 是否属于自定义工具。
 */
export function isCustomHttpToolCall(toolName: string): boolean {
  const config = getChatToolsConfig()
  return config.customTools.some((t) => t.id === toolName)
}

/**
 * 通过点号路径提取嵌套对象的值
 *
 * @param obj 源对象
 * @param path 点号路径（如 "data.results"）
 * @returns 提取的值，路径不存在时返回 undefined
 */
function extractByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj

  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }

  return current
}

/**
 * 执行自定义 HTTP 工具调用
 *
 * @param toolCall 模型返回的工具调用
 * @param meta 工具元数据（包含 httpConfig）
 * @returns 工具执行结果
 */
export async function executeHttpTool(
  toolCall: ToolCall,
  meta: ChatToolMeta,
  managedWebAccess: ManagedWebAccess = getManagedWebAccess(),
  credentials: Record<string, string> = getToolCredentials(meta.id),
): Promise<ToolResult> {
  const httpConfig = meta.httpConfig

  if (!httpConfig) {
    return {
      toolCallId: toolCall.id,
      content: `工具 ${meta.id} 缺少 HTTP 配置`,
      isError: true,
    }
  }

  try {
    const result = await executeHttpRequest(
      toolCall.arguments,
      httpConfig,
      credentials,
      managedWebAccess,
    )
    return {
      toolCallId: toolCall.id,
      content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
    }
  } catch (error) {
    const msg = error instanceof ManagedWebAccessDeniedError
      ? `访问被拒绝 (${error.decision.reason})`
      : error instanceof MissingHttpToolCredentialError
        ? `缺少凭据: ${error.credentialKey}`
        : error instanceof Error && /^(?:HTTP \d{3}|Managed Web Access redirect limit exceeded)$/.test(error.message)
          ? error.message
          : 'network_error'
    console.warn(`[HTTP 工具] ${meta.id} 执行失败 (${msg})`)
    return {
      toolCallId: toolCall.id,
      content: `HTTP 请求失败: ${msg}`,
      isError: true,
    }
  }
}

/**
 * 执行 HTTP 请求
 */
async function executeHttpRequest(
  args: Record<string, unknown>,
  config: ChatToolHttpConfig,
  credentials: Record<string, string>,
  managedWebAccess: ManagedWebAccess,
): Promise<unknown> {
  const url = resolveHttpTemplate(config.urlTemplate, args, credentials, true).value

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const trustedCredentialHeaderTemplates: Record<string, string> = {}
  for (const [key, template] of Object.entries(config.headers ?? {})) {
    const resolved = resolveHttpTemplate(template, args, credentials, false)
    headers[key] = resolved.value
    if (resolved.credentialValues.length > 0) {
      trustedCredentialHeaderTemplates[key] = resolved.valueWithoutCredentials
    }
  }

  const fetchInit: RequestInit = {
    method: config.method,
    headers,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  }

  let trustedCredentialBodyTemplate: string | undefined
  if (config.method === 'POST' && config.bodyTemplate) {
    const resolvedBody = resolveHttpTemplate(config.bodyTemplate, args, credentials, false)
    fetchInit.body = resolvedBody.value
    if (resolvedBody.credentialValues.length > 0) {
      trustedCredentialBodyTemplate = resolvedBody.valueWithoutCredentials
    }
  }

  const response = await managedWebAccess.fetch(url, fetchInit, 'custom_http', {
    headers,
    body: fetchInit.body,
    trustedCredentialHeaderTemplates,
    trustedCredentialBodyTemplate,
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  // 解析响应
  const contentType = response.headers.get('content-type') || ''
  let data: unknown

  if (contentType.includes('application/json')) {
    data = await response.json()
  } else {
    data = await response.text()
  }

  // 路径提取
  if (config.resultPath && typeof data === 'object' && data !== null) {
    const extracted = extractByPath(data, config.resultPath)
    return extracted !== undefined ? extracted : data
  }

  return data
}

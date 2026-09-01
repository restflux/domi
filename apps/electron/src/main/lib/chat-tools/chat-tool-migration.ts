import type { ChatToolHttpConfig, MigrationFileMode } from '@domi/shared'
import { assertSafeHttpToolConfig } from './http-tool-credentials.ts'

export interface ChatToolsMigrationConfig {
  toolStates?: unknown
  toolCredentials?: Record<string, unknown>
  customTools?: unknown[]
  [key: string]: unknown
}

function customToolId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = (value as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

/**
 * 迁移包不得携带自定义 HTTP 运行时凭据。
 * 旧配置若仍把 secret 写在 httpConfig，导出/导入时移除整个不安全 httpConfig，
 * 保留工具元数据供用户重新配置，而不是把明文凭据传播到归档。
 */
export function sanitizeChatToolsForMigration(
  config: ChatToolsMigrationConfig,
  mode: MigrationFileMode,
): ChatToolsMigrationConfig {
  const customTools = (config.customTools ?? []).map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    const tool = { ...(value as Record<string, unknown>) }
    if (tool.executorType !== 'http' || !tool.httpConfig) return tool
    try {
      assertSafeHttpToolConfig(tool.httpConfig as ChatToolHttpConfig)
      return tool
    } catch {
      delete tool.httpConfig
      return tool
    }
  })
  const customIds = new Set((config.customTools ?? []).map(customToolId).filter((id): id is string => Boolean(id)))
  const toolCredentials = mode === 'share'
    ? {}
    : Object.fromEntries(
        Object.entries(config.toolCredentials ?? {}).filter(([toolId]) => !customIds.has(toolId)),
      )

  return {
    ...config,
    toolCredentials,
    customTools,
  }
}

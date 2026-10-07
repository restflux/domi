import type { AgentSession, InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent'

export const PI_MCP_TOOL_SEARCH_NAME = 'tool_search'

interface PiToolSearchSdk {
  createToolSearchExtension: typeof import('@earendil-works/pi-coding-agent').createToolSearchExtension
  getCurrentTools: typeof import('@earendil-works/pi-ai/utils/transcript').getCurrentTools
}

interface PiMcpToolDiscoveryOptions {
  enabled?: boolean
  tools: ToolDefinition[]
  toolSources?: Readonly<Record<string, string>>
}

export interface PiMcpToolDiscovery {
  tools: ToolDefinition[]
  extensionFactories: InlineExtension[]
  initialize(session: AgentSession): void
  isOwnedTool(session: AgentSession, name: string): boolean
  exposeAllMcpTools(session: AgentSession): void
}

/**
 * 默认全量曝光；内部 opt-in 只改变 Domi 已桥接 MCP 的模型可见定义。
 * 检索与加载持久化归 Pi；此处不建立检索算法、连接或执行授权。
 */
export function preparePiMcpToolDiscovery(sdk: PiToolSearchSdk, options: PiMcpToolDiscoveryOptions): PiMcpToolDiscovery {
  const mcpNames = new Set(options.tools
    .filter(tool => options.toolSources?.[tool.name] === 'mcp')
    .map(tool => tool.name))
  const enabled = options.enabled === true && mcpNames.size > 0
  if (enabled && options.tools.some(tool => tool.name === PI_MCP_TOOL_SEARCH_NAME)) {
    throw new Error('tool_search 与已有自定义工具冲突，不能启用 MCP 发现')
  }

  const tools = enabled ? options.tools.map(tool => mcpNames.has(tool.name)
    ? { ...tool, exposure: 'deferred' as const,
        namespace: tool.namespace ?? { name: tool.name.slice(0, tool.name.lastIndexOf('__')) } }
    : tool) : options.tools
  let ownedDefinition: object | undefined

  const exposeAllMcpTools = (session: AgentSession): void => {
    session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), ...mcpNames])])
  }
  const isOwnedTool = (session: AgentSession, name: string): boolean => enabled
    && name === PI_MCP_TOOL_SEARCH_NAME
    && ownedDefinition !== undefined
    && session.getToolDefinition(name) === ownedDefinition

  const extensionFactories: InlineExtension[] = enabled ? [{
    name: 'domi-mcp-tool-search', hidden: true,
    factory(pi) {
      // 仅向公开原生 factory 提供本轮用户 MCP 目录，不搜索其他扩展的 deferred 工具。
      return sdk.createToolSearchExtension()({
        ...pi,
        getAllTools: () => pi.getAllTools().filter(tool => mcpNames.has(tool.name)),
        registerTool(definition) {
          if (definition.name !== PI_MCP_TOOL_SEARCH_NAME) throw new Error('Pi 发现工具合同已变化')
          const guarded = {
            ...definition, defaultActive: true,
            async execute(...args: Parameters<typeof definition.execute>) {
              if (args[2]?.aborted) throw new Error('MCP 工具发现已取消')
              return definition.execute(...args)
            },
          }
          ownedDefinition = guarded
          pi.registerTool(guarded)
        },
      })
    },
  }] : []

  return {
    tools, extensionFactories, isOwnedTool, exposeAllMcpTools,
    initialize(session) {
      if (!enabled) {
        // 从实验 transcript 回到默认路径时，不能沿用曾经缩小的 MCP 活跃集合。
        if ([...mcpNames].some(name => !session.getActiveToolNames().includes(name))) exposeAllMcpTools(session)
        return
      }
      if (!isOwnedTool(session, PI_MCP_TOOL_SEARCH_NAME)) throw new Error('tool_search 归属冲突，不能启用 MCP 发现')
      // SDK 的 noTools:builtin 传入显式初始集合，不恢复 transcript loadout。
      // 使用公开投影/工具回放补齐已加载的 MCP 名称，不推断历史调用或复制私有恢复算法。
      const restoredMcpNames = sdk.getCurrentTools(session.sessionManager.buildSessionProjection().messages)
        .filter(tool => mcpNames.has(tool.name)).map(tool => tool.name)
      // 只追加已恢复定义，核心工具按原定义保持常驻。
      session.setActiveToolsByName([...new Set([
        ...session.getActiveToolNames(), PI_MCP_TOOL_SEARCH_NAME, ...restoredMcpNames,
        ...tools.filter(tool => !mcpNames.has(tool.name) && tool.defaultActive !== false
          && (tool.exposure === undefined || tool.exposure === 'direct' || tool.exposure === 'model-only'))
          .map(tool => tool.name),
      ])])
    },
  }
}

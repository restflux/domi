const LINKED_IMAGE_TOOL_IDS = new Set(['gpt-image', 'nano-banana'])

type CapabilityVersionUpdater = (update: (version: number) => number) => void
type ChatToolStateUpdater = (toolId: string, state: { enabled: boolean }) => Promise<void>
type ChatToolListLoader<T> = () => Promise<T>
type ChatToolListSetter<T> = (tools: T) => void

export function isLinkedImageToolId(toolId: string): boolean {
  return LINKED_IMAGE_TOOL_IDS.has(toolId)
}

/**
 * 生图 Chat 工具与 Agent 内置 MCP 共用开关。
 * Chat 入口写入成功后递增能力版本，让已挂载的技能/MCP 视图立即重新拉取状态。
 */
export async function updateChatToolWithLinkedCapabilities(options: {
  toolId: string
  enabled: boolean
  updateToolState: ChatToolStateUpdater
  updateCapabilityVersion: CapabilityVersionUpdater
}): Promise<void> {
  await options.updateToolState(options.toolId, { enabled: options.enabled })
  if (isLinkedImageToolId(options.toolId)) {
    options.updateCapabilityVersion((version) => version + 1)
  }
}

/** 从 Agent MCP 入口切换生图能力后，刷新 Chat 工具 atom，保持反向界面同步。 */
export async function refreshChatToolsForLinkedBuiltinMcp<T>(options: {
  toolId: string
  loadChatTools: ChatToolListLoader<T>
  setChatTools: ChatToolListSetter<T>
}): Promise<boolean> {
  if (!isLinkedImageToolId(options.toolId)) return false
  options.setChatTools(await options.loadChatTools())
  return true
}

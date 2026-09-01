import type { ChatToolState } from '@domi/shared'
import { getToolState, updateToolState } from './chat-tool-config'
import { isBuiltinMcpUserEnabled, setBuiltinMcpUserEnabled } from './builtin-mcp/settings'

const LINKED_IMAGE_TOOL_IDS = new Set(['gpt-image', 'nano-banana'])

export function isLinkedImageToolId(id: string): boolean {
  return LINKED_IMAGE_TOOL_IDS.has(id)
}

/**
 * Agent 侧读取生图能力时兼容旧版双配置：任一入口曾开启，都视为已开启。
 * 新版切换会同步写入两侧，union 语义只承担升级迁移和异常写入恢复。
 */
export function isBuiltinMcpEnabledForAgent(id: string): boolean {
  if (!isLinkedImageToolId(id)) return isBuiltinMcpUserEnabled(id)
  return isBuiltinMcpUserEnabled(id) || getToolState(id).enabled
}

/** 从「AI 工具」入口切换，并同步 Agent 内置 MCP 开关。 */
export function updateLinkedChatToolState(toolId: string, state: ChatToolState): void {
  updateToolState(toolId, state)
  if (!isLinkedImageToolId(toolId)) return
  if (isBuiltinMcpUserEnabled(toolId) !== state.enabled) {
    setBuiltinMcpUserEnabled(toolId, state.enabled)
  }
}

/** 从 Agent 能力/MCP 入口切换，并同步「AI 工具」开关。 */
export function updateLinkedBuiltinMcpState(id: string, enabled: boolean): void {
  setBuiltinMcpUserEnabled(id, enabled)
  if (!isLinkedImageToolId(id)) return
  if (getToolState(id).enabled !== enabled) {
    updateToolState(id, { enabled })
  }
}

/**
 * 升级迁移：旧版本可能只开启了 Chat 或 Agent 其中一侧。
 * 启动时以“任一侧已开启”为准补齐另一侧，避免升级后能力被静默关闭。
 */
export function reconcileLinkedImageToolStates(): void {
  for (const id of LINKED_IMAGE_TOOL_IDS) {
    const chatEnabled = getToolState(id).enabled
    const builtinEnabled = isBuiltinMcpUserEnabled(id)
    const enabled = chatEnabled || builtinEnabled
    if (!enabled) continue
    if (!chatEnabled) updateToolState(id, { enabled: true })
    if (!builtinEnabled) setBuiltinMcpUserEnabled(id, true)
  }
}

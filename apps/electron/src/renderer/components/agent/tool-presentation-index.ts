import type {
  SDKMessage,
  SDKSystemMessage,
  SDKToolResultBlock,
  SDKUserMessage,
} from '@domi/shared'
import { parseToolResultContent, type GeneratedToolImage } from './tool-result-images'

export interface SubAgentPresentationMeta {
  durationMs: number
  totalTokens: number
  toolUses: number
}

export interface ToolPresentationEntry {
  completed: boolean
  result?: string
  isError: boolean
  images: GeneratedToolImage[]
  subAgentMeta?: SubAgentPresentationMeta
}

export type ToolPresentationIndex = ReadonlyMap<string, ToolPresentationEntry>

function emptyEntry(): ToolPresentationEntry {
  return {
    completed: false,
    isError: false,
    images: [],
  }
}

/**
 * 单次扫描消息序列，建立工具展示所需的结果索引。
 *
 * 工具行、过程摘要和连续调用聚合共享该索引，避免每个工具块重复遍历完整会话。
 */
export function buildToolPresentationIndex(messages: readonly SDKMessage[]): Map<string, ToolPresentationEntry> {
  const index = new Map<string, ToolPresentationEntry>()

  for (const message of messages) {
    if (message.type === 'user') {
      const content = (message as SDKUserMessage).message?.content
      if (!Array.isArray(content)) continue

      for (const block of content) {
        if (block.type !== 'tool_result') continue
        const resultBlock = block as SDKToolResultBlock
        // 与旧实现保持一致：同一 toolUseId 出现重复结果时采用最早一条。
        if (index.get(resultBlock.tool_use_id)?.completed) continue
        const parsed = parseToolResultContent(resultBlock.content)
        const previous = index.get(resultBlock.tool_use_id) ?? emptyEntry()
        index.set(resultBlock.tool_use_id, {
          ...previous,
          completed: true,
          result: parsed.text,
          isError: resultBlock.is_error === true,
          images: parsed.images,
        })
      }
      continue
    }

    if (message.type !== 'system') continue
    const systemMessage = message as SDKSystemMessage
    if (systemMessage.subtype !== 'task_notification' || !systemMessage.tool_use_id || !systemMessage.usage) continue
    const previous = index.get(systemMessage.tool_use_id) ?? emptyEntry()
    index.set(systemMessage.tool_use_id, {
      ...previous,
      subAgentMeta: {
        durationMs: systemMessage.usage.duration_ms ?? 0,
        totalTokens: systemMessage.usage.total_tokens ?? 0,
        toolUses: systemMessage.usage.tool_uses ?? 0,
      },
    })
  }

  return index
}

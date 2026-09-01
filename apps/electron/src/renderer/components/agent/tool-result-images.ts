/**
 * Agent 工具结果图片提取 — 纯数据层
 *
 * 同时服务：
 * - ContentBlock 内的工具结果图片预览
 * - AssistantTurnRenderer 底部的「本轮生成图片」缩略图带
 */

import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKToolResultBlock,
  SDKToolUseBlock,
  SDKUserMessage,
} from '@domi/shared'
import { extractImageAttachmentMarkers } from './image-attachment-marker'

export interface GeneratedToolImage {
  /** base64 数据（不含 data: 前缀），与 localPath 二选一 */
  data?: string
  /** 附件相对路径或 ~/.domi 内绝对路径 */
  localPath?: string
  mimeType: string
  filename?: string
}

export interface ParsedToolResultContent {
  text?: string
  images: GeneratedToolImage[]
}

/**
 * 解析单个 tool_result content。
 *
 * MCP 生图工具会同时返回 inline image 与附件标记；标记存在时优先使用 path 型，
 * 避免同一张图重复展示。旧工具只有 inline image 时仍可回退。
 */
export function parseToolResultContent(content: unknown): ParsedToolResultContent {
  let text: string | undefined
  const inlineImages: GeneratedToolImage[] = []

  if (typeof content === 'string') {
    text = content
  } else if (Array.isArray(content)) {
    const textParts: string[] = []
    for (const item of content as Array<{ type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }>) {
      if (item.type === 'text' && typeof item.text === 'string') {
        textParts.push(item.text)
      } else if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
        inlineImages.push({ data: item.data, mimeType: item.mimeType })
      }
    }
    text = textParts.join('\n')
  }

  if (!text) return { text, images: inlineImages }

  const extracted = extractImageAttachmentMarkers(text)
  if (extracted.markers.length === 0) {
    return { text: extracted.cleanText, images: inlineImages }
  }

  return {
    text: extracted.cleanText,
    images: extracted.markers.map((marker) => ({
      localPath: marker.localPath,
      mimeType: marker.mediaType,
      filename: marker.filename,
    })),
  }
}

const IMAGE_GENERATION_TOOL_NAMES = new Set([
  'imagegen',
  'generate_image',
  'image_gen',
])

/**
 * 判断工具是否为图片生成/编辑工具。
 *
 * 同时兼容原始工具名、Domi 内置 MCP 名，以及 provider 可能返回的 namespace.tool 形式。
 * Read 等仅返回图片内容的工具不属于生图工具。
 */
export function isImageGenerationToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase()
  if (IMAGE_GENERATION_TOOL_NAMES.has(normalized)) return true
  const leafName = normalized.split(/(?:__|[./:])/).at(-1)
  return leafName != null && IMAGE_GENERATION_TOOL_NAMES.has(leafName)
}

/** 只收集给定 assistant 消息中的生图 tool_use ID。 */
export function collectAssistantGeneratedImageToolUseIds(messages: SDKAssistantMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    const content = message.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type !== 'tool_use') continue
      const toolUse = block as SDKToolUseBlock
      if (isImageGenerationToolName(toolUse.name)) ids.add(toolUse.id)
    }
  }
  return ids
}

/** 图片内容身份标识（localPath 或内联数据），用于跨渲染稳定追踪图片 src */
export function imageIdentity(image: GeneratedToolImage): string {
  if (image.localPath) return `path:${image.localPath}`
  return `inline:${image.mimeType}:${image.data ?? ''}`
}

/**
 * 从消息列表中只收集指定 tool_use ID 的图片，并返回 tool ID → 图片列表。
 * 这样底部缩略图严格绑定当前 assistant turn，不会混入其他轮次。
 */
export function collectGeneratedImagesByToolId(
  messages: SDKMessage[],
  toolUseIds: ReadonlySet<string>,
): Map<string, GeneratedToolImage[]> {
  const byToolId = new Map<string, GeneratedToolImage[]>()
  const seenByToolId = new Map<string, Set<string>>()

  for (const message of messages) {
    if (message.type !== 'user') continue
    const content = (message as SDKUserMessage).message?.content
    if (!Array.isArray(content)) continue

    for (const block of content) {
      if (block.type !== 'tool_result') continue
      const result = block as SDKToolResultBlock
      if (!toolUseIds.has(result.tool_use_id)) continue

      const parsed = parseToolResultContent(result.content)
      if (parsed.images.length === 0) continue

      const images = byToolId.get(result.tool_use_id) ?? []
      const seen = seenByToolId.get(result.tool_use_id) ?? new Set<string>()
      for (const image of parsed.images) {
        const identity = imageIdentity(image)
        if (seen.has(identity)) continue
        seen.add(identity)
        images.push(image)
      }
      byToolId.set(result.tool_use_id, images)
      seenByToolId.set(result.tool_use_id, seen)
    }
  }

  return byToolId
}

/**
 * 收集直接或间接包含生成图片的 tool_use ID。
 *
 * 子 Agent/Task 可以继续派生 Agent/Task；图片结果属于最深层工具时，沿
 * parent_tool_use_id 链向上冒泡，确保最外层过程组展开时也能隐藏底部重复缩略图。
 */
export function collectImageContainingToolUseIds(
  assistantMessages: SDKAssistantMessage[],
  imagesByToolId: ReadonlyMap<string, GeneratedToolImage[]>,
): Set<string> {
  const parentByToolId = new Map<string, string>()

  for (const message of assistantMessages) {
    const parentToolUseId = message.parent_tool_use_id
    const content = message.message?.content
    if (!parentToolUseId || !Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use') {
        parentByToolId.set((block as SDKToolUseBlock).id, parentToolUseId)
      }
    }
  }

  const containingIds = new Set<string>()
  for (const [toolUseId, images] of imagesByToolId) {
    if (images.length === 0) continue
    let currentId: string | undefined = toolUseId
    const visited = new Set<string>()
    while (currentId && !visited.has(currentId)) {
      visited.add(currentId)
      containingIds.add(currentId)
      currentId = parentByToolId.get(currentId)
    }
  }

  return containingIds
}

/** 按 tool_use 在 assistant turn 中的出现顺序展平并去重。 */
export function flattenGeneratedImagesForTurn(
  assistantMessages: SDKAssistantMessage[],
  imagesByToolId: ReadonlyMap<string, GeneratedToolImage[]>,
): GeneratedToolImage[] {
  const result: GeneratedToolImage[] = []
  const seen = new Set<string>()

  for (const message of assistantMessages) {
    const content = message.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type !== 'tool_use') continue
      const images = imagesByToolId.get((block as SDKToolUseBlock).id) ?? []
      for (const image of images) {
        const identity = imageIdentity(image)
        if (seen.has(identity)) continue
        seen.add(identity)
        result.push(image)
      }
    }
  }
  return result
}

/** 底部缩略图仅在已完成、存在图片且对应过程组全部折叠时展示。 */
export function shouldShowTurnGeneratedImages({
  imageCount,
  isStreaming,
  expandedImageGroupCount,
}: {
  imageCount: number
  isStreaming: boolean
  expandedImageGroupCount: number
}): boolean {
  return imageCount > 0 && !isStreaming && expandedImageGroupCount === 0
}

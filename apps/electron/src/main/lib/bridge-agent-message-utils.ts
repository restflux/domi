import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKToolResultBlock,
  SDKToolUseBlock,
  SDKUserMessage,
} from '@domi/shared'

export interface BridgeGeneratedImage {
  localPath?: string
  data?: string
  filename: string
  mediaType: string
}

const IMAGE_GENERATION_TOOL_NAMES = new Set(['imagegen', 'generate_image', 'image_gen'])
const IMAGE_ATTACHMENT_MARKER_PREFIX = '[DOMI_IMAGE_ATTACHMENT:'

export function isImageGenerationToolName(toolName: string): boolean {
  const normalized = toolName.trim().toLowerCase()
  if (IMAGE_GENERATION_TOOL_NAMES.has(normalized)) return true
  const leafName = normalized.split(/(?:__|[./:])/).at(-1)
  return leafName != null && IMAGE_GENERATION_TOOL_NAMES.has(leafName)
}

function findJsonObjectEnd(text: string, start: number): number {
  if (text[start] !== '{') return -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return index
  }
  return -1
}

function extractAttachmentMarkers(text: string): BridgeGeneratedImage[] {
  const images: BridgeGeneratedImage[] = []
  let cursor = 0
  while (cursor < text.length) {
    const markerStart = text.indexOf(IMAGE_ATTACHMENT_MARKER_PREFIX, cursor)
    if (markerStart === -1) break
    const jsonStart = markerStart + IMAGE_ATTACHMENT_MARKER_PREFIX.length
    const jsonEnd = findJsonObjectEnd(text, jsonStart)
    if (jsonEnd === -1 || text[jsonEnd + 1] !== ']') break
    try {
      const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>
      if (typeof parsed.localPath === 'string' && parsed.localPath && typeof parsed.mediaType === 'string') {
        images.push({
          localPath: parsed.localPath,
          filename: typeof parsed.filename === 'string' && parsed.filename
            ? parsed.filename
            : parsed.localPath.split(/[\\/]/).pop() || 'image',
          mediaType: parsed.mediaType,
        })
      }
    } catch {
      // 损坏的展示标记不应中断 Bridge 的最终回复。
    }
    cursor = jsonEnd + 2
  }
  return images
}

function extractToolResultImages(content: unknown): BridgeGeneratedImage[] {
  const images: BridgeGeneratedImage[] = []
  const textParts: string[] = []
  if (typeof content === 'string') {
    textParts.push(content)
  } else if (Array.isArray(content)) {
    for (const item of content as Array<Record<string, unknown>>) {
      if (item?.type === 'text' && typeof item.text === 'string') textParts.push(item.text)
      else if (item?.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
        const extension = item.mimeType === 'image/jpeg'
          ? 'jpg'
          : item.mimeType === 'image/webp'
            ? 'webp'
            : 'png'
        images.push({
          data: item.data,
          filename: `generated-image.${extension}`,
          mediaType: item.mimeType,
        })
      }
    }
  }

  const markerImages = extractAttachmentMarkers(textParts.join('\n'))
  return markerImages.length > 0 ? markerImages : images
}

export function collectGeneratedImageToolUseIds(message: SDKMessage): string[] {
  if (message.type !== 'assistant' || isPartialSDKMessage(message)) return []
  const assistant = message as SDKAssistantMessage
  return (assistant.message?.content ?? [])
    .filter((block): block is SDKToolUseBlock => block.type === 'tool_use')
    .filter((block) => isImageGenerationToolName(block.name))
    .map((block) => block.id)
}

export function extractGeneratedImagesFromToolResults(
  message: SDKMessage,
  generatedImageToolUseIds: ReadonlySet<string>,
): BridgeGeneratedImage[] {
  if (message.type !== 'user') return []
  const content = (message as SDKUserMessage).message?.content
  if (!Array.isArray(content)) return []

  const images: BridgeGeneratedImage[] = []
  const seen = new Set<string>()
  for (const block of content) {
    if (block.type !== 'tool_result') continue
    const toolResult = block as SDKToolResultBlock
    if (!generatedImageToolUseIds.has(toolResult.tool_use_id)) continue
    for (const image of extractToolResultImages(toolResult.content)) {
      const identity = image.localPath
        ? `path:${image.localPath}`
        : `inline:${image.mediaType}:${image.data ?? ''}`
      if (seen.has(identity)) continue
      seen.add(identity)
      images.push(image)
    }
  }
  return images
}

/**
 * Pi runtime 的 message_update 会用 _partial 标记预览帧。
 * 这些帧通常携带“当前累计全文”，只适合 UI upsert，不应进入 IM Bridge 的最终回复 buffer。
 */
export function isPartialSDKMessage(message: SDKMessage): boolean {
  return (message as Record<string, unknown>)._partial === true
}

export function extractFinalAssistantText(message: SDKMessage): string {
  if (message.type !== 'assistant') return ''
  if (isPartialSDKMessage(message)) return ''

  const assistant = message as SDKAssistantMessage
  return (assistant.message?.content ?? [])
    .map((block) => block.type === 'text' && typeof block.text === 'string' ? block.text : '')
    .join('')
}

/**
 * Nano Banana 生图工具模块（Chat 模式）
 *
 * 基于 Gemini Image Generation API 提供 AI 生图能力。
 * 支持文生图、参考图编辑、多轮连续修改。
 * 凭据存储在 ~/.domi/chat-tools.json 的 toolCredentials 中。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@domi/core'
import type { ChatToolMeta, FileAttachment, ImageGenerationSelection } from '@domi/shared'
import { randomUUID } from 'node:crypto'
import { resolveImageGenerationConfig, isImageGenerationAvailable } from '../image-generation/config'
import { generateImages, clearImageGenerationHistory, type GenerationMetadata } from '../image-generation/service'
import { saveAttachment, readAttachmentAsBase64, isImageAttachment } from '../attachment-service'

// ===== Gemini API 类型（REST API 使用 camelCase） =====

interface GeminiInlineData {
  mimeType: string
  data: string
}

interface GeminiPart {
  text?: string
  inlineData?: GeminiInlineData
  /** Gemini 多轮对话必需：模型生成图片时附带的签名，回传时原样保留 */
  thoughtSignature?: string
  /** snake_case 兼容（部分 API 版本） */
  thought_signature?: string
  /** Flash 思考模式下的 reasoning part，不应作为输出图展示 */
  thought?: boolean
}

// ===== 工具执行上下文 =====

/** Nano Banana 工具执行所需的额外上下文 */
export interface NanoBananaContext {
  /** 主进程本次请求的内存快照，不持久化。null 表示发送时不可用。 */
  preparedConfig?: import('../image-generation/config').ImageGenerationConfig | null
  imageGeneration?: ImageGenerationSelection
  signal?: AbortSignal
  imageGenerationRun?: import('../image-generation/run').ImageGenerationRun
  /** 对话 ID（用于保存附件和管理对话历史） */
  conversationId: string
  /** 当前用户消息的附件列表 */
  currentAttachments?: FileAttachment[]
  /** 前一轮用户消息的附件 */
  previousUserAttachments?: FileAttachment[]
  /** 前一轮助手消息的附件 */
  previousAssistantAttachments?: FileAttachment[]
}

// ===== 默认配置 =====


// ===== 工具元数据 =====

export const NANO_BANANA_TOOL_META: ChatToolMeta = {
  id: 'nano-banana',
  name: 'Nano Banana',
  description: 'AI 图片生成与编辑（基于 Gemini Image Generation）',
  params: [
    { name: 'prompt', type: 'string', description: '图片生成/编辑描述', required: true },
  ],
  icon: 'ImagePlus',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<nano_banana_instructions>
你拥有 AI 图片生成和编辑能力（Nano Banana）。

**generate_image — 生成/编辑图片：**
当用户需要创建或修改图片时调用：
- 用户要求画画、生成图片、创作插图
- 用户上传了图片并要求修改、编辑、调整
- 用户想要基于描述生成视觉内容

**参数说明：**
- prompt: 详细描述想要生成的图片内容，用英文描述效果最佳
- aspectRatio: 可选宽高比 "1:1"(默认) / "16:9" / "4:3" / "9:16" / "3:4"
- imageSize: 可选分辨率 "auto"(默认) / "1K" / "2K" / "4K"
- numberOfImages: 可选生成数量 1-4（默认 1），用户要求多张时设置
- useReferenceImages: 当用户上传了参考图或要求修改之前生成的图片时设为 true

**使用技巧：**
- 生成新图片时用详细的英文描述
- 编辑图片时设置 useReferenceImages: true，并在 prompt 中描述要做的修改
- 支持连续修改：多次调用时会自动保持上下文
</nano_banana_instructions>`,
}

// ===== 工具定义（ToolDefinition 格式，传给 Provider） =====

export const NANO_BANANA_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'generate_image',
    description: 'Generate or edit images using AI. Supports text-to-image generation, reference image editing, and iterative modifications with context.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate or the edits to make. English descriptions work best.',
        },
        aspectRatio: {
          type: 'string',
          description: 'Aspect ratio of the generated image',
          enum: ['1:1', '16:9', '4:3', '9:16', '3:4'],
        },
        imageSize: {
          type: 'string',
          description: 'Resolution of the generated image',
          enum: ['auto', '1K', '2K', '4K'],
        },
        useReferenceImages: {
          type: 'string',
          description: 'Set to "true" to use uploaded reference images or previously generated images for editing',
          enum: ['true', 'false'],
        },
        numberOfImages: {
          type: 'number',
          description: 'Number of images to generate (1-4, default 1)',
        },
      },
      required: ['prompt'],
    },
  },
]

// ===== 可用性检查 =====

/**
 * 检查 Nano Banana 工具是否可用（API Key 已配置）
 */
export function isNanoBananaAvailable(): boolean {
  return isImageGenerationAvailable('nano-banana')
}

// ===== 工具执行 =====

/** 工具名称集合 */
const NANO_BANANA_TOOL_NAMES = new Set(['generate_image'])

/**
 * 判断是否为 Nano Banana 工具调用
 */
export function isNanoBananaToolCall(toolName: string): boolean {
  return NANO_BANANA_TOOL_NAMES.has(toolName)
}

/**
 * 收集参考图的 base64 数据
 *
 * 按时间从早到晚排列：前一轮用户附件 → 前一轮助手附件 → 当前用户附件
 */
function collectReferenceImages(context: NanoBananaContext): GeminiPart[] {
  const parts: GeminiPart[] = []

  const allAttachments: FileAttachment[] = [
    ...(context.previousUserAttachments ?? []),
    ...(context.previousAssistantAttachments ?? []),
    ...(context.currentAttachments ?? []),
  ]

  for (const attachment of allAttachments) {
    if (!isImageAttachment(attachment.mediaType)) continue

    try {
      const base64 = readAttachmentAsBase64(attachment.localPath)
      parts.push({
        inlineData: {
          mimeType: attachment.mediaType,
          data: base64,
        },
      })
    } catch (error) {
      console.warn(`[Nano Banana] 读取参考图失败: ${attachment.localPath}`, error)
    }
  }

  return parts
}

export interface NanoBananaExecutionResult extends ToolResult {
  imageGeneration?: GenerationMetadata
}

export async function executeNanoBananaTool(toolCall: ToolCall, context: NanoBananaContext): Promise<NanoBananaExecutionResult> {
  try {
    if (context.preparedConfig === null) throw new Error('本次请求没有可用的生图配置，请重新选择后发送')
    const config = context.preparedConfig ?? resolveImageGenerationConfig('nano-banana', context.imageGeneration)
    const prompt = typeof toolCall.arguments.prompt === 'string' ? toolCall.arguments.prompt : ''
    const useReferences = toolCall.arguments.useReferenceImages === 'true' || toolCall.arguments.useReferenceImages === true
    const references = useReferences ? collectReferenceImages(context).flatMap((part) => part.inlineData ? [part.inlineData] : []) : []
    const result = await generateImages(config, prompt, context.conversationId, references, {
      size: typeof toolCall.arguments.size === 'string' ? toolCall.arguments.size : undefined,
      aspectRatio: typeof toolCall.arguments.aspectRatio === 'string' ? toolCall.arguments.aspectRatio : undefined,
      imageSize: typeof toolCall.arguments.imageSize === 'string' ? toolCall.arguments.imageSize : undefined,
      numberOfImages: typeof toolCall.arguments.numberOfImages === 'number' ? toolCall.arguments.numberOfImages : undefined,
      signal: context.signal,
      run: context.imageGenerationRun,
    })
    context.signal?.throwIfAborted()
    const generatedAttachments = result.images.map((image) => saveAttachment({
      conversationId: context.conversationId,
      filename: `nano-banana-${randomUUID().slice(0, 8)}${image.mimeType === 'image/jpeg' ? '.jpg' : '.png'}`,
      mediaType: image.mimeType, data: image.data,
    }).attachment)
    context.imageGenerationRun?.acknowledgeResult()
    return { toolCallId: toolCall.id, content: `图片已成功生成（${generatedAttachments.length} 张）${result.text.length ? '\n\n' + result.text.join('\n') : ''}`,
      generatedAttachments, imageGeneration: result.metadata }
  } catch (error) {
    return { toolCallId: toolCall.id, content: `图片任务未完成: ${error instanceof Error ? error.message : '未知错误'}`, isError: true }
  }
}

export function clearNanoBananaHistory(conversationId: string): void {
  clearImageGenerationHistory(conversationId)
}

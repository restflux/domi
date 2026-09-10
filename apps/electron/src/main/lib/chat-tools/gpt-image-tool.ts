/**
 * GPT Image 生图工具模块（Chat 模式）
 *
 * 基于 OpenAI Images API 提供 AI 生图能力，模型由本次生图选择或兼容配置决定。
 * 实现对齐 Codex 的 image_generation.imagegen 工具
 * （codex-rs/ext/image-generation）：
 * - 文生图：POST {base}/images/generations
 * - 参考图编辑：POST {base}/images/edits（images: [{ image_url: "data:..." }]）
 * - 响应 data[].b64_json → base64 解码保存为附件
 *
 * 凭据存储在 ~/.domi/chat-tools.json 的 toolCredentials['gpt-image'] 中，
 * 支持自定义 baseUrl（OpenAI 兼容端点 / 中转）。
 */

import type { ToolCall, ToolResult, ToolDefinition } from '@domi/core'
import type { ChatToolMeta, FileAttachment, ImageGenerationSelection } from '@domi/shared'
import { randomUUID } from 'node:crypto'
import { resolveImageGenerationConfig, isImageGenerationAvailable } from '../image-generation/config'
import { generateImages, type GeneratedImage, type GenerationMetadata } from '../image-generation/service'
import { saveAttachment, readAttachmentAsBase64, isImageAttachment } from '../attachment-service'

// ===== OpenAI Images API 类型（与 Codex codex-api/src/images.rs 对齐） =====

/** 编辑请求最多携带的参考图数量（对齐 Codex MAX_EDIT_IMAGES） */
const MAX_EDIT_IMAGES = 5

// ===== 工具元数据 =====

export const GPT_IMAGE_TOOL_META: ChatToolMeta = {
  id: 'gpt-image',
  name: 'GPT Image',
  description: 'AI 图片生成与编辑（使用已选 GPT Image 模型）',
  params: [
    { name: 'prompt', type: 'string', description: '图片生成/编辑描述', required: true },
  ],
  icon: 'ImagePlus',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<gpt_image_instructions>
你拥有基于 OpenAI GPT Image 的图片生成和编辑能力；实际模型与参数由用户选择和宿主配置决定。

**imagegen — 生成/编辑图片：**
当用户需要创建或修改图片时调用：
- 用户要求生成图片、绘制插图、设计 logo / 海报等
- 用户上传了图片并要求修改、编辑、调整
- 用户想要基于描述生成视觉内容

**参数说明：**
- prompt: 详细描述要生成的图片内容
- aspectRatio: 可选宽高比 "1:1"(默认) / "16:9" / "9:16"
- size: 可选分辨率 "auto"(默认) / "1024x1024" / "1536x1024" / "1024x1536"（指定后优先于 aspectRatio）
- numberOfImages: 可选生成数量 1-4（默认 1），用户要求多张时设置
- useReferenceImages: 当用户上传了参考图或要求修改之前生成的图片时设为 "true"

**使用技巧：**
- 生成新图时给出详尽描述（风格、构图、光线、细节）
- 编辑图片时设置 useReferenceImages: "true"，并在 prompt 中描述要做的修改
- 用户要求明确时直接生成，无需二次确认
- 生成约需 30 秒到 2 分钟
</gpt_image_instructions>`,
}

// ===== 工具定义（ToolDefinition 格式，传给 Provider） =====

export const GPT_IMAGE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'imagegen',
    description: 'Generate or edit images using OpenAI GPT Image (gpt-image-2). Supports text-to-image generation and reference image editing.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate or the edits to make.',
        },
        aspectRatio: {
          type: 'string',
          description: 'Aspect ratio of the generated image',
          enum: ['1:1', '16:9', '9:16'],
        },
        size: {
          type: 'string',
          description: 'Resolution of the generated image. Takes precedence over aspectRatio when specified.',
          enum: ['auto', '1024x1024', '1536x1024', '1024x1536'],
        },
        useReferenceImages: {
          type: 'string',
          description: 'Set to "true" to edit uploaded reference images or previously generated images',
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
 * 检查 GPT Image 工具是否可用（API Key 已配置）
 */
export function isGptImageAvailable(): boolean {
  return isImageGenerationAvailable('gpt-image')
}

// ===== 工具执行 =====

/** 工具名称集合 */
const GPT_IMAGE_TOOL_NAMES = new Set(['imagegen'])

/**
 * 判断是否为 GPT Image 工具调用
 */
export function isGptImageToolCall(toolName: string): boolean {
  return GPT_IMAGE_TOOL_NAMES.has(toolName)
}

/** GPT Image 工具执行所需的额外上下文 */
export interface GptImageContext {
  /** 主进程本次请求的内存快照，不持久化。null 表示发送时不可用。 */
  preparedConfig?: import('../image-generation/config').ImageGenerationConfig | null
  imageGeneration?: ImageGenerationSelection
  signal?: AbortSignal
  imageGenerationRun?: import('../image-generation/run').ImageGenerationRun
  /** 对话 ID（用于保存附件） */
  conversationId: string
  /** 当前用户消息的附件列表 */
  currentAttachments?: FileAttachment[]
  /** 前一轮用户消息的附件 */
  previousUserAttachments?: FileAttachment[]
  /** 前一轮助手消息的附件（含历史生成图） */
  previousAssistantAttachments?: FileAttachment[]
}

/**
 * 收集参考图（base64 data URL）
 *
 * 按时间从早到晚排列：前一轮用户附件 → 前一轮助手附件 → 当前用户附件。
 * 最多携带 MAX_EDIT_IMAGES 张，超出截断。
 */
function collectReferenceImages(context: GptImageContext): GeneratedImage[] {
  const allAttachments: FileAttachment[] = [
    ...(context.previousUserAttachments ?? []),
    ...(context.previousAssistantAttachments ?? []),
    ...(context.currentAttachments ?? []),
  ]

  const images: GeneratedImage[] = []
  for (const attachment of allAttachments) {
    if (images.length >= MAX_EDIT_IMAGES) break
    if (!isImageAttachment(attachment.mediaType)) continue

    try {
      const base64 = readAttachmentAsBase64(attachment.localPath)
      images.push({
        mimeType: attachment.mediaType, data: base64,
      })
    } catch (error) {
      console.warn(`[GPT Image] 读取参考图失败: ${attachment.localPath}`, error)
    }
  }

  return images
}

export { buildImagesRequest } from '../image-generation/service'

export interface GptImageExecutionResult extends ToolResult {
  imageGeneration?: GenerationMetadata
}

export async function executeGptImageTool(toolCall: ToolCall, context: GptImageContext): Promise<GptImageExecutionResult> {
  try {
    if (context.preparedConfig === null) throw new Error('本次请求没有可用的生图配置，请重新选择后发送')
    const config = context.preparedConfig ?? resolveImageGenerationConfig('gpt-image', context.imageGeneration)
    const prompt = typeof toolCall.arguments.prompt === 'string' ? toolCall.arguments.prompt : ''
    const useReferences = toolCall.arguments.useReferenceImages === 'true' || toolCall.arguments.useReferenceImages === true
    const references = useReferences ? collectReferenceImages(context) : []
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
      filename: `gpt-image-${randomUUID().slice(0, 8)}${image.mimeType === 'image/jpeg' ? '.jpg' : '.png'}`,
      mediaType: image.mimeType, data: image.data,
    }).attachment)
    context.imageGenerationRun?.acknowledgeResult()
    return { toolCallId: toolCall.id, content: `图片已成功生成（${generatedAttachments.length} 张）${result.text.length ? '\n\n' + result.text.join('\n') : ''}`,
      generatedAttachments, imageGeneration: result.metadata }
  } catch (error) {
    return { toolCallId: toolCall.id, content: `图片任务未完成: ${error instanceof Error ? error.message : '未知错误'}`, isError: true }
  }
}

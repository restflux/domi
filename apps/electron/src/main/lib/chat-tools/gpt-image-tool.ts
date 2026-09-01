/**
 * GPT Image 生图工具模块（Chat 模式）
 *
 * 基于 OpenAI Images API 提供 AI 生图能力，模型为 gpt-image-2。
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
import type { ChatToolMeta, FileAttachment } from '@domi/shared'
import { randomUUID } from 'node:crypto'
import { getToolCredentials } from '../chat-tool-config'
import { saveAttachment, readAttachmentAsBase64, isImageAttachment } from '../attachment-service'

// ===== OpenAI Images API 类型（与 Codex codex-api/src/images.rs 对齐） =====

interface ImagesApiImageUrl {
  image_url: string
}

interface ImagesApiDataItem {
  /** 生成图的 base64（首选） */
  b64_json?: string
  /** 部分兼容端点返回 URL 而非 base64 */
  url?: string
}

interface ImagesApiResponse {
  created?: number
  data?: ImagesApiDataItem[]
  error?: { message?: string; code?: string }
}

// ===== 默认配置 =====

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MODEL = 'gpt-image-2'

/** 单次请求超时（生成型 API 较慢，放宽到 3 分钟） */
const REQUEST_TIMEOUT_MS = 180_000

/** 编辑请求最多携带的参考图数量（对齐 Codex MAX_EDIT_IMAGES） */
const MAX_EDIT_IMAGES = 5

// ===== 工具元数据 =====

export const GPT_IMAGE_TOOL_META: ChatToolMeta = {
  id: 'gpt-image',
  name: 'GPT Image',
  description: 'AI 图片生成与编辑（基于 OpenAI GPT Image，模型 gpt-image-2）',
  params: [
    { name: 'prompt', type: 'string', description: '图片生成/编辑描述', required: true },
  ],
  icon: 'ImagePlus',
  category: 'builtin',
  executorType: 'builtin',
  systemPromptAppend: `
<gpt_image_instructions>
你拥有基于 OpenAI GPT Image（gpt-image-2）的图片生成和编辑能力。

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
  const credentials = getToolCredentials('gpt-image')
  return !!credentials.apiKey
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
function collectReferenceImages(context: GptImageContext): ImagesApiImageUrl[] {
  const allAttachments: FileAttachment[] = [
    ...(context.previousUserAttachments ?? []),
    ...(context.previousAssistantAttachments ?? []),
    ...(context.currentAttachments ?? []),
  ]

  const images: ImagesApiImageUrl[] = []
  for (const attachment of allAttachments) {
    if (images.length >= MAX_EDIT_IMAGES) break
    if (!isImageAttachment(attachment.mediaType)) continue

    try {
      const base64 = readAttachmentAsBase64(attachment.localPath)
      images.push({
        image_url: `data:${attachment.mediaType};base64,${base64}`,
      })
    } catch (error) {
      console.warn(`[GPT Image] 读取参考图失败: ${attachment.localPath}`, error)
    }
  }

  return images
}

/**
 * 宽高比 → OpenAI size 映射。
 * gpt-image 支持 1024x1024 / 1536x1024 / 1024x1536 / auto；
 * 无法直接对应的比例交给服务端 auto 处理。
 */
function aspectRatioToSize(aspectRatio?: string): string | undefined {
  switch (aspectRatio) {
    case '1:1':
      return '1024x1024'
    case '16:9':
      return '1536x1024'
    case '9:16':
      return '1024x1536'
    default:
      return undefined
  }
}

/**
 * 构建 OpenAI Images API 请求体
 *
 * 导出的纯函数，便于单测验证与 Codex 对齐的请求形状。
 */
export function buildImagesRequest(
  prompt: string,
  referenceImages: ImagesApiImageUrl[],
  model: string,
  options: {
    size?: string
    numberOfImages: number
  },
): { path: string; body: Record<string, unknown> } {
  const size = options.size || 'auto'
  const n = options.numberOfImages

  // 带参考图 → 编辑端点；否则 → 文生图端点
  if (referenceImages.length > 0) {
    return {
      path: 'images/edits',
      body: {
        model,
        prompt,
        images: referenceImages,
        size,
        quality: 'auto',
        background: 'auto',
        n,
      },
    }
  }

  return {
    path: 'images/generations',
    body: {
      model,
      prompt,
      size,
      quality: 'auto',
      background: 'auto',
      n,
    },
  }
}

/**
 * 执行 GPT Image 工具调用
 */
export async function executeGptImageTool(
  toolCall: ToolCall,
  context: GptImageContext,
): Promise<ToolResult> {
  const credentials = getToolCredentials('gpt-image')

  if (!credentials.apiKey) {
    return {
      toolCallId: toolCall.id,
      content: 'GPT Image 未配置 API Key',
      isError: true,
    }
  }

  try {
    const prompt = toolCall.arguments.prompt as string
    const aspectRatio = toolCall.arguments.aspectRatio as string | undefined
    const size = (toolCall.arguments.size as string | undefined) || aspectRatioToSize(aspectRatio)
    const useReferenceImages = toolCall.arguments.useReferenceImages === 'true'
    const numberOfImages = typeof toolCall.arguments.numberOfImages === 'number'
      ? Math.min(Math.max(Math.round(toolCall.arguments.numberOfImages), 1), 4)
      : 1

    if (!prompt) {
      return {
        toolCallId: toolCall.id,
        content: '参数缺失: prompt',
        isError: true,
      }
    }

    const baseUrl = credentials.baseUrl?.trim() || DEFAULT_BASE_URL
    const model = credentials.model?.trim() || DEFAULT_MODEL

    // 收集参考图
    const referenceImages = useReferenceImages ? collectReferenceImages(context) : []

    // 构建请求
    const { path, body } = buildImagesRequest(prompt, referenceImages, model, {
      size,
      numberOfImages,
    })

    const url = `${baseUrl.replace(/\/+$/, '')}/${path}`

    console.log(`[GPT Image] 调用 Images API: ${path}, model=${model}, prompt="${prompt.slice(0, 50)}..."`)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`[GPT Image] API 请求失败 (${response.status}):`, errorText)
      return {
        toolCallId: toolCall.id,
        content: `Images API 请求失败 (${response.status}): ${errorText.slice(0, 200)}`,
        isError: true,
      }
    }

    const data = (await response.json()) as ImagesApiResponse

    if (data.error) {
      return {
        toolCallId: toolCall.id,
        content: `Images API 错误: ${data.error.message ?? data.error.code ?? '未知错误'}`,
        isError: true,
      }
    }

    const items = data.data ?? []
    if (items.length === 0) {
      return {
        toolCallId: toolCall.id,
        content: '未生成任何图片',
        isError: true,
      }
    }

    // 保存生成的图片为附件
    const generatedAttachments: FileAttachment[] = []
    for (const item of items) {
      if (item.b64_json) {
        const result = saveAttachment({
          conversationId: context.conversationId,
          filename: `gpt-image-${randomUUID().slice(0, 8)}.png`,
          mediaType: 'image/png',
          data: item.b64_json,
        })
        generatedAttachments.push(result.attachment)
      } else if (item.url) {
        // 兼容返回 URL 的端点：下载后保存
        const downloadResponse = await fetch(item.url)
        if (!downloadResponse.ok) {
          console.warn(`[GPT Image] 下载生成图失败 (${downloadResponse.status}): ${item.url}`)
          continue
        }
        const buffer = Buffer.from(await downloadResponse.arrayBuffer())
        const result = saveAttachment({
          conversationId: context.conversationId,
          filename: `gpt-image-${randomUUID().slice(0, 8)}.png`,
          mediaType: 'image/png',
          data: buffer.toString('base64'),
        })
        generatedAttachments.push(result.attachment)
      }
    }

    if (generatedAttachments.length === 0) {
      return {
        toolCallId: toolCall.id,
        content: '生成结果中缺少图片数据（b64_json / url 均为空）',
        isError: true,
      }
    }

    const imageCount = generatedAttachments.length
    const resultText = `图片已成功生成（${imageCount} 张）`

    return {
      toolCallId: toolCall.id,
      content: resultText,
      generatedAttachments,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(`[GPT Image] 执行失败:`, error)
    return {
      toolCallId: toolCall.id,
      content: `图片生成失败: ${msg}`,
      isError: true,
    }
  }
}

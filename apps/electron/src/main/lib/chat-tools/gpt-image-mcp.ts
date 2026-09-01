/**
 * GPT Image Agent 工具（Pi runtime）
 *
 * 基于 OpenAI Images API 的内置 Pi custom tool，模型 gpt-image-2。
 * 支持文生图与参考图编辑。凭据复用 chat-tools.json 配置。
 * 实现对齐 Codex 的 image_generation.imagegen 工具。
 */

import { randomUUID } from 'node:crypto'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { extname, resolve, isAbsolute, join } from 'node:path'
import { getToolCredentials } from '../chat-tool-config'
import { saveAttachment, isImageAttachment } from '../attachment-service'
import { buildPiGptImageTool } from './gpt-image-agent-tool'

// ===== 默认配置 =====

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MODEL = 'gpt-image-2'

/** 单次请求超时（生成型 API 较慢，放宽到 3 分钟） */
const REQUEST_TIMEOUT_MS = 180_000

/** 编辑请求最多携带的参考图数量（对齐 Codex MAX_EDIT_IMAGES） */
const MAX_EDIT_IMAGES = 5

// ===== MCP 内容块类型 =====

interface McpTextContent {
  type: 'text'
  text: string
  [key: string]: unknown
}

interface McpImageContent {
  type: 'image'
  data: string
  mimeType: string
  [key: string]: unknown
}

type McpContent = McpTextContent | McpImageContent

interface McpToolResult {
  content: McpContent[]
  [key: string]: unknown
}

// ===== OpenAI Images API 类型 =====

interface ImagesApiImageUrl {
  image_url: string
}

interface ImagesApiDataItem {
  b64_json?: string
  url?: string
}

interface ImagesApiResponse {
  created?: number
  data?: ImagesApiDataItem[]
  error?: { message?: string; code?: string }
}

// ===== 参考图读取 =====

/** 已知图片扩展名 → MIME 类型映射 */
const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/**
 * 从文件路径列表读取参考图，转换为 base64 data URL 列表
 *
 * 支持绝对路径和相对路径（相对于 cwd 解析）。
 * 跳过不存在、非图片、读取失败的文件，最多携带 MAX_EDIT_IMAGES 张。
 */
function readReferenceImages(paths: string[], cwd?: string): ImagesApiImageUrl[] {
  const images: ImagesApiImageUrl[] = []
  for (const rawPath of paths) {
    if (images.length >= MAX_EDIT_IMAGES) break
    try {
      // 相对路径 → 基于 cwd 解析为绝对路径
      const filePath = isAbsolute(rawPath) ? rawPath : resolve(cwd ?? process.cwd(), rawPath)

      if (!existsSync(filePath)) {
        console.warn(`[GPT Image MCP] 参考图不存在: ${filePath}`)
        continue
      }
      const ext = extname(filePath).toLowerCase()
      const mimeType = EXT_TO_MIME[ext]
      if (!mimeType || !isImageAttachment(mimeType)) {
        console.warn(`[GPT Image MCP] 非图片文件，跳过: ${filePath}`)
        continue
      }
      const data = readFileSync(filePath).toString('base64')
      images.push({ image_url: `data:${mimeType};base64,${data}` })
    } catch (error) {
      console.warn(`[GPT Image MCP] 读取参考图失败: ${rawPath}`, error)
    }
  }
  return images
}

// ===== Images API 调用 =====

/**
 * 构建 OpenAI Images API 请求（generations / edits）
 */
function buildImagesRequest(
  prompt: string,
  referenceImages: ImagesApiImageUrl[],
  model: string,
  options: { size?: string; numberOfImages?: number },
): { path: string; body: Record<string, unknown> } {
  const size = options.size || 'auto'
  const n = options.numberOfImages ?? 1

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
 * 调用 OpenAI Images API 并返回 MCP 工具结果
 */
async function callImagesApiAndBuildResult(
  prompt: string,
  sessionId: string,
  options: { size?: string; referenceImagePaths?: string[]; cwd?: string; numberOfImages?: number; outputMode?: 'session' | 'workspace' },
): Promise<McpToolResult> {
  const credentials = getToolCredentials('gpt-image')
  const baseUrl = credentials.baseUrl?.trim() || DEFAULT_BASE_URL
  const model = credentials.model?.trim() || DEFAULT_MODEL

  // 读取参考图
  const referenceImagePaths = options.referenceImagePaths ?? []
  const referenceImages = referenceImagePaths.length > 0
    ? readReferenceImages(referenceImagePaths, options.cwd)
    : []
  if (referenceImagePaths.length > 0 && referenceImages.length === 0) {
    throw new Error('未能读取任何参考图；请检查文件是否存在且为受支持的图片格式')
  }
  if (referenceImages.length > 0) {
    console.log(`[GPT Image MCP] 加载了 ${referenceImages.length} 张参考图`)
  }

  // 构建请求
  const { path, body } = buildImagesRequest(prompt, referenceImages, model, {
    size: options.size,
    numberOfImages: options.numberOfImages,
  })
  const url = `${baseUrl.replace(/\/+$/, '')}/${path}`

  console.log(`[GPT Image MCP] 调用 Images API: ${path}, model=${model}, prompt="${prompt.slice(0, 50)}..."`)

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
    console.error(`[GPT Image MCP] API 请求失败 (${response.status}):`, errorText)
    return {
      content: [{ type: 'text' as const, text: `Images API 请求失败 (${response.status}): ${errorText.slice(0, 200)}` }],
    }
  }

  const data = (await response.json()) as ImagesApiResponse

  if (data.error) {
    return {
      content: [{ type: 'text' as const, text: `Images API 错误: ${data.error.message ?? data.error.code ?? '未知错误'}` }],
    }
  }

  const items = data.data ?? []
  if (items.length === 0) {
    return {
      content: [{ type: 'text' as const, text: '未生成任何图片' }],
    }
  }

  const mcpContent: McpContent[] = []
  const savedWorkspacePaths: string[] = []
  let savedCount = 0

  // 解析响应：提取图片
  for (const item of items) {
    let base64: string | null = null

    if (item.b64_json) {
      base64 = item.b64_json
    } else if (item.url) {
      // 兼容返回 URL 的端点：下载后转 base64
      try {
        const downloadResponse = await fetch(item.url)
        if (downloadResponse.ok) {
          const buffer = Buffer.from(await downloadResponse.arrayBuffer())
          base64 = buffer.toString('base64')
        } else {
          console.warn(`[GPT Image MCP] 下载生成图失败 (${downloadResponse.status}): ${item.url}`)
        }
      } catch (error) {
        console.warn(`[GPT Image MCP] 下载生成图失败: ${item.url}`, error)
      }
    }

    if (!base64) continue

    const filename = `gpt-image-${randomUUID().slice(0, 8)}.png`

    // 保存图片到附件目录（供 UI 渲染）
    const result = saveAttachment({
      conversationId: sessionId,
      filename,
      mediaType: 'image/png',
      data: base64,
    })

    // 只有显式请求工作区输出时才创建项目文件；失败必须让整次工具调用失败。
    if (options.outputMode === 'workspace') {
      if (!options.cwd) throw new Error('当前会话没有可写入的 Session Target，无法保存工作区图片')
      const imgDir = join(options.cwd, 'generated-images')
      mkdirSync(imgDir, { recursive: true })
      const workspacePath = join(imgDir, filename)
      writeFileSync(workspacePath, Buffer.from(base64, 'base64'))
      savedWorkspacePaths.push(workspacePath)
    }

    // MCP image content block（供 SDK/模型查看）
    mcpContent.push({
      type: 'image' as const,
      data: base64,
      mimeType: 'image/png',
    })

    // 嵌入附件标记（供前端 UI 解析渲染）
    const attachmentMeta = JSON.stringify({
      localPath: result.attachment.localPath,
      filename: result.attachment.filename,
      mediaType: result.attachment.mediaType,
    })
    mcpContent.push({ type: 'text' as const, text: `[DOMI_IMAGE_ATTACHMENT:${attachmentMeta}]` })

    savedCount++
  }

  if (savedCount === 0) {
    throw new Error('生成结果中缺少图片数据（b64_json / url 均为空）')
  }

  // 追加文本摘要
  const pathInfo = savedWorkspacePaths.length > 0
    ? `\n图片已保存到工作目录:\n${savedWorkspacePaths.map((p) => `- ${p}`).join('\n')}`
    : ''
  mcpContent.push({
    type: 'text' as const,
    text: `图片已生成（${savedCount} 张）${pathInfo}`,
  })

  return {
    content: mcpContent,
    outputMode: options.outputMode ?? 'session',
    workspacePaths: savedWorkspacePaths,
  }
}

// ===== Pi custom tool =====

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

/** 构建 GPT Image Pi custom tool；缺凭据时返回空数组。 */
export function buildPiGptImageTools(
  sdk: PiSdk,
  sessionId: string,
  agentCwd?: string,
): ToolDefinition[] {
  const credentials = getToolCredentials('gpt-image')
  if (!credentials.apiKey) return []
  return [buildPiGptImageTool(sdk, sessionId, agentCwd, callImagesApiAndBuildResult)]
}

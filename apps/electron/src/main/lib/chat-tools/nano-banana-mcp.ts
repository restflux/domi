/**
 * Nano Banana Agent 工具（Pi runtime）
 *
 * 基于 Gemini Image Generation API 的内置 Pi custom tool。
 * 支持文生图、多轮连续修改。凭据复用 chat-tools.json 配置。
 */

import { randomUUID } from 'node:crypto'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { extname, resolve, isAbsolute, join } from 'node:path'
import { getToolCredentials } from '../chat-tool-config'
import { saveAttachment, isImageAttachment } from '../attachment-service'
import { buildPiNanoBananaTool } from './nano-banana-agent-tool'

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

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

interface GeminiCandidate {
  content: {
    parts: GeminiPart[]
    role: string
  }
}

interface GeminiResponse {
  candidates?: GeminiCandidate[]
  error?: { message: string; code: number }
}

// ===== 多轮对话历史（按 sessionId 隔离） =====

const sessionHistory = new Map<string, GeminiContent[]>()

// ===== 默认配置 =====

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com'
const DEFAULT_MODEL = 'gemini-3.1-flash-image-preview'

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

// ===== Gemini API 调用 =====

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
 * 从文件路径列表读取参考图，转换为 GeminiPart[]
 *
 * 支持绝对路径和相对路径（相对于 cwd 解析）。
 * 跳过不存在、非图片、读取失败的文件。
 */
function readReferenceImages(paths: string[], cwd?: string): GeminiPart[] {
  const parts: GeminiPart[] = []
  for (const rawPath of paths) {
    try {
      // 相对路径 → 基于 cwd 解析为绝对路径
      const filePath = isAbsolute(rawPath) ? rawPath : resolve(cwd ?? process.cwd(), rawPath)

      if (!existsSync(filePath)) {
        console.warn(`[Nano Banana MCP] 参考图不存在: ${filePath}`)
        continue
      }
      const ext = extname(filePath).toLowerCase()
      const mimeType = EXT_TO_MIME[ext]
      if (!mimeType || !isImageAttachment(mimeType)) {
        console.warn(`[Nano Banana MCP] 非图片文件，跳过: ${filePath}`)
        continue
      }
      const data = readFileSync(filePath).toString('base64')
      parts.push({ inlineData: { mimeType, data } })
    } catch (error) {
      console.warn(`[Nano Banana MCP] 读取参考图失败: ${rawPath}`, error)
    }
  }
  return parts
}

/**
 * Gemini 多轮对话中，模型响应包含 thoughtSignature 后，
 * 后续所有 user 消息的 text part 也必须携带 thoughtSignature。
 * 使用 Gemini 官方提供的跳过验证占位符。
 * @see https://ai.google.dev/gemini-api/docs/thought-signatures
 */
const DUMMY_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

/** 检查对话历史中是否存在 thoughtSignature */
function historyHasThoughtSignature(history: GeminiContent[]): boolean {
  return history.some((c) =>
    c.parts.some((p) => p.thoughtSignature || p.thought_signature),
  )
}

/**
 * 构建 Gemini API 请求体
 */
function buildGeminiRequest(
  prompt: string,
  referenceImageParts: GeminiPart[],
  history: GeminiContent[],
  options: { aspectRatio?: string; imageSize?: string; numberOfImages?: number },
): Record<string, unknown> {
  // 多轮对话中 model 响应含 thoughtSignature 时，新 user 的 text part 也必须带签名
  const needsSignature = history.length > 0 && historyHasThoughtSignature(history)

  const userParts: GeminiPart[] = [
    ...referenceImageParts,
    {
      text: prompt,
      ...(needsSignature && { thoughtSignature: DUMMY_THOUGHT_SIGNATURE }),
    },
  ]

  const contents: GeminiContent[] = [
    ...history,
    { role: 'user', parts: userParts },
  ]

  const generationConfig: Record<string, unknown> = {
    responseModalities: ['TEXT', 'IMAGE'],
  }

  const imageConfig: Record<string, unknown> = {}
  if (options.aspectRatio && options.aspectRatio !== '1:1') {
    imageConfig.aspectRatio = options.aspectRatio
  }
  if (options.imageSize && options.imageSize !== 'auto') {
    imageConfig.imageSize = options.imageSize
  }
  // NOTE: numberOfImages is kept in schema for future API support but not forwarded.
  if (Object.keys(imageConfig).length > 0) {
    generationConfig.imageConfig = imageConfig
  }

  return { contents, generationConfig }
}

/**
 * 调用 Gemini Image Generation API 并返回 MCP 工具结果
 */
async function callGeminiAndBuildResult(
  prompt: string,
  sessionId: string,
  options: { aspectRatio?: string; imageSize?: string; referenceImagePaths?: string[]; cwd?: string; numberOfImages?: number; outputMode?: 'session' | 'workspace' },
): Promise<McpToolResult> {
  const credentials = getToolCredentials('nano-banana')
  const baseUrl = credentials.baseUrl?.trim() || DEFAULT_BASE_URL
  const model = credentials.model?.trim() || DEFAULT_MODEL

  // 获取会话历史
  const history = sessionHistory.get(sessionId) ?? []

  // 读取参考图
  const referenceImagePaths = options.referenceImagePaths ?? []
  const referenceImageParts = referenceImagePaths.length > 0
    ? readReferenceImages(referenceImagePaths, options.cwd)
    : []
  if (referenceImagePaths.length > 0 && referenceImageParts.length === 0) {
    throw new Error('未能读取任何参考图；请检查文件是否存在且为受支持的图片格式')
  }
  if (referenceImageParts.length > 0) {
    console.log(`[Nano Banana MCP] 加载了 ${referenceImageParts.length} 张参考图`)
  }

  // 构建请求
  const requestBody = buildGeminiRequest(prompt, referenceImageParts, history, {
    aspectRatio: options.aspectRatio,
    imageSize: options.imageSize,
    numberOfImages: options.numberOfImages,
  })
  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${credentials.apiKey}`

  console.log(`[Nano Banana MCP] 调用 Gemini API: model=${model}, prompt="${prompt.slice(0, 50)}..."`)

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error(`[Nano Banana MCP] API 请求失败 (${response.status}):`, errorText)
    return {
      content: [{ type: 'text' as const, text: `Gemini API 请求失败 (${response.status}): ${errorText.slice(0, 200)}` }],
    }
  }

  const data = (await response.json()) as GeminiResponse

  if (data.error) {
    return {
      content: [{ type: 'text' as const, text: `Gemini API 错误: ${data.error.message}` }],
    }
  }

  if (!data.candidates || data.candidates.length === 0) {
    return {
      content: [{ type: 'text' as const, text: '未生成任何内容' }],
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- candidates[0] 已通过上方 length 检查
  const parts = data.candidates![0]!.content.parts
  console.log(`[Nano Banana MCP] 响应包含 ${parts.length} 个 parts，类型:`,
    parts.map((p) => p.inlineData ? `image(${p.inlineData.mimeType})` : `text(${(p.text ?? '').slice(0, 30)})`))

  const mcpContent: McpContent[] = []
  const textParts: string[] = []
  const savedWorkspacePaths: string[] = []

  // 解析响应：提取图片和文本（跳过 thought parts，它们是推理过程图，不作为输出）
  for (const part of parts) {
    if (part.thought) continue
    if (part.inlineData) {
      // 保存图片到附件目录（供 UI 渲染）
      const ext = part.inlineData.mimeType === 'image/jpeg' ? '.jpg' : '.png'
      const filename = `nano-banana-${randomUUID().slice(0, 8)}${ext}`
      const result = saveAttachment({
        conversationId: sessionId,
        filename,
        mediaType: part.inlineData.mimeType,
        data: part.inlineData.data,
      })

      // 只有显式请求工作区输出时才创建项目文件；失败必须让整次工具调用失败。
      if (options.outputMode === 'workspace') {
        if (!options.cwd) throw new Error('当前会话没有可写入的 Session Target，无法保存工作区图片')
        const imgDir = join(options.cwd, 'generated-images')
        mkdirSync(imgDir, { recursive: true })
        const workspacePath = join(imgDir, filename)
        writeFileSync(workspacePath, Buffer.from(part.inlineData.data, 'base64'))
        savedWorkspacePaths.push(workspacePath)
      }

      // MCP image content block（供 SDK/模型查看）
      mcpContent.push({
        type: 'image' as const,
        data: part.inlineData.data,
        mimeType: part.inlineData.mimeType,
      })

      // 嵌入附件标记（供前端 UI 解析渲染）
      const attachmentMeta = JSON.stringify({
        localPath: result.attachment.localPath,
        filename: result.attachment.filename,
        mediaType: result.attachment.mediaType,
      })
      textParts.push(`[DOMI_IMAGE_ATTACHMENT:${attachmentMeta}]`)
    } else if (part.text) {
      textParts.push(part.text)
    }
  }

  // 更新会话历史（保留原始 parts 含 thoughtSignature，多轮编辑必需）
  const userContent: GeminiContent = { role: 'user', parts: [...referenceImageParts, { text: prompt }] }
  const modelContent: GeminiContent = { role: 'model', parts }
  const updatedHistory = [...history, userContent, modelContent]
  sessionHistory.set(sessionId, updatedHistory)

  // 在图片内容块之后追加文本摘要
  const imageCount = mcpContent.filter((c) => c.type === 'image').length
  const pathInfo = savedWorkspacePaths.length > 0
    ? `\n图片已保存到工作目录:\n${savedWorkspacePaths.map((p) => `- ${p}`).join('\n')}`
    : ''
  if (imageCount === 0) {
    throw new Error(textParts.join('\n') || '未生成图片内容')
  }

  const summaryText = `图片已生成（${imageCount} 张）${pathInfo}\n${textParts.join('\n')}`
  mcpContent.push({ type: 'text' as const, text: summaryText })

  return {
    content: mcpContent,
    outputMode: options.outputMode ?? 'session',
    workspacePaths: savedWorkspacePaths,
  }
}

// ===== Pi custom tool =====

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

/** 构建 Nano Banana Pi custom tool；缺凭据时返回空数组。 */
export function buildPiNanoBananaTools(
  sdk: PiSdk,
  sessionId: string,
  agentCwd?: string,
): ToolDefinition[] {
  const credentials = getToolCredentials('nano-banana')
  if (!credentials.apiKey) return []
  return [buildPiNanoBananaTool(sdk, sessionId, agentCwd, callGeminiAndBuildResult)]
}

// ===== 清理 =====

/**
 * 清除 Agent 会话的生图历史（会话删除时调用）
 */
export function clearNanoBananaAgentHistory(sessionId: string): void {
  sessionHistory.delete(sessionId)
}

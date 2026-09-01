import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

export interface GptImageTextContent {
  type: 'text'
  text: string
  [key: string]: unknown
}

export interface GptImageImageContent {
  type: 'image'
  data: string
  mimeType: string
  [key: string]: unknown
}

export interface GptImageToolResult {
  content: Array<GptImageTextContent | GptImageImageContent>
  [key: string]: unknown
}

export interface GptImageToolDetails {
  imageCount: number
  textCount: number
  outputMode: GptImageOutputMode
  error?: string
  [key: string]: unknown
}

export type GptImageOutputMode = 'session' | 'workspace'

export interface GptImageGenerateOptions {
  size?: string
  referenceImagePaths?: string[]
  cwd?: string
  numberOfImages?: number
  outputMode?: GptImageOutputMode
}

export type GptImageGenerate = (
  prompt: string,
  sessionId: string,
  options: GptImageGenerateOptions,
) => Promise<GptImageToolResult>

/** 将 GPT Image 生图业务函数桥接为 Pi custom tool。 */
export function buildPiGptImageTool(
  sdk: PiSdk,
  sessionId: string,
  agentCwd: string | undefined,
  generate: GptImageGenerate,
): ToolDefinition {
  return sdk.defineTool({
    name: 'mcp__gpt_image__imagegen',
    label: 'GPT Image 生图',
    description: 'Generate or edit images using OpenAI GPT Image (gpt-image-2). Use this tool whenever the user asks to create, regenerate, redraw, or edit an image. Supports reference images via local paths.',
    promptSnippet: 'GPT Image: for an explicit image generation or editing request, call mcp__gpt_image__imagegen directly. Do not stop after merely planning the image call. Default outputMode to session so the result stays in conversation attachments and remains usable in Research or delivered follow-ups. Use workspace only when the user explicitly needs a project file. Do not claim completion unless the tool returns at least one image and isError is not true.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Detailed description of the image to generate or edit.' }),
      referenceImagePaths: Type.Optional(Type.Array(Type.String(), { description: 'Absolute or cwd-relative image paths used as editing references.' })),
      size: Type.Optional(Type.Union([
        Type.Literal('auto'), Type.Literal('1024x1024'), Type.Literal('1536x1024'), Type.Literal('1024x1536'),
      ])),
      numberOfImages: Type.Optional(Type.Number({ minimum: 1, maximum: 4 })),
      outputMode: Type.Optional(Type.Union([
        Type.Literal('session'), Type.Literal('workspace'),
      ], { description: 'session saves only to conversation attachments (default); workspace also saves under generated-images in the current Session Target.' })),
    }),
    async execute(_toolCallId, params) {
      const args = params as {
        prompt: string
        referenceImagePaths?: string[]
        size?: string
        numberOfImages?: number
        outputMode?: GptImageOutputMode
      }
      const outputMode = args.outputMode ?? 'session'
      try {
        if (outputMode === 'workspace' && !agentCwd) {
          throw new Error('当前会话没有可写入的 Session Target，无法保存工作区图片')
        }
        const result = await generate(args.prompt, sessionId, {
          size: args.size,
          referenceImagePaths: args.referenceImagePaths,
          ...(agentCwd ? { cwd: agentCwd } : {}),
          numberOfImages: args.numberOfImages,
          outputMode,
        })
        const { content, ...metadata } = result
        const imageCount = content.filter((block) => block.type === 'image').length
        const textCount = content.filter((block) => block.type === 'text').length
        if (imageCount === 0) {
          const message = content
            .filter((block): block is GptImageTextContent => block.type === 'text')
            .map((block) => block.text.trim())
            .filter(Boolean)
            .join('\n') || '生成结果中没有图片'
          throw new Error(message)
        }
        const details: GptImageToolDetails = {
          ...metadata,
          imageCount,
          textCount,
          outputMode,
        }
        // 图片 content 会由 Pi 统一缩放后进入 transcript；details 不再复制原始
        // Base64，避免多图在会话持久化和 IPC 中占用双份空间。
        return { content, details } as AgentToolResult<GptImageToolDetails>
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error('[GPT Image Pi] 执行失败:', error)
        throw new Error(`图片生成失败: ${msg}`, { cause: error })
      }
    },
  })
}

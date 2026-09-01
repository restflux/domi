import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

export interface NanoBananaTextContent {
  type: 'text'
  text: string
  [key: string]: unknown
}

export interface NanoBananaImageContent {
  type: 'image'
  data: string
  mimeType: string
  [key: string]: unknown
}

export interface NanoBananaToolResult {
  content: Array<NanoBananaTextContent | NanoBananaImageContent>
  [key: string]: unknown
}

export type NanoBananaOutputMode = 'session' | 'workspace'

export interface NanoBananaToolDetails {
  imageCount: number
  textCount: number
  outputMode: NanoBananaOutputMode
  error?: string
  [key: string]: unknown
}

export interface NanoBananaGenerateOptions {
  aspectRatio?: string
  imageSize?: string
  referenceImagePaths?: string[]
  cwd?: string
  numberOfImages?: number
  outputMode?: NanoBananaOutputMode
}

export type NanoBananaGenerate = (
  prompt: string,
  sessionId: string,
  options: NanoBananaGenerateOptions,
) => Promise<NanoBananaToolResult>

/** 将 Nano Banana 生图业务函数桥接为 Pi custom tool。 */
export function buildPiNanoBananaTool(
  sdk: PiSdk,
  sessionId: string,
  agentCwd: string | undefined,
  generate: NanoBananaGenerate,
): ToolDefinition {
  return sdk.defineTool({
    name: 'mcp__nano_banana__generate_image',
    label: 'Nano Banana 生图',
    description: 'Generate or edit images using Gemini Image Generation. Use this tool whenever the user asks to create, regenerate, redraw, or edit an image. Supports reference images and iterative multi-turn editing.',
    promptSnippet: 'Nano Banana: for an explicit image generation or editing request, call mcp__nano_banana__generate_image directly. Do not stop after merely planning the image call. Default outputMode to session so the result stays in conversation attachments and remains usable in Research or delivered follow-ups. Use workspace only when the user explicitly needs a project file. Do not claim completion unless the tool returns at least one image and isError is not true.',
    parameters: Type.Object({
      prompt: Type.String({ description: 'Detailed description of the image to generate or edit. English works best.' }),
      referenceImagePaths: Type.Optional(Type.Array(Type.String(), { description: 'Absolute or cwd-relative image paths used as editing references.' })),
      aspectRatio: Type.Optional(Type.Union([
        Type.Literal('1:1'), Type.Literal('16:9'), Type.Literal('4:3'), Type.Literal('9:16'), Type.Literal('3:4'),
      ])),
      imageSize: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('1K'), Type.Literal('2K'), Type.Literal('4K')])),
      numberOfImages: Type.Optional(Type.Number({ minimum: 1, maximum: 4 })),
      outputMode: Type.Optional(Type.Union([
        Type.Literal('session'), Type.Literal('workspace'),
      ], { description: 'session saves only to conversation attachments (default); workspace also saves under generated-images in the current Session Target.' })),
    }),
    async execute(_toolCallId, params) {
      const args = params as {
        prompt: string
        referenceImagePaths?: string[]
        aspectRatio?: string
        imageSize?: string
        numberOfImages?: number
        outputMode?: NanoBananaOutputMode
      }
      const outputMode = args.outputMode ?? 'session'
      try {
        if (outputMode === 'workspace' && !agentCwd) {
          throw new Error('当前会话没有可写入的 Session Target，无法保存工作区图片')
        }
        const result = await generate(args.prompt, sessionId, {
          aspectRatio: args.aspectRatio,
          imageSize: args.imageSize,
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
            .filter((block): block is NanoBananaTextContent => block.type === 'text')
            .map((block) => block.text.trim())
            .filter(Boolean)
            .join('\n') || '生成结果中没有图片'
          throw new Error(message)
        }
        const details: NanoBananaToolDetails = {
          ...metadata,
          imageCount,
          textCount,
          outputMode,
        }
        // 图片 content 会由 Pi 统一缩放后进入 transcript；details 不再复制原始
        // Base64，避免 4K 多图在会话持久化和 IPC 中占用双份空间。
        return { content, details } as AgentToolResult<NanoBananaToolDetails>
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error('[Nano Banana Pi] 执行失败:', error)
        throw new Error(`图片生成失败: ${msg}`, { cause: error })
      }
    },
  })
}

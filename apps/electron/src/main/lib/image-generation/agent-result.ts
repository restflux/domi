import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join, resolve } from 'node:path'
import type { ImageGenerationSelection } from '@domi/shared'
import { saveAttachment, isImageAttachment } from '../attachment-service'
import { resolveImageGenerationConfig } from './config'
import type { ImageGenerationConfig, ImageGenerationToolId } from './config-core'
import { generateImages, type GeneratedImage, type GenerationOptions } from './service'

interface AgentGenerateOptions extends GenerationOptions {
  referenceImagePaths?: string[]
  cwd?: string
  outputMode?: 'session' | 'workspace'
}
interface TextContent { type: 'text'; text: string; [key: string]: unknown }
interface ImageContent { type: 'image'; data: string; mimeType: string; [key: string]: unknown }
interface AgentImageResult { content: Array<TextContent | ImageContent>; [key: string]: unknown }
const MIME_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' }

/** 路径授权仍由 Pi final tool guard 执行；这里只保留原有的格式校验和附件落盘。 */
export async function generateAgentImages(toolId: ImageGenerationToolId, selection: ImageGenerationSelection | undefined,
  prompt: string, sessionId: string, options: AgentGenerateOptions, legacyConfig?: ImageGenerationConfig,
): Promise<AgentImageResult> {
  if (options.outputMode === 'workspace' && !options.cwd) throw new Error('当前会话没有可写入的 Session Target，无法保存工作区图片')
  const config = legacyConfig ?? resolveImageGenerationConfig(toolId, selection)
  const references: GeneratedImage[] = []
  for (const rawPath of options.referenceImagePaths ?? []) {
    if (toolId === 'gpt-image' && references.length >= 5) break
    const filePath = isAbsolute(rawPath) ? rawPath : resolve(options.cwd ?? process.cwd(), rawPath)
    const mimeType = MIME_TYPES[extname(filePath).toLowerCase()]
    if (!existsSync(filePath) || !mimeType || !isImageAttachment(mimeType)) continue
    try { references.push({ data: readFileSync(filePath).toString('base64'), mimeType }) } catch { /* 无法读取的参考图延续原有跳过行为。 */ }
  }
  if (options.referenceImagePaths?.length && !references.length) throw new Error('未能读取任何参考图；请检查文件是否存在且为受支持的图片格式')
  const result = await generateImages(config, prompt, sessionId, references, options)
  options.signal?.throwIfAborted()
  const content: Array<TextContent | ImageContent> = []
  const workspacePaths: string[] = []
  const attachmentMarkers: string[] = []
  for (const image of result.images) {
    const filename = `${toolId}-${randomUUID().slice(0, 8)}${image.mimeType === 'image/jpeg' ? '.jpg' : '.png'}`
    const saved = saveAttachment({ conversationId: sessionId, filename, mediaType: image.mimeType, data: image.data })
    if (options.outputMode === 'workspace') {
      const directory = join(options.cwd!, 'generated-images')
      mkdirSync(directory, { recursive: true })
      const path = join(directory, filename)
      writeFileSync(path, Buffer.from(image.data, 'base64'))
      workspacePaths.push(path)
    }
    content.push({ type: 'image', ...image })
    attachmentMarkers.push(`[DOMI_IMAGE_ATTACHMENT:${JSON.stringify({ localPath: saved.attachment.localPath, filename: saved.attachment.filename, mediaType: saved.attachment.mediaType })}]`)
  }
  const parameterInfo = [result.metadata.model, result.metadata.size, result.metadata.quality, result.metadata.aspectRatio, result.metadata.imageSize].filter((value) => value && value !== 'auto').join(' · ')
  const pathInfo = workspacePaths.length ? `\n图片已保存到工作目录:\n${workspacePaths.map((path) => `- ${path}`).join('\n')}` : ''
  content.push({ type: 'text', text: `图片已生成（${result.images.length} 张） · ${parameterInfo}${pathInfo}\n${[...result.text, ...attachmentMarkers].join('\n')}` })
  options.run?.acknowledgeResult()
  return { content, ...result.metadata, outputMode: options.outputMode ?? 'session', workspacePaths }
}

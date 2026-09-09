import type { ImageGenerationQuality } from '@domi/shared'
import type { ImageGenerationConfig } from './config-core'

export interface GeneratedImage { data: string; mimeType: string }
export interface GeminiPart {
  text?: string
  inlineData?: GeneratedImage
  thought?: boolean
  thoughtSignature?: string
  thought_signature?: string
  [key: string]: unknown
}
export interface GeminiContent { role: 'user' | 'model'; parts: GeminiPart[] }
export interface GenerationOptions {
  size?: string
  aspectRatio?: string
  imageSize?: string
  numberOfImages?: number
  signal?: AbortSignal
}
export interface GenerationMetadata {
  model: string
  channelId?: string
  protocol: ImageGenerationConfig['protocol']
  size?: string
  quality?: ImageGenerationQuality
  aspectRatio?: string
  imageSize?: string
  numberOfImages: number
}
export interface GenerationResult { images: GeneratedImage[]; text: string[]; metadata: GenerationMetadata }
interface ImagesResponse { data?: Array<{ b64_json?: string; url?: string }>; error?: unknown }
interface GeminiResponse { candidates?: Array<{ content?: { parts?: GeminiPart[] } }>; error?: unknown }
const history = new Map<string, GeminiContent[]>()

export function clearImageGenerationHistory(sessionId: string): void {
  for (const key of history.keys()) if (JSON.parse(key)[0] === sessionId) history.delete(key)
}

export function buildImagesRequest(prompt: string, references: Array<{ image_url: string }>, model: string,
  options: { size?: string; quality?: ImageGenerationQuality; numberOfImages?: number },
): { path: string; body: Record<string, unknown> } {
  return {
    path: references.length ? 'images/edits' : 'images/generations',
    body: { model, prompt, ...(references.length ? { images: references } : {}), size: options.size || 'auto',
      quality: options.quality ?? 'auto', background: 'auto', n: options.numberOfImages ?? 1 },
  }
}

/** HTTP 错误不回显响应正文，兼容服务可能在正文中反射 Authorization。 */
async function requestJson<T>(url: string, body: Record<string, unknown>, headers: Record<string, string>, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal })
  if (!response.ok) throw new Error(`生图 API 请求失败 (${response.status})`)
  try {
    return await response.json() as T
  } catch {
    signal.throwIfAborted()
    throw new Error('生图 API 返回无效 JSON')
  }
}

function sizeForAspectRatio(ratio?: string): string | undefined {
  if (ratio === '1:1') return '1024x1024'
  if (ratio === '16:9' || ratio === '3:2') return '1536x1024'
  if (ratio === '9:16' || ratio === '2:3') return '1024x1536'
  return undefined
}

/** Chat 和 Work 共享唯一请求链；选定参数优先于模型给出的普通工具参数。 */
export async function generateImages(config: ImageGenerationConfig, prompt: string, sessionId: string,
  references: GeneratedImage[], options: GenerationOptions = {},
): Promise<GenerationResult> {
  if (!prompt.trim()) throw new Error('参数缺失: prompt')
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000)
  signal.throwIfAborted()
  const numberOfImages = config.numberOfImages ?? options.numberOfImages ?? 1
  if (!Number.isInteger(numberOfImages) || numberOfImages < 1 || numberOfImages > 4) throw new Error('生图数量必须为 1–4 的整数')
  const metadata: GenerationMetadata = { model: config.model, ...(config.channelId ? { channelId: config.channelId } : {}), protocol: config.protocol, numberOfImages }
  const images: GeneratedImage[] = []
  const text: string[] = []
  if (config.protocol === 'openai-images') {
    const size = config.size ?? sizeForAspectRatio(config.aspectRatio) ?? options.size ?? sizeForAspectRatio(options.aspectRatio) ?? 'auto'
    if (!['auto', '1024x1024', '1536x1024', '1024x1536'].includes(size)) throw new Error('不支持的生图尺寸')
    metadata.size = size
    metadata.quality = config.quality ?? 'auto'
    const request = buildImagesRequest(prompt, references.map((image) => ({ image_url: `data:${image.mimeType};base64,${image.data}` })), config.model, { size, quality: metadata.quality, numberOfImages })
    const data = await requestJson<ImagesResponse>(`${config.baseUrl.replace(/\/+$/, '')}/${request.path}`, request.body, { Authorization: `Bearer ${config.apiKey}` }, signal)
    if (data.error) throw new Error('Images API 返回错误')
    for (const item of data.data ?? []) {
      if (item.b64_json) images.push({ data: item.b64_json, mimeType: 'image/png' })
      else if (item.url) {
        const url = new URL(item.url)
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('生成图片下载地址无效')
        const response = await fetch(url.toString(), { signal })
        if (!response.ok) throw new Error(`生成图片下载失败 (${response.status})`)
        images.push({ data: Buffer.from(await response.arrayBuffer()).toString('base64'), mimeType: 'image/png' })
      }
    }
  } else {
    const aspectRatio = config.aspectRatio ?? options.aspectRatio ?? 'auto'
    const imageSize = config.imageSize ?? options.imageSize ?? 'auto'
    if (!['auto', '1:1', '16:9', '9:16', '3:2', '2:3', '4:3', '3:4'].includes(aspectRatio)) throw new Error('不支持的生图比例')
    if (!['auto', '1K', '2K', '4K'].includes(imageSize)) throw new Error('不支持的图片清晰度')
    metadata.aspectRatio = aspectRatio
    metadata.imageSize = imageSize
    const imageConfig = { ...(aspectRatio !== 'auto' ? { aspectRatio } : {}), ...(imageSize !== 'auto' ? { imageSize } : {}) }
    const key = JSON.stringify([sessionId, config.channelId ?? 'legacy', config.model, config.baseUrl])
    const previous = history.get(key) ?? []
    const user: GeminiContent = { role: 'user', parts: [...references.map((image) => ({ inlineData: image })), { text: prompt }] }
    const next: GeminiContent[] = [...previous]
    const root = config.baseUrl.replace(/\/+$/, '').replace(/\/v1beta$/, '')
    // Gemini 单请求没有图片数量参数；明确请求多张时逐次调用，失败不写入编辑历史。
    for (let index = 0; index < numberOfImages; index++) {
      const data = await requestJson<GeminiResponse>(`${root}/v1beta/models/${encodeURIComponent(config.model)}:generateContent`, {
        contents: [...previous, user], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], ...(Object.keys(imageConfig).length ? { imageConfig } : {}) },
      }, { 'x-goog-api-key': config.apiKey }, signal)
      if (data.error) throw new Error('Gemini API 返回错误')
      const parts = data.candidates?.[0]?.content?.parts ?? []
      const generated = parts.filter((part) => !part.thought && part.inlineData?.data).map((part) => part.inlineData!)
      if (!generated.length) throw new Error('未生成图片内容')
      images.push(...generated)
      text.push(...parts.filter((part) => !part.thought && part.text).map((part) => part.text!))
      // 原样保留所有 parts、签名和未知字段，不能重建模型响应。
      next.push(user, { role: 'model', parts })
    }
    signal.throwIfAborted()
    history.set(key, next)
  }
  if (!images.length) throw new Error('未生成任何图片')
  signal.throwIfAborted()
  return { images, text, metadata }
}

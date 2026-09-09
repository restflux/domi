/** 生图连接协议独立于主对话协议。 */
export type ImageGenerationProtocol = 'openai-images' | 'gemini'
export type ImageGenerationQuality = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 渠道中的显式生图能力；不保存额外凭据。 */
export interface ImageGenerationChannelConfig {
  protocol: ImageGenerationProtocol
  /** 留空时复用渠道根地址，不允许完整聊天请求地址。 */
  baseUrl?: string
  models: string[]
}

/** 可持久化的用户选择，绝不包含 Key。 */
export interface ImageGenerationSelection {
  channelId: string
  /** 主进程固定的渠道配置版本，改变连接后旧请求需重新确认。 */
  channelUpdatedAt?: number
  modelId: string
  size?: 'auto' | '1024x1024' | '1536x1024' | '1024x1536'
  quality?: ImageGenerationQuality
  aspectRatio?: 'auto' | '1:1' | '16:9' | '9:16' | '3:2' | '2:3'
  imageSize?: 'auto' | '1K' | '2K' | '4K'
  numberOfImages?: number
}

export const IMAGE_GENERATION_PRESETS: Record<ImageGenerationProtocol, readonly string[]> = {
  'openai-images': ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2'],
  gemini: ['gemini-3.1-flash-image', 'gemini-3-pro-image-preview'],
}

export function getImageGenerationQualities(modelId: string): readonly ImageGenerationQuality[] {
  if (/^gpt-image-2\.5-(flare|sunburst)(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)) {
    return ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
  }
  return /^gpt-image-(?:1(?:\.5|-mini)?|2)(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId)
    ? ['auto', 'low', 'medium', 'high']
    : ['auto']
}

/** 成功结果的实际参数，不含连接地址或凭据。 */
export interface ImageGenerationResultMetadata {
  model: string
  channelId?: string
  protocol: ImageGenerationProtocol
  size?: string
  quality?: ImageGenerationQuality
  aspectRatio?: string
  imageSize?: string
  numberOfImages: number
}

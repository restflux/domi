import { getImageGenerationQualities } from '@domi/shared'
import type { Channel, ImageGenerationChannelConfig, ImageGenerationProtocol, ImageGenerationSelection } from '@domi/shared'

export type ImageGenerationToolId = 'gpt-image' | 'nano-banana'
export interface ImageGenerationConfig extends Omit<ImageGenerationSelection, 'channelId' | 'modelId'> {
  apiKey: string
  baseUrl: string
  model: string
  protocol: ImageGenerationProtocol
  channelId?: string
}
interface ResolverDependencies {
  getDefaultSelection(): ImageGenerationSelection | null | undefined
  getChannel(id: string): Channel | undefined
  decryptKey(id: string): string
  getLegacyCredentials(toolId: ImageGenerationToolId): Record<string, string>
}

/** 只允许普通 API 渠道；订阅/OAuth 凭据不能借图片配置进入另一计费协议。 */
export function validateImageGenerationChannel(channel: Pick<Channel, 'provider' | 'baseUrl' | 'imageGeneration'>): ImageGenerationChannelConfig | undefined {
  const config = channel.imageGeneration
  if (!config) return undefined
  if (!['openai', 'openai-responses', 'google', 'custom'].includes(channel.provider)) {
    throw new Error('此渠道不支持独立生图 API，请使用普通 API Key 渠道')
  }
  if (!['openai-images', 'gemini'].includes(config.protocol)) throw new Error('不支持的生图协议')
  if (!Array.isArray(config.models) || config.models.length === 0 || config.models.some((id) => typeof id !== 'string' || !id.trim() || id !== id.trim())) {
    throw new Error('请配置有效的生图模型')
  }
  if (channel.provider === 'custom' && !config.baseUrl?.trim()) throw new Error('自定义渠道必须明确配置图片 API 根地址')
  validateImageGenerationBaseUrl(config.baseUrl?.trim() || channel.baseUrl)
  return { protocol: config.protocol, models: [...new Set(config.models)], ...(config.baseUrl?.trim() ? { baseUrl: config.baseUrl.trim().replace(/\/+$/, '') } : {}) }
}

export function validateImageGenerationBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('生图 API 根地址无效') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || /\/(?:chat\/completions|responses|messages|images\/(?:generations|edits)|models\/[^/]+(?::generateContent)?)\/?$/i.test(url.pathname)) {
    throw new Error('请填写生图 API 根地址，而非聊天或生成请求地址')
  }
  return value.replace(/\/+$/, '')
}

function validateSelection(selection: ImageGenerationSelection, protocol: ImageGenerationProtocol): void {
  const values: Array<[unknown, readonly unknown[], string]> = [
    [selection.size, ['auto', '1024x1024', '1536x1024', '1024x1536'], 'size'],
    [selection.aspectRatio, ['auto', '1:1', '16:9', '9:16', '3:2', '2:3'], 'aspectRatio'],
    [selection.imageSize, ['auto', '1K', '2K', '4K'], 'imageSize'],
    [selection.quality, getImageGenerationQualities(selection.modelId), 'quality'],
  ]
  for (const [value, allowed, name] of values) {
    if (value !== undefined && !allowed.includes(value)) throw new Error(`生图参数 ${name} 不受所选模型支持`)
  }
  if (selection.numberOfImages !== undefined && (!Number.isInteger(selection.numberOfImages) || selection.numberOfImages < 1 || selection.numberOfImages > 4)) throw new Error('生图数量必须为 1–4 的整数')
  if (protocol === 'gemini' && selection.size && selection.size !== 'auto') throw new Error('Gemini 请使用图片比例和清晰度设置')
  if (protocol === 'openai-images' && selection.imageSize && selection.imageSize !== 'auto') throw new Error('OpenAI Images 请使用图片尺寸设置')
}

export function createImageGenerationResolver(deps: ResolverDependencies) {
  function resolveSelection(selection?: ImageGenerationSelection): ImageGenerationSelection | undefined {
    const selected = selection ?? deps.getDefaultSelection()
    if (!selected) return undefined
    const channel = deps.getChannel(selected.channelId)
    if (!channel?.enabled) throw new Error('所选生图渠道不存在或已停用')
    if (selected.channelUpdatedAt !== undefined && selected.channelUpdatedAt !== channel.updatedAt) {
      throw new Error('生图渠道配置已变化，请重新选择后发送')
    }
    const config = validateImageGenerationChannel(channel)
    if (!config || !config.models.includes(selected.modelId)) throw new Error('所选渠道未配置此生图模型')
    validateSelection(selected, config.protocol)
    // 白名单复制，避免运行时输入附带密钥等未知字段进入会话快照。
    return {
      channelId: selected.channelId, channelUpdatedAt: channel.updatedAt, modelId: selected.modelId,
      ...(selected.size !== undefined ? { size: selected.size } : {}),
      ...(selected.quality !== undefined ? { quality: selected.quality } : {}),
      ...(selected.aspectRatio !== undefined ? { aspectRatio: selected.aspectRatio } : {}),
      ...(selected.imageSize !== undefined ? { imageSize: selected.imageSize } : {}),
      ...(selected.numberOfImages !== undefined ? { numberOfImages: selected.numberOfImages } : {}),
    }
  }
  function toolIdForSelection(selection: ImageGenerationSelection): ImageGenerationToolId {
    const selected = resolveSelection(selection)!
    return deps.getChannel(selected.channelId)!.imageGeneration!.protocol === 'gemini' ? 'nano-banana' : 'gpt-image'
  }
  function resolveConfig(toolId: ImageGenerationToolId, selection?: ImageGenerationSelection): ImageGenerationConfig {
    const selected = resolveSelection(selection)
    if (!selected) {
      const credentials = deps.getLegacyCredentials(toolId)
      if (!credentials.apiKey?.trim()) throw new Error('生图工具未配置 API Key')
      const gemini = toolId === 'nano-banana'
      return {
        apiKey: credentials.apiKey, protocol: gemini ? 'gemini' : 'openai-images',
        baseUrl: validateImageGenerationBaseUrl(credentials.baseUrl?.trim() || (gemini ? 'https://generativelanguage.googleapis.com' : 'https://api.openai.com/v1')),
        model: credentials.model?.trim() || (gemini ? 'gemini-3.1-flash-image-preview' : 'gpt-image-2'),
      }
    }
    if (toolIdForSelection(selected) !== toolId) throw new Error('所选生图协议与调用工具不匹配')
    const channel = deps.getChannel(selected.channelId)!
    const apiKey = deps.decryptKey(channel.id)
    if (!apiKey.trim()) throw new Error('所选生图渠道未配置 API Key')
    const { modelId, ...parameters } = selected
    return { ...parameters, apiKey, model: modelId, protocol: channel.imageGeneration!.protocol,
      baseUrl: validateImageGenerationBaseUrl(channel.imageGeneration!.baseUrl?.trim() || channel.baseUrl) }
  }
  return { resolveSelection, resolveConfig, toolIdForSelection,
    isAvailable(toolId: ImageGenerationToolId): boolean { try { resolveConfig(toolId); return true } catch { return false } },
  }
}

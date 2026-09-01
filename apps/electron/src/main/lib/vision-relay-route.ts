import { createHash } from 'node:crypto'
import type { ProviderType } from '@domi/shared'

/**
 * 视觉路由身份。
 *
 * 授权模型：设置中启用并选定视觉模型即完成授权（settings-level consent），
 * 会话内不再弹窗确认。本模块只负责把「渠道 + 端点 + 模型 + 凭据版本」
 * 绑定成一个可比较的 routeKey，供执行前后做路由一致性校验，
 * 防止请求中途同一 channel ID 被原地改到其他端点。
 */

const CODEX_VISION_ENDPOINT = 'https://chatgpt.com/backend-api'
const UNSAFE_DISPLAY_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g

export interface VisionRelayRouteChannel {
  id: string
  name: string
  provider: ProviderType
  baseUrl: string
  credentialVersion?: string
}

export interface VisionRelayRouteIdentity {
  routeKey: string
  provider: ProviderType
  endpointHost: string
  channelName: string
  modelId: string
}

export function sanitizeVisionRelayDisplayText(value: string, fallback: string, maxLength = 120): string {
  const sanitized = value
    .normalize('NFKC')
    .replace(UNSAFE_DISPLAY_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
  return sanitized || fallback
}

function canonicalizeVisionEndpoint(provider: ProviderType, baseUrl: string): URL | undefined {
  try {
    const url = new URL(provider === 'openai-codex' ? CODEX_VISION_ENDPOINT : baseUrl.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    // userinfo/query can affect tenant or backend routing, so they remain in the hashed fingerprint.
    // Fragments are never sent over HTTP and therefore are intentionally excluded.
    url.hash = ''
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url
  } catch {
    return undefined
  }
}

export function buildVisionRelayRouteIdentity(
  channel: VisionRelayRouteChannel,
  modelId: string,
): VisionRelayRouteIdentity | undefined {
  const normalizedModelId = modelId.trim()
  const endpoint = canonicalizeVisionEndpoint(channel.provider, channel.baseUrl)
  const credentialVersion = channel.credentialVersion?.trim()
  if (!normalizedModelId || !endpoint || !credentialVersion) return undefined
  const endpointHash = createHash('sha256').update(endpoint.toString(), 'utf8').digest('hex')
  return {
    routeKey: JSON.stringify([channel.id.trim(), channel.provider, endpointHash, normalizedModelId, credentialVersion]),
    provider: channel.provider,
    endpointHost: sanitizeVisionRelayDisplayText(endpoint.host, '未知端点'),
    channelName: sanitizeVisionRelayDisplayText(channel.name, '未命名渠道'),
    modelId: sanitizeVisionRelayDisplayText(normalizedModelId, '未知模型'),
  }
}

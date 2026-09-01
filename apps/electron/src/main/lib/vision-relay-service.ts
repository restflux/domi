import type { ProviderType } from '@domi/shared'
import type { VisionRelayQualityPreset, VisionRelaySettings } from '../../types'
import type { VisionRelayAccessScope } from './vision-relay-access-scope'
import type { NormalizedVisionImage } from './vision-relay-image'
import { VisionRelayImageError } from './vision-relay-image'
import { isVisionRelaySourceEligible, isVisionRelayTargetEligible } from './vision-relay-policy'
import { buildVisionRelayRouteIdentity } from './vision-relay-route'
import {
  normalizeVisionRelayAnalysisMode,
  normalizeVisionRelayQuestion,
  VisionRelayProviderError,
  type VisionRelayAnalysisMode,
} from './vision-relay-provider'
import { parseVisionRelayModelOutput, VisionRelayResultError, type VisionRelayObservation } from './vision-relay-result'

const MAX_CONCURRENT_VISION_REQUESTS = 3
const activeSessions = new Set<string>()
let activeRequestCount = 0

export interface VisionRelayChannel {
  id: string
  name: string
  provider: ProviderType
  baseUrl: string
  credentialVersion?: string
  enabled: boolean
  models: Array<{ id: string; enabled: boolean }>
}

export interface VisionRelayServiceDependencies {
  getSettings: () => VisionRelaySettings | undefined
  getChannel: (channelId: string) => VisionRelayChannel | undefined
  resolveImageCapability: (provider: ProviderType, modelId: string | undefined) => Promise<'supported' | 'unsupported' | 'unknown'>
  normalizeImage: (input: { imagePath: string; scope: VisionRelayAccessScope; signal?: AbortSignal }) => Promise<NormalizedVisionImage>
  executeProvider: (input: {
    channel: VisionRelayChannel
    modelId: string
    image: NormalizedVisionImage
    question: string
    analysisMode: VisionRelayAnalysisMode
    qualityPreset: VisionRelayQualityPreset
    signal?: AbortSignal
  }) => Promise<string>
}

export type VisionRelayFailureCode =
  | 'VISION_INVALID_REQUEST'
  | 'VISION_NOT_CONFIGURED'
  | 'VISION_CONTEXT_NOT_ALLOWED'
  | 'VISION_SOURCE_NOT_ELIGIBLE'
  | 'VISION_ROUTE_UNAVAILABLE'
  | 'VISION_BUSY'
  | 'VISION_FILE_NOT_AUTHORIZED'
  | 'VISION_UNSUPPORTED_IMAGE'
  | 'VISION_IMAGE_TOO_LARGE'
  | 'VISION_IMAGE_TIMEOUT'
  | 'VISION_ABORTED'
  | 'VISION_AUTH_FAILED'
  | 'VISION_RATE_LIMITED'
  | 'VISION_TIMEOUT'
  | 'VISION_OUTPUT_TOO_LARGE'
  | 'VISION_PROVIDER_ERROR'
  | 'VISION_OUTPUT_INVALID'
  | 'VISION_INTERNAL_ERROR'

export type VisionRelayServiceResult =
  | { ok: true; observation: VisionRelayObservation }
  | { ok: false; code: VisionRelayFailureCode; message: string }

const FAILURE_MESSAGES: Record<VisionRelayFailureCode, string> = {
  VISION_INVALID_REQUEST: '请提供明确的视觉问题，并使用受支持的分析模式。',
  VISION_NOT_CONFIGURED: '视觉助手尚未启用或配置不完整。',
  VISION_CONTEXT_NOT_ALLOWED: '当前运行来源不允许外发图片。',
  VISION_SOURCE_NOT_ELIGIBLE: '当前模型未被确认是纯文本模型，未启用视觉中继。',
  VISION_ROUTE_UNAVAILABLE: '配置的视觉渠道或模型不可用，或未确认支持图片输入。',
  VISION_BUSY: '视觉助手当前请求较多，请稍后重试。',
  VISION_FILE_NOT_AUTHORIZED: '图片不在当前 Session Target 或显式附件授权范围内。',
  VISION_UNSUPPORTED_IMAGE: '图片格式不支持或无法安全解码。',
  VISION_IMAGE_TOO_LARGE: '图片大小、尺寸或总像素超过限制。',
  VISION_IMAGE_TIMEOUT: '图片安全解码超时。',
  VISION_ABORTED: '视觉请求已取消。',
  VISION_AUTH_FAILED: '视觉渠道认证失败，请重新保存或登录该渠道。',
  VISION_RATE_LIMITED: '视觉渠道额度不足或请求过于频繁。',
  VISION_TIMEOUT: '视觉模型请求超时。',
  VISION_OUTPUT_TOO_LARGE: '视觉模型返回内容超过安全上限。',
  VISION_PROVIDER_ERROR: '视觉模型请求失败。',
  VISION_OUTPUT_INVALID: '视觉模型未返回符合安全协议的结构化结果。',
  VISION_INTERNAL_ERROR: '视觉助手发生内部错误。',
}

function failure(code: VisionRelayFailureCode): VisionRelayServiceResult {
  return { ok: false, code, message: FAILURE_MESSAGES[code] }
}

function isAllowedTrigger(triggeredBy: 'user' | 'automation' | 'delegation' | undefined): boolean {
  return triggeredBy === 'user'
}

function mapFailure(error: unknown): VisionRelayServiceResult {
  if (error instanceof VisionRelayImageError) return failure(error.code)
  if (error instanceof VisionRelayProviderError) return failure(error.code)
  if (error instanceof VisionRelayResultError) return failure(error.code)
  console.warn('[Vision Relay] unexpected failure:', error instanceof Error ? error.name : typeof error)
  return failure('VISION_INTERNAL_ERROR')
}

export async function executeVisionRelay(input: {
  sessionId: string
  sourceProvider: ProviderType
  sourceModelId?: string
  triggeredBy?: 'user' | 'automation' | 'delegation'
  imagePath: string
  question: string
  analysisMode?: VisionRelayAnalysisMode
  accessScope: VisionRelayAccessScope
  signal?: AbortSignal
}, dependencies: VisionRelayServiceDependencies): Promise<VisionRelayServiceResult> {
  if (!isAllowedTrigger(input.triggeredBy)) return failure('VISION_CONTEXT_NOT_ALLOWED')
  let question: string
  let analysisMode: VisionRelayAnalysisMode
  try {
    question = normalizeVisionRelayQuestion(input.question)
    analysisMode = normalizeVisionRelayAnalysisMode(input.analysisMode)
  } catch (error) {
    return mapFailure(error)
  }
  const settings = dependencies.getSettings()
  if (!settings?.enabled || !settings.channelId || !settings.modelId || !settings.authorizationVersion) {
    return failure('VISION_NOT_CONFIGURED')
  }
  const sourceCapability = await dependencies.resolveImageCapability(input.sourceProvider, input.sourceModelId)
  if (!isVisionRelaySourceEligible(sourceCapability)) return failure('VISION_SOURCE_NOT_ELIGIBLE')

  const channel = dependencies.getChannel(settings.channelId)
  if (!channel?.enabled || !channel.models.some((model) => model.id === settings.modelId && model.enabled)) {
    return failure('VISION_ROUTE_UNAVAILABLE')
  }
  const initialRoute = buildVisionRelayRouteIdentity(channel, settings.modelId)
  if (!initialRoute) return failure('VISION_ROUTE_UNAVAILABLE')
  const targetCapability = await dependencies.resolveImageCapability(channel.provider, settings.modelId)
  if (!isVisionRelayTargetEligible(targetCapability)) return failure('VISION_ROUTE_UNAVAILABLE')
  if (activeSessions.has(input.sessionId) || activeRequestCount >= MAX_CONCURRENT_VISION_REQUESTS) return failure('VISION_BUSY')

  activeSessions.add(input.sessionId)
  activeRequestCount += 1
  try {
    const image = await dependencies.normalizeImage({ imagePath: input.imagePath, scope: input.accessScope, signal: input.signal })

    // 设置即授权，会话内不再弹窗确认；但图片规范化可能耗时，
    // 执行前仍重新读取路由，防止同一 channel ID 被原地改到其他端点或路由被切换。
    const currentSettings = dependencies.getSettings()
    const currentChannel = currentSettings?.channelId ? dependencies.getChannel(currentSettings.channelId) : undefined
    const currentRoute = currentSettings?.modelId && currentChannel
      ? buildVisionRelayRouteIdentity(currentChannel, currentSettings.modelId)
      : undefined
    if (!currentSettings?.enabled
      || !currentSettings.modelId
      || currentSettings.authorizationVersion !== settings.authorizationVersion
      || !currentChannel?.enabled
      || !currentChannel.models.some((model) => model.id === currentSettings.modelId && model.enabled)
      || !currentRoute
      || currentRoute.routeKey !== initialRoute.routeKey) {
      return failure('VISION_ROUTE_UNAVAILABLE')
    }

    const output = await dependencies.executeProvider({
      channel: currentChannel,
      modelId: currentSettings.modelId,
      image,
      question,
      analysisMode,
      qualityPreset: currentSettings.qualityPreset,
      signal: input.signal,
    })
    return {
      ok: true,
      observation: parseVisionRelayModelOutput(output, {
        filename: image.filename,
        width: image.width,
        height: image.height,
        animatedFirstFrame: image.animatedFirstFrame,
        relay: {
          provider: currentRoute.provider,
          channelName: currentRoute.channelName,
          modelId: currentRoute.modelId,
          qualityPreset: currentSettings.qualityPreset,
          analysisMode,
        },
      }, { localWarnings: image.warnings }),
    }
  } catch (error) {
    return mapFailure(error)
  } finally {
    activeSessions.delete(input.sessionId)
    activeRequestCount = Math.max(0, activeRequestCount - 1)
  }
}

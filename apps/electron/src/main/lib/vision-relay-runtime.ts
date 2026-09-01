import type { ProviderType } from '@domi/shared'
import { getSettings } from './settings-service'
import {
  getChannelById,
  persistCodexOAuthCredentials,
  resolveChannelRuntimeApiKey,
  resolveCodexOAuthCredentials,
} from './channel-manager'
import { getEffectiveProxyUrl } from './proxy-settings-service'
import { resolvePiImageInputCapability } from './adapters/pi-model-registry'
import { generateCodexVision } from './adapters/pi-codex-vision'
import { normalizeAuthorizedVisionImage } from './vision-relay-image'
import {
  buildVisionRelaySystemPrompt,
  executeAdapterVisionRequest,
  VisionRelayProviderError,
  type VisionRelayAnalysisMode,
} from './vision-relay-provider'
import { executeVisionRelay, type VisionRelayServiceResult } from './vision-relay-service'
import type { VisionRelayAccessScope } from './vision-relay-access-scope'

export interface InspectImageWithVisionRelayInput {
  sessionId: string
  sourceProvider: ProviderType
  sourceModelId?: string
  triggeredBy?: 'user' | 'automation' | 'delegation'
  imagePath: string
  question: string
  analysisMode?: VisionRelayAnalysisMode
  accessScope: VisionRelayAccessScope
  signal?: AbortSignal
}

export async function inspectImageWithVisionRelay(input: InspectImageWithVisionRelayInput): Promise<VisionRelayServiceResult> {
  return executeVisionRelay(input, {
    getSettings: () => getSettings().visionRelay,
    getChannel: getChannelById,
    resolveImageCapability: resolvePiImageInputCapability,
    normalizeImage: normalizeAuthorizedVisionImage,
    executeProvider: async ({ channel, modelId, image, question, analysisMode, qualityPreset, signal }) => {
      const proxyUrl = await getEffectiveProxyUrl()
      try {
        if (channel.provider === 'openai-codex') {
          const credentials = await resolveCodexOAuthCredentials(channel.id)
          return await generateCodexVision({
            modelId,
            credentials,
            image,
            question,
            systemPrompt: buildVisionRelaySystemPrompt({ analysisMode, qualityPreset }),
            qualityPreset,
            proxyUrl,
            signal,
            onCredentialsRefreshed: (next) => { persistCodexOAuthCredentials(channel.id, next) },
          })
        }
        const apiKey = await resolveChannelRuntimeApiKey(channel.id)
        return await executeAdapterVisionRequest({
          provider: channel.provider,
          baseUrl: channel.baseUrl,
          apiKey,
          modelId,
          image,
          question,
          analysisMode,
          qualityPreset,
          proxyUrl,
          signal,
        })
      } catch (error) {
        throw VisionRelayProviderError.from(error, { aborted: signal?.aborted === true })
      }
    },
  })
}

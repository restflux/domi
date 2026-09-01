import { randomUUID } from 'node:crypto'
import type { CodexOAuthCredentials } from '@domi/shared'
import type {
  AssistantMessage,
  Context,
  Model,
  OpenAICodexResponsesOptions,
} from '@earendil-works/pi-ai/compat'
import type { Dispatcher } from 'undici'
import type { VisionRelayQualityPreset } from '../../../types'
import { VisionRelayProviderError } from '../vision-relay-provider'
import { buildCodexModel } from './pi-model-registry'
import { extractCodexResponseText, resolveCodexTitleConnectionSettings } from './pi-codex-title-generator'
import {
  closePiRequestProxyDispatcher,
  createPiRequestProxyDispatcher,
  installPiRequestProxyFetch,
  runWithPiRequestProxy,
} from './pi-request-proxy'

export type CodexVisionModel = Model<'openai-codex-responses'>
const VISION_REQUEST_TIMEOUT_MS = 60_000
const VISION_MAX_OUTPUT_TOKENS = 3_000
const VISION_MAX_OUTPUT_CHARS = 12_000
const VISION_MAX_OUTPUT_BYTES = 64 * 1024

export interface CodexVisionRuntime {
  complete: (
    model: CodexVisionModel,
    context: Context,
    options: OpenAICodexResponsesOptions,
  ) => Promise<Pick<AssistantMessage, 'content' | 'stopReason' | 'errorMessage'>>
}

export interface CodexVisionRequestEnvironment {
  dispatcher?: Dispatcher
  installRequestProxyFetch: () => void
  runWithRequestProxy: <T>(dispatcher: Dispatcher | undefined, operation: () => T) => T
  closeRequestProxyDispatcher: (dispatcher: Dispatcher | undefined) => Promise<void>
}

export interface CodexVisionRequestInput {
  image: { data: Buffer; mediaType: 'image/png' | 'image/jpeg' }
  question: string
  systemPrompt: string
  qualityPreset: VisionRelayQualityPreset
  signal?: AbortSignal
}

function resolveCodexVisionQuality(qualityPreset: VisionRelayQualityPreset): Pick<OpenAICodexResponsesOptions, 'reasoningEffort' | 'textVerbosity'> {
  if (qualityPreset === 'fast') return { reasoningEffort: 'none', textVerbosity: 'low' }
  if (qualityPreset === 'accurate') return { reasoningEffort: 'medium', textVerbosity: 'medium' }
  return { reasoningEffort: 'low', textVerbosity: 'medium' }
}

export async function completeCodexVisionRequest(
  runtime: CodexVisionRuntime,
  model: CodexVisionModel,
  input: CodexVisionRequestInput,
  environment: CodexVisionRequestEnvironment,
): Promise<string> {
  try {
    environment.installRequestProxyFetch()
    const response = await environment.runWithRequestProxy(environment.dispatcher, () => runtime.complete(
      model,
      {
        systemPrompt: input.systemPrompt,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', data: input.image.data.toString('base64'), mimeType: input.image.mediaType },
            { type: 'text', text: input.question },
          ],
          timestamp: Date.now(),
        }],
      },
      {
        sessionId: randomUUID(),
        transport: environment.dispatcher ? 'sse' : 'auto',
        ...(input.signal && { signal: input.signal }),
        maxTokens: VISION_MAX_OUTPUT_TOKENS,
        timeoutMs: VISION_REQUEST_TIMEOUT_MS,
        maxRetries: 0,
        ...resolveCodexVisionQuality(input.qualityPreset),
        toolChoice: 'none',
      } satisfies OpenAICodexResponsesOptions,
    ))
    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      throw new Error(response.errorMessage?.trim() || 'Codex 视觉请求未完成')
    }
    const content = extractCodexResponseText(response.content).trim()
    if (!content) throw new Error('Codex 视觉请求返回空内容')
    if (content.length > VISION_MAX_OUTPUT_CHARS || Buffer.byteLength(content, 'utf8') > VISION_MAX_OUTPUT_BYTES) {
      throw new VisionRelayProviderError('VISION_OUTPUT_TOO_LARGE')
    }
    return content
  } finally {
    await environment.closeRequestProxyDispatcher(environment.dispatcher)
  }
}

export async function generateCodexVision(input: {
  modelId: string
  credentials: CodexOAuthCredentials
  image: CodexVisionRequestInput['image']
  question: string
  systemPrompt: string
  qualityPreset: VisionRelayQualityPreset
  proxyUrl?: string
  signal?: AbortSignal
  onCredentialsRefreshed?: (credentials: CodexOAuthCredentials) => void | Promise<void>
}): Promise<string> {
  const sdk = await import('@earendil-works/pi-coding-agent')
  const { modelRuntime, model } = await buildCodexModel(sdk, {
    model: input.modelId,
    codexOAuthCredentials: input.credentials,
    onCodexOAuthCredentialsRefreshed: input.onCredentialsRefreshed,
  })
  const connection = resolveCodexTitleConnectionSettings(input.proxyUrl)
  const dispatcher = createPiRequestProxyDispatcher({
    proxyUrl: connection.proxyUrl,
    noProxy: connection.noProxy,
    httpIdleTimeoutMs: VISION_REQUEST_TIMEOUT_MS,
  })
  return completeCodexVisionRequest(
    modelRuntime as CodexVisionRuntime,
    model as CodexVisionModel,
    input,
    {
      dispatcher,
      installRequestProxyFetch: installPiRequestProxyFetch,
      runWithRequestProxy: runWithPiRequestProxy,
      closeRequestProxyDispatcher: closePiRequestProxyDispatcher,
    },
  )
}

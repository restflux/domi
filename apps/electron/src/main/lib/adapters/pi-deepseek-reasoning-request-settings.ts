import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  normalizeReasoningLevel,
  resolveReasoningProfile,
  type AgentThinkingLevel,
  type ProviderType,
  type ReasoningProfile,
  type ReasoningTransport,
} from '@domi/shared'

type ProviderPayload = Record<string, unknown>

export interface DeepSeekReasoningRequestSettings {
  provider: ProviderType
  transport: ReasoningTransport
  profile?: ReasoningProfile
  thinkingLevel?: AgentThinkingLevel
}

function isProviderPayload(payload: unknown): payload is ProviderPayload {
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
}

function isCanonicalThinking(value: unknown, type: 'enabled' | 'disabled'): boolean {
  if (!isProviderPayload(value)) return false
  return value.type === type && value.budget_tokens === undefined && value.display === undefined
}

function isCanonicalOutputConfig(value: unknown, effort: string): boolean {
  return isProviderPayload(value) && value.effort === effort
}

/**
 * Temporary Pi 0.84.4 compatibility shim for DeepSeek V4's Anthropic endpoint.
 *
 * Pi currently builds legacy budget thinking for this transport. DeepSeek V4
 * instead requires `thinking.type` plus `output_config.effort`. The strict
 * provider/transport/profile checks keep Qwen/OpenAI-compatible DeepSeek models
 * on their native protocol. Once Pi emits the canonical payload itself, the
 * identity checks below make this shim a no-op so a later Pi upgrade is safe.
 */
export function injectDeepSeekReasoningLevel(
  payload: unknown,
  settings: DeepSeekReasoningRequestSettings,
): unknown {
  if (!isProviderPayload(payload)) return payload
  if (settings.provider !== 'deepseek' || settings.transport !== 'anthropic-messages') return payload

  const modelId = typeof payload.model === 'string' ? payload.model : undefined
  const payloadProfile = resolveReasoningProfile({
    modelId,
    transport: settings.transport,
  })
  if (!payloadProfile || (settings.profile && settings.profile.id !== payloadProfile.id)) return payload
  const profile = settings.profile ?? payloadProfile
  const encoding = profile.encodings['anthropic-messages']
  if (encoding?.kind !== 'deepseek-output-effort' || !settings.thinkingLevel) return payload

  const normalizedLevel = normalizeReasoningLevel(profile, settings.thinkingLevel)
  if (!normalizedLevel) return payload

  if (normalizedLevel === 'off') {
    if (isCanonicalThinking(payload.thinking, 'disabled') && payload.output_config === undefined) return payload
    const { thinking: _legacyThinking, output_config: _staleOutputConfig, ...body } = payload
    return { ...body, thinking: { type: 'disabled' } }
  }

  const effort = encoding.effortMap[normalizedLevel]
  if (typeof effort !== 'string') return payload
  if (
    isCanonicalThinking(payload.thinking, 'enabled')
    && isCanonicalOutputConfig(payload.output_config, effort)
  ) return payload

  const { thinking: _legacyThinking, output_config: _staleOutputConfig, ...body } = payload
  return {
    ...body,
    thinking: { type: 'enabled' },
    output_config: { effort },
  }
}

/** Pi inline extension for DeepSeek V4 Anthropic-compatible reasoning requests. */
export function createDeepSeekReasoningRequestExtension(
  settings: DeepSeekReasoningRequestSettings,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on('before_provider_request', (event) => {
      const updatedPayload = injectDeepSeekReasoningLevel(event.payload, settings)
      return updatedPayload === event.payload ? undefined : updatedPayload
    })
  }
}

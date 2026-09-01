import { inferReasoningTransport, normalizeReasoningCapabilityLevel, normalizeReasoningLevel, resolveReasoningProfile, type AgentSessionMeta, type AgentThinkingLevel, type ProviderType, type ReasoningCapability } from '@domi/shared'
import type { AppSettings } from '../../types'

type ThinkingSettings = Pick<AppSettings, 'agentThinking' | 'agentEffort'>
type ThinkingSessionMeta = Pick<AgentSessionMeta, 'reasoningLevel' | 'openAIThinkingLevel'>

export function resolvePiThinkingLevel(
  settings: ThinkingSettings,
  sessionMeta: ThinkingSessionMeta | undefined,
  provider: ProviderType | undefined,
  modelId?: string,
  capability?: ReasoningCapability,
): AgentThinkingLevel {
  const reasoningProfile = resolveReasoningProfile({
    modelId,
    transport: inferReasoningTransport(provider),
  })
  // coding 场景默认 medium：无持久化配置时不过度消耗推理；显式设置仍优先。
  const configuredLevel = settings.agentThinking?.type === 'disabled'
    ? 'off'
    : settings.agentEffort ?? 'medium'
  const persistedLevel = sessionMeta?.reasoningLevel ?? sessionMeta?.openAIThinkingLevel
  if (reasoningProfile) {
    return normalizeReasoningLevel(reasoningProfile, persistedLevel ?? configuredLevel)!
  }
  if (capability) {
    const requestedLevel = persistedLevel
      ?? (capability.source === 'temporary-adaptation' || capability.source === 'provider-metadata'
        ? capability.defaultLevel
        : configuredLevel)
    return normalizeReasoningCapabilityLevel(capability, requestedLevel)!
  }
  if (configuredLevel === 'max') return 'xhigh'
  return configuredLevel
}

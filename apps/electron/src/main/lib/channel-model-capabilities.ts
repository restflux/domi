import type { AgentThinkingLevel, ChannelModel, ChannelModelCapabilities } from '@domi/shared'

/** OpenAI-compatible `/models` item fields that may carry model capabilities. */
export interface OpenAIModelItem {
  id: string
  owned_by?: string
  context_window?: number
  contextWindow?: number
  max_output_tokens?: number
  max_tokens?: number
  maxTokens?: number
  input_modalities?: string[]
  input?: string[]
  reasoning?: boolean | { supported?: boolean; efforts?: string[]; default_effort?: string }
  supports_reasoning?: boolean
  reasoning_efforts?: string[]
  supported_reasoning_efforts?: string[]
  supported_reasoning_levels?: Array<string | { effort?: unknown }>
  default_reasoning_effort?: string
}

const CHANNEL_MODEL_THINKING_LEVELS = new Set<AgentThinkingLevel>([
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
])

/** 仅保留供应商模型列表明确返回且 Domi 能安全表达的能力字段。 */
export function parseOpenAIModelCapabilities(item: OpenAIModelItem): ChannelModelCapabilities | undefined {
  const rawInput = item.input_modalities ?? item.input
  const input = Array.isArray(rawInput)
    ? rawInput
        .filter((modality): modality is string => typeof modality === 'string')
        .map((modality) => modality.toLowerCase())
        .filter((modality): modality is 'text' | 'image' => modality === 'text' || modality === 'image')
    : undefined
  const reasoningObject = item.reasoning && typeof item.reasoning === 'object' ? item.reasoning : undefined
  const structuredLevels = item.supported_reasoning_levels
  const rawReasoningLevels = item.reasoning_efforts
    ?? item.supported_reasoning_efforts
    ?? reasoningObject?.efforts
    ?? (Array.isArray(structuredLevels) ? structuredLevels.map((entry) => {
      if (typeof entry === 'string') return entry
      return entry && typeof entry === 'object' ? entry.effort : undefined
    }) : undefined)
  const reasoningLevels = Array.isArray(rawReasoningLevels)
    ? rawReasoningLevels
        .filter((level): level is string => typeof level === 'string')
        .map((level) => level.toLowerCase() === 'none' ? 'off' : level.toLowerCase())
        .filter((level): level is AgentThinkingLevel => CHANNEL_MODEL_THINKING_LEVELS.has(level as AgentThinkingLevel))
    : undefined
  const rawDefaultReasoningLevel = item.default_reasoning_effort
    ?? reasoningObject?.default_effort
  const normalizedDefaultReasoningLevel = typeof rawDefaultReasoningLevel === 'string'
    ? (rawDefaultReasoningLevel.toLowerCase() === 'none' ? 'off' : rawDefaultReasoningLevel.toLowerCase()) as AgentThinkingLevel
    : undefined
  const defaultReasoningLevel = normalizedDefaultReasoningLevel
    && CHANNEL_MODEL_THINKING_LEVELS.has(normalizedDefaultReasoningLevel)
    ? normalizedDefaultReasoningLevel
    : undefined
  const contextWindow = item.context_window ?? item.contextWindow
  const maxTokens = item.max_output_tokens ?? item.max_tokens ?? item.maxTokens
  // 显式空集合表示没有可选推理；不能将它当作缺失元数据并重新开放基础档位。
  const reasoning = Array.isArray(rawReasoningLevels) && rawReasoningLevels.length === 0
    ? false
    : typeof item.reasoning === 'boolean'
      ? item.reasoning
      : reasoningObject?.supported ?? item.supports_reasoning
  const hasStructuredLevels = Array.isArray(structuredLevels) && rawReasoningLevels !== undefined
  const thinkingLevelMap = reasoningLevels ? Object.fromEntries(
    (hasStructuredLevels ? [...CHANNEL_MODEL_THINKING_LEVELS] : [...new Set(reasoningLevels)])
      .map((level) => [level, reasoningLevels.includes(level) ? level === 'off' ? 'none' : level : null]),
  ) : undefined
  const metadata: ChannelModelCapabilities = {
    ...(input && input.length > 0 ? { input: [...new Set(input)] } : {}),
    ...(Number.isSafeInteger(contextWindow) && contextWindow! > 0 ? { contextWindow } : {}),
    ...(Number.isSafeInteger(maxTokens) && maxTokens! > 0 ? { maxTokens } : {}),
    ...(reasoning != null ? { reasoning } : {}),
    ...(reasoningLevels && (reasoningLevels.length > 0 || rawReasoningLevels?.length === 0 || hasStructuredLevels) ? {
      reasoningLevels: [...new Set(reasoningLevels)],
      thinkingLevelMap,
    } : {}),
    ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined
}

export function createFetchedOpenAIChannelModel(item: OpenAIModelItem): ChannelModel {
  const providerMetadata = parseOpenAIModelCapabilities(item)
  return {
    id: item.id,
    name: item.id,
    enabled: true,
    source: 'fetched',
    ...(providerMetadata ? { providerMetadata } : {}),
  }
}

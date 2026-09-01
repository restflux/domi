import type {
  AgentSessionMeta,
  AgentThinkingLevel,
  Channel,
  ReasoningCapability,
} from '@domi/shared'
import type { AppSettings } from '../../types'

const THINKING_LEVEL_LABELS: Record<AgentThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

export interface BridgeRunMetadata {
  channelName: string
  modelId?: string
  modelName: string
  modelValid: boolean
  thinkingLevel: AgentThinkingLevel
}

export interface ResolveBridgeRunMetadataInput {
  channelId?: string
  modelId?: string
  sessionMeta?: Pick<AgentSessionMeta, 'reasoningLevel' | 'openAIThinkingLevel'>
  settings: AppSettings
}

export interface BridgeRunMetadataDependencies {
  getChannel: (channelId: string) => Channel | undefined
  resolveReasoningCapability: (
    provider: Channel['provider'],
    modelId: string | undefined,
    configuredModel?: Channel['models'][number],
  ) => Promise<ReasoningCapability | undefined>
  resolveThinkingLevel: (
    settings: AppSettings,
    sessionMeta: ResolveBridgeRunMetadataInput['sessionMeta'],
    provider: Channel['provider'] | undefined,
    modelId: string | undefined,
    capability: ReasoningCapability | undefined,
  ) => AgentThinkingLevel
  onCapabilityError?: (error: unknown) => void
}

/**
 * 使用与 Agent 正式运行一致的依赖解析 IM 运行元信息。
 * 依赖注入让 Bridge 能复用正式 runtime 逻辑，同时保持模型与档位组合可聚焦测试。
 */
export async function resolveBridgeRunMetadataWithDependencies(
  input: ResolveBridgeRunMetadataInput,
  dependencies: BridgeRunMetadataDependencies,
): Promise<BridgeRunMetadata> {
  const channel = input.channelId ? dependencies.getChannel(input.channelId) : undefined
  const configuredModel = channel
    ? channel.models.find((model) => model.id === input.modelId)
      ?? (input.modelId ? undefined : channel.models.find((model) => model.enabled))
    : undefined
  const modelId = input.modelId ?? configuredModel?.id

  let capability: ReasoningCapability | undefined
  try {
    capability = channel && modelId
      ? await dependencies.resolveReasoningCapability(channel.provider, modelId, configuredModel)
      : undefined
  } catch (error) {
    dependencies.onCapabilityError?.(error)
  }

  const thinkingLevel = dependencies.resolveThinkingLevel(
    input.settings,
    input.sessionMeta,
    channel?.provider,
    modelId,
    capability,
  )

  return {
    channelName: channel?.name ?? input.channelId ?? '未设置',
    modelId,
    modelName: configuredModel?.name ?? modelId ?? '未设置',
    modelValid: Boolean(channel && configuredModel),
    thinkingLevel,
  }
}

export function applyResolvedBridgeModel(
  metadata: BridgeRunMetadata,
  resolvedModelId: string,
): BridgeRunMetadata {
  if (!resolvedModelId || resolvedModelId === metadata.modelId) return metadata
  return {
    ...metadata,
    modelId: resolvedModelId,
    modelName: resolvedModelId,
  }
}

export function formatBridgeThinkingLevel(level: AgentThinkingLevel): string {
  return THINKING_LEVEL_LABELS[level]
}

export function formatBridgeRunMetadataCompact(metadata: BridgeRunMetadata): string {
  return `模型 ${metadata.modelName} · 推理 ${formatBridgeThinkingLevel(metadata.thinkingLevel)}`
}

export function formatBridgeProcessingMessage(
  workspaceName: string,
  sessionTitle: string,
  metadata: BridgeRunMetadata,
): string {
  return `${workspaceName} → ${sessionTitle}: ⏳ Agent 处理中...\n${formatBridgeRunMetadataCompact(metadata)}`
}

export function appendBridgeRunMetadata(
  replyText: string,
  metadata: BridgeRunMetadata,
): string {
  return `${replyText.trimEnd()}\n\n— ${formatBridgeRunMetadataCompact(metadata)}`
}

export function formatBridgeRuntimeStatusLines(
  metadata: BridgeRunMetadata,
  markdown = false,
): string[] {
  const invalidSuffix = metadata.modelValid ? '' : '（已失效）'
  if (markdown) {
    return [
      `**模型**: ${metadata.channelName} / ${metadata.modelName}${invalidSuffix}`,
      `**推理强度**: ${formatBridgeThinkingLevel(metadata.thinkingLevel)}`,
    ]
  }
  return [
    `模型: ${metadata.channelName} / ${metadata.modelName}${invalidSuffix}`,
    `推理强度: ${formatBridgeThinkingLevel(metadata.thinkingLevel)}`,
  ]
}

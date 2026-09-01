import {
  DEEPSEEK_PRESET_MODELS,
  OPENCODE_GO_PRESET_MODELS,
  type ChannelModel,
  type ChannelModelCapabilities,
  type ProviderType,
} from '@domi/shared'

function findTemporaryAdaptationPreset(
  provider: ProviderType,
  modelId: string,
): ChannelModelCapabilities | undefined {
  const presets = provider === 'opencode-go-openai'
    ? OPENCODE_GO_PRESET_MODELS
    : provider === 'deepseek'
      ? DEEPSEEK_PRESET_MODELS
      : []
  return presets.find((model) => model.id === modelId)?.temporaryAdaptation
}

/**
 * 以供应商返回清单刷新渠道模型，同时保留用户选择与可管理临时适配。
 * 供应商元数据取当前响应；旧的供应商元数据不会在上游撤回后继续冒充权威数据。
 */
export function mergeFetchedChannelModels(input: {
  previous: readonly ChannelModel[]
  fetched: readonly ChannelModel[]
  provider: ProviderType
  enableAll?: boolean
}): ChannelModel[] {
  const fetchedIds = new Set(input.fetched.map((model) => model.id))
  const kept = input.previous.filter((model) => (
    model.source === 'manual' || model.temporaryAdaptation != null
  ) && !fetchedIds.has(model.id))
  const merged = input.fetched.map((fetchedModel) => {
    const previousModel = input.previous.find((model) => model.id === fetchedModel.id)
    const temporaryAdaptation = previousModel?.temporaryAdaptation
      ?? findTemporaryAdaptationPreset(input.provider, fetchedModel.id)
    return {
      ...(previousModel ?? {}),
      ...fetchedModel,
      enabled: input.enableAll ? true : previousModel?.enabled ?? false,
      providerMetadata: fetchedModel.providerMetadata,
      ...(temporaryAdaptation ? { temporaryAdaptation } : {}),
    }
  })
  return [...kept, ...merged]
}

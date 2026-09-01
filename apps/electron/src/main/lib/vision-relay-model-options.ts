import type { Channel, ChannelModel, ModelOption, ProviderType } from '@domi/shared'

export async function collectVisionRelayModelOptions(
  channels: readonly Channel[],
  resolveCapability: (
    provider: ProviderType,
    modelId: string,
    model?: ChannelModel,
  ) => Promise<'supported' | 'unsupported' | 'unknown'>,
): Promise<ModelOption[]> {
  const candidates = channels.flatMap((channel) => channel.enabled
    ? channel.models.filter((model) => model.enabled).map((model) => ({ channel, model }))
    : [])
  const capabilities = await Promise.all(candidates.map(({ channel, model }) => (
    resolveCapability(channel.provider, model.id, model)
  )))
  return candidates.flatMap(({ channel, model }, index) => capabilities[index] === 'supported'
    ? [{
        channelId: channel.id,
        channelName: channel.name,
        modelId: model.id,
        modelName: model.name,
        provider: channel.provider,
      }]
    : [])
}

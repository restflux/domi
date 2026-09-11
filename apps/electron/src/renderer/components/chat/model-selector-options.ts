import type { Channel, ModelOption, ProviderType } from '@domi/shared'

/** 从渠道列表构建扁平化的模型选项 */
export function buildModelOptions(
  channels: Channel[],
  filterChannelId?: string,
  filterChannelIds?: string[],
  excludedProviders?: readonly ProviderType[],
  allowedModelKeys?: readonly string[],
): ModelOption[] {
  const options: ModelOption[] = []
  const allowed = allowedModelKeys ? new Set(allowedModelKeys) : undefined

  for (const channel of channels) {
    if (!channel.enabled) continue
    if (filterChannelId && channel.id !== filterChannelId) continue
    if (filterChannelIds && !filterChannelIds.includes(channel.id)) continue
    if (excludedProviders?.includes(channel.provider)) continue

    for (const model of channel.models) {
      if (!model.enabled) continue
      if (allowed && !allowed.has(`${channel.id}\u0000${model.id}`)) continue

      options.push({
        channelId: channel.id,
        channelName: channel.name,
        modelId: model.id,
        modelName: model.name,
        provider: channel.provider,
      })
    }
  }

  return options
}

/** 按渠道分组模型选项 */
export function groupByChannel(options: ModelOption[]): Map<string, ModelOption[]> {
  const groups = new Map<string, ModelOption[]>()

  for (const option of options) {
    const key = option.channelId
    const group = groups.get(key) ?? []
    group.push(option)
    groups.set(key, group)
  }

  return groups
}

/** 搜索跨渠道；空搜索只展示调用方展开的渠道，隐藏模型不参与键盘导航。 */
export function getModelPickerGroups(
  grouped: Map<string, ModelOption[]>, search: string, expandedChannel: string | null,
): { groups: Map<string, ModelOption[]>; visibleOptions: ModelOption[] } {
  const query = search.trim().toLowerCase()
  const groups = new Map<string, ModelOption[]>()
  const visibleOptions: ModelOption[] = []
  for (const [channelId, options] of grouped) {
    const matches = query ? options.filter((option) =>
      option.modelName.toLowerCase().includes(query) ||
      option.modelId.toLowerCase().includes(query) ||
      option.channelName.toLowerCase().includes(query)) : options
    if (!matches.length) continue
    groups.set(channelId, matches)
    if (query || channelId === expandedChannel) visibleOptions.push(...matches)
  }
  return { groups, visibleOptions }
}

export function nextModelHighlight(index: number, length: number, direction: 'up' | 'down'): number {
  if (!length) return -1
  return direction === 'down' ? (index < length - 1 ? index + 1 : 0)
    : (index > 0 ? index - 1 : length - 1)
}

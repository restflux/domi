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

/** 仅在未设置别名时美化常见模型 ID；不改动真实 ID 和用户指定的名称。 */
export function getModelDisplayName(modelName: string, modelId: string): string {
  if (modelName && modelName !== modelId) return modelName
  const parts = modelId.split('-')
  if (parts.length < 2 || parts.some((part) => !/^[a-zA-Z0-9]+(?:\.[0-9]+)?$/.test(part))) {
    return modelName || modelId
  }

  const [family = '', version = '', ...rest] = parts
  const suffix = (part: string): string => /^[a-z]/i.test(part) ? part[0]!.toUpperCase() + part.slice(1) : part
  if (/^(gpt|glm)$/i.test(family) && /^\d/.test(version)) {
    return [family.toUpperCase() + '-' + version, ...rest.map(suffix)].join(' ')
  }
  if (/^kimi$/i.test(family) && /^k\d/i.test(version)) {
    return ['Kimi', suffix(version), ...rest.map(suffix)].join(' ')
  }
  return modelName || modelId
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

/** 所有渠道按顺序展示；搜索同时匹配模型及其所属渠道。 */
export function getModelPickerGroups(
  grouped: Map<string, ModelOption[]>, search: string,
): { groups: Map<string, ModelOption[]>; visibleOptions: ModelOption[] } {
  const query = search.trim().toLowerCase()
  const groups = new Map<string, ModelOption[]>()
  const visibleOptions: ModelOption[] = []
  for (const [channelId, options] of grouped) {
    const matches = query ? options.filter((option) =>
      option.modelName.toLowerCase().includes(query) ||
      getModelDisplayName(option.modelName, option.modelId).toLowerCase().includes(query) ||
      option.modelId.toLowerCase().includes(query) ||
      option.channelName.toLowerCase().includes(query)) : options
    if (!matches.length) continue
    groups.set(channelId, matches)
    visibleOptions.push(...matches)
  }
  return { groups, visibleOptions }
}

export function nextModelHighlight(index: number, length: number, direction: 'up' | 'down'): number {
  if (!length) return -1
  return direction === 'down' ? (index < length - 1 ? index + 1 : 0)
    : (index > 0 ? index - 1 : length - 1)
}

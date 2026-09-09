import type { Channel, ImageGenerationSelection } from '@domi/shared'

export function getImageChannels(channels: Channel[]): Channel[] {
  return channels.filter((channel) => channel.enabled
    && ['openai', 'openai-responses', 'google', 'custom'].includes(channel.provider)
    && Boolean(channel.imageGeneration?.models.length))
}

export function resolveImageSelection(channels: Channel[], preferred?: ImageGenerationSelection | null): ImageGenerationSelection | null {
  const eligible = getImageChannels(channels)
  if (preferred) {
    return eligible.some((channel) => channel.id === preferred.channelId && channel.imageGeneration?.models.includes(preferred.modelId))
      ? { ...preferred }
      : null
  }
  const first = eligible[0]
  return first ? { channelId: first.id, modelId: first.imageGeneration!.models[0]! } : null
}

/** /image 仅作为输入命令，不送入模型 prompt。 */
export function parseImageCommand(text: string): { requested: boolean; text: string } {
  const requested = /^\/image(?:\s|$)/i.test(text.trimStart())
  return { requested, text: requested ? text.trimStart().replace(/^\/image\s*/i, '') : text }
}

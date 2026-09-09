import { decryptApiKey, getChannelById } from '../channel-manager'
import { getSettings } from '../settings-service'
import { getToolCredentials } from '../chat-tool-config'
import { createImageGenerationResolver } from './config-core'

const resolver = createImageGenerationResolver({
  getDefaultSelection: () => getSettings().imageGeneration,
  getChannel: getChannelById,
  decryptKey: decryptApiKey,
  getLegacyCredentials: getToolCredentials,
})

export const resolveImageGenerationSelection = resolver.resolveSelection
export const resolveImageGenerationConfig = resolver.resolveConfig
export const isImageGenerationAvailable = resolver.isAvailable
export const getImageGenerationToolId = resolver.toolIdForSelection
export type { ImageGenerationConfig, ImageGenerationToolId } from './config-core'

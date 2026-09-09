import type { ImageGenerationSelection } from '@domi/shared'
import type { ImageGenerationConfig, ImageGenerationToolId } from './image-generation/config'
import { resolveImageGenerationConfig, resolveImageGenerationSelection } from './image-generation/config'

/** 失效的默认生图渠道不应阻断普通对话；显式选择必须报错而不能静默回退。 */
export function resolveRequestImageGeneration(selection?: ImageGenerationSelection): ImageGenerationSelection | undefined {
  if (selection !== undefined) return resolveImageGenerationSelection(selection)
  try {
    return resolveImageGenerationSelection()
  } catch {
    return undefined
  }
}

/** 只在内存里保留本次连接配置；不能进入消息、IPC 或日志。 */
export type PreparedImageGenerationConfigs = Record<ImageGenerationToolId, ImageGenerationConfig | null>

export function prepareImageGenerationConfigs(selection?: ImageGenerationSelection): PreparedImageGenerationConfigs {
  const capture = (toolId: ImageGenerationToolId): ImageGenerationConfig | null => {
    try { return resolveImageGenerationConfig(toolId, selection) } catch { return null }
  }
  return { 'gpt-image': capture('gpt-image'), 'nano-banana': capture('nano-banana') }
}

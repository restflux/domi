import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ImageGenerationSelection } from '@domi/shared'
import { isImageGenerationAvailable, resolveImageGenerationSelection, resolveImageGenerationConfig } from '../image-generation/config'
import { generateAgentImages } from '../image-generation/agent-result'
import { buildPiGptImageTool } from './gpt-image-agent-tool'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

/** 固定本轮用户选择，模型工具参数不能改选渠道或模型。 */
export function buildPiGptImageTools(
  sdk: PiSdk,
  sessionId: string,
  agentCwd?: string,
  selection?: ImageGenerationSelection,
): ToolDefinition[] {
  const selected = resolveImageGenerationSelection(selection)
  if (selected) resolveImageGenerationConfig('gpt-image', selected)
  else if (!isImageGenerationAvailable('gpt-image')) return []
  const legacyConfig = selected ? undefined : resolveImageGenerationConfig('gpt-image')
  return [buildPiGptImageTool(sdk, sessionId, agentCwd,
    (prompt, id, options) => generateAgentImages('gpt-image', selected, prompt, id, options, legacyConfig))]
}

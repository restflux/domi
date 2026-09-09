import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ImageGenerationSelection } from '@domi/shared'
import { isImageGenerationAvailable, resolveImageGenerationSelection, resolveImageGenerationConfig } from '../image-generation/config'
import { generateAgentImages } from '../image-generation/agent-result'
import { buildPiNanoBananaTool } from './nano-banana-agent-tool'
import { clearImageGenerationHistory } from '../image-generation/service'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

/** 固定本轮用户选择，模型工具参数不能改选渠道或模型。 */
export function buildPiNanoBananaTools(
  sdk: PiSdk,
  sessionId: string,
  agentCwd?: string,
  selection?: ImageGenerationSelection,
): ToolDefinition[] {
  const selected = resolveImageGenerationSelection(selection)
  if (selected) resolveImageGenerationConfig('nano-banana', selected)
  else if (!isImageGenerationAvailable('nano-banana')) return []
  const legacyConfig = selected ? undefined : resolveImageGenerationConfig('nano-banana')
  return [buildPiNanoBananaTool(sdk, sessionId, agentCwd,
    (prompt, id, options) => generateAgentImages('nano-banana', selected, prompt, id, options, legacyConfig))]
}

export function clearNanoBananaAgentHistory(sessionId: string): void {
  clearImageGenerationHistory(sessionId)
}

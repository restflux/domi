import type { AgentSessionMeta } from '@domi/shared'
import type { AppSettings } from '../../types'
import { resolvePiReasoningCapability } from './adapters/pi-model-registry'
import { resolvePiThinkingLevel } from './agent-thinking-level'
import {
  resolveBridgeRunMetadataWithDependencies,
  type BridgeRunMetadata,
} from './bridge-run-metadata'
import { redactSensitiveLogValue } from './bridge-log-redaction'
import { getChannelById } from './channel-manager'
import { getSettings } from './settings-service'

interface ResolveCurrentBridgeRunMetadataInput {
  channelId?: string
  modelId?: string
  sessionMeta?: Pick<AgentSessionMeta, 'reasoningLevel' | 'openAIThinkingLevel'>
  settings?: AppSettings
}

/** 解析 Bridge 当前/下一轮实际使用的模型和推理档位。 */
export function resolveBridgeRunMetadata(
  input: ResolveCurrentBridgeRunMetadataInput,
): Promise<BridgeRunMetadata> {
  return resolveBridgeRunMetadataWithDependencies(
    {
      ...input,
      settings: input.settings ?? getSettings(),
    },
    {
      getChannel: getChannelById,
      resolveReasoningCapability: resolvePiReasoningCapability,
      resolveThinkingLevel: resolvePiThinkingLevel,
      onCapabilityError: (error) => {
        console.warn(
          '[IM Bridge] 解析模型推理能力失败，使用会话配置降级:',
          redactSensitiveLogValue(error),
        )
      },
    },
  )
}

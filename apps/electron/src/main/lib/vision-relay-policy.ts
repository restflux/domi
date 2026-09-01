export type PiImageInputCapability = 'supported' | 'unsupported' | 'unknown'

export interface VisionRelayConfigurationLike {
  enabled?: boolean
  channelId?: string
  modelId?: string
  authorizationVersion?: string
}

export type VisionRelayTrigger = 'user' | 'automation' | 'delegation'

export function isVisionRelaySourceEligible(capability: PiImageInputCapability): boolean {
  return capability === 'unsupported'
}

export function isVisionRelayTargetEligible(capability: PiImageInputCapability): boolean {
  return capability === 'supported'
}

export function isVisionRelayConfigured(configured: VisionRelayConfigurationLike | undefined): boolean {
  return Boolean(
    configured?.enabled
    && configured.channelId?.trim()
    && configured.modelId?.trim()
    && configured.authorizationVersion?.trim(),
  )
}

export function shouldExposeVisionRelay(input: {
  configured: VisionRelayConfigurationLike | undefined
  sourceCapability: PiImageInputCapability
  triggeredBy?: VisionRelayTrigger
}): boolean {
  return input.triggeredBy === 'user'
    && isVisionRelayConfigured(input.configured)
    && isVisionRelaySourceEligible(input.sourceCapability)
}

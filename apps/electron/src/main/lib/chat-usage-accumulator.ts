import type { StreamUsageEvent } from '@domi/core'

export interface ChatUsageAccumulator {
  providerRequestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  hasProviderUsage: boolean
}

export function createChatUsageAccumulator(): ChatUsageAccumulator {
  return {
    providerRequestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    hasProviderUsage: false,
  }
}

/** 每次实际进入 streamSSE 都代表一次 provider/API 请求。 */
export function addChatProviderRequest(usage: ChatUsageAccumulator): ChatUsageAccumulator {
  return { ...usage, providerRequestCount: usage.providerRequestCount + 1 }
}

/** 合并 provider 在流末尾返回的本次请求用量；缺失 usage 不影响请求计数。 */
export function mergeChatProviderUsage(
  usage: ChatUsageAccumulator,
  providerUsage: StreamUsageEvent | undefined,
): ChatUsageAccumulator {
  if (!providerUsage) return usage
  const inputTokens = providerUsage.inputTokens ?? 0
  const outputTokens = providerUsage.outputTokens ?? 0
  const hasProviderUsage = usage.hasProviderUsage || inputTokens > 0 || outputTokens > 0
  return {
    ...usage,
    inputTokens: usage.inputTokens + Math.max(0, inputTokens),
    outputTokens: usage.outputTokens + Math.max(0, outputTokens),
    cacheReadTokens: usage.cacheReadTokens + Math.max(0, providerUsage.cacheReadTokens ?? 0),
    cacheCreationTokens: usage.cacheCreationTokens + Math.max(0, providerUsage.cacheCreationTokens ?? 0),
    hasProviderUsage,
  }
}

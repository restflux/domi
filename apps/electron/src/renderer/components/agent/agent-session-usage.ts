import type { SDKMessage, SDKResultMessage, UsageProviderRequestCoverage } from '@domi/shared'

export interface AgentSessionUsageSnapshot {
  /** 输入总量：非缓存输入 + 缓存读取 + 缓存写入。 */
  inputTokens: number
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** 已统计的 provider 请求数下限。 */
  providerRequestCount: number
  providerRequestCoverage: UsageProviderRequestCoverage
}

function formatCompactTokenUnit(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}

export function formatAgentUsageTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '—'
  if (tokens >= 1_000_000) return `${formatCompactTokenUnit(tokens / 1_000_000)}m tok`
  if (tokens >= 1_000) return `${formatCompactTokenUnit(tokens / 1_000)}k tok`
  return `${Math.round(tokens).toLocaleString()} tok`
}

function readNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * 汇总当前会话已经持久化的真实 provider result usage。
 * renderer 实时估算与 assistant 镜像不进入累计，避免同一轮在落盘前后重复计数。
 */
export function calculateAgentSessionUsage(messages: readonly SDKMessage[]): AgentSessionUsageSnapshot {
  let inputTokens = 0
  let uncachedInputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheCreationTokens = 0
  let providerRequestCount = 0
  let exactEntries = 0
  let partialEntries = 0

  for (const message of messages) {
    if (message.type !== 'result') continue
    const result = message as SDKResultMessage
    if (result.isSyntheticCompactionResult) continue
    const rawInput = readNonNegative(result.usage?.input_tokens)
    const output = readNonNegative(result.usage?.output_tokens)
    const cacheRead = readNonNegative(result.usage?.cache_read_input_tokens) ?? 0
    const cacheCreation = readNonNegative(result.usage?.cache_creation_input_tokens) ?? 0
    if (rawInput == null || output == null) continue

    uncachedInputTokens += rawInput
    cacheReadTokens += cacheRead
    cacheCreationTokens += cacheCreation
    inputTokens += rawInput + cacheRead + cacheCreation
    outputTokens += output

    const requestCount = Number.isSafeInteger(result._providerRequestCount) && (result._providerRequestCount ?? 0) > 0
      ? result._providerRequestCount!
      : 1
    providerRequestCount += requestCount
    if (result._providerRequestCountAccuracy === 'exact') exactEntries += 1
    else partialEntries += 1
  }

  const providerRequestCoverage: UsageProviderRequestCoverage = providerRequestCount === 0
    ? 'none'
    : partialEntries === 0 && exactEntries > 0
      ? 'complete'
      : 'partial'

  return {
    inputTokens,
    uncachedInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    providerRequestCount,
    providerRequestCoverage,
  }
}

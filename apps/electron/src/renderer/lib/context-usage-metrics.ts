export interface ContextUsageMetricsInput {
  inputTokens: number
  contextWindow?: number
  compactThreshold?: number
}

export interface ContextUsageMetrics {
  remainingContextTokens?: number
  remainingUntilCompactionTokens?: number
}

/** 生成上下文用量面板需要的窗口与压缩余量。 */
export function buildContextUsageMetrics({
  inputTokens,
  contextWindow,
  compactThreshold,
}: ContextUsageMetricsInput): ContextUsageMetrics {
  return {
    ...(contextWindow != null
      ? { remainingContextTokens: Math.max(0, contextWindow - inputTokens) }
      : {}),
    ...(compactThreshold != null
      ? { remainingUntilCompactionTokens: Math.max(0, compactThreshold - inputTokens) }
      : {}),
  }
}

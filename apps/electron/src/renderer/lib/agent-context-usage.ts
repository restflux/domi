import type { AgentStreamState } from '@/atoms/agent-atoms'
import type {
  AgentRuntime,
  AgentContextBreakdown,
  ContextWindowSource,
  ProviderType,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from '@domi/shared'
import {
  getSDKCompactStatus,
  inferAgentSdkContextWindow,
  inferContextWindow,
  resolveSDKResultContextWindow,
} from '@domi/shared'

export interface AgentContextUsageTarget {
  runtime: AgentRuntime
  channelId?: string
  modelId?: string
  provider?: ProviderType
}

export interface AgentContextUsageSnapshot {
  inputTokens: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number
  contextBreakdown?: AgentContextBreakdown
  contextWindow?: number
  contextWindowSource?: ContextWindowSource
}

export interface AgentSessionCacheMetrics {
  /** 会话内可统计 provider request 的输入 Token 加权总和。 */
  inputTokens: number
  /** 会话内可统计 provider request 的缓存读取 Token 加权总和。 */
  cacheReadTokens: number
  /** cacheReadTokens / inputTokens；不是每轮百分比的算术平均。无有效样本时为空。 */
  hitRate?: number
  /** 缓存明细完整且数据有效的请求数。 */
  measuredRequests: number
  /** 发现了 usage 的顶层 final provider request 总数。 */
  totalRequests: number
}

export interface RestoredAgentContextUsage {
  inputTokens: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number
  contextBreakdown?: AgentContextBreakdown
  contextWindow?: number
  contextWindowSource?: ContextWindowSource
  contextWindowOwner: string
  contextUsageIsEstimated: boolean
  model?: string
}

export function mergeStableAgentContextUsageSnapshot(
  previous: AgentContextUsageSnapshot | null,
  current: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    costUsd?: number
    contextBreakdown?: AgentContextBreakdown
    contextWindow?: number
    contextWindowSource?: ContextWindowSource
    contextUsageInvalidated?: boolean
  },
): AgentContextUsageSnapshot | null {
  if (current.contextUsageInvalidated) return null
  if (current.inputTokens == null || current.inputTokens <= 0) return previous
  return {
    inputTokens: current.inputTokens,
    outputTokens: current.outputTokens,
    cacheReadTokens: current.cacheReadTokens,
    cacheCreationTokens: current.cacheCreationTokens,
    costUsd: current.costUsd,
    contextBreakdown: current.contextBreakdown,
    contextWindow: current.contextWindow,
    contextWindowSource: current.contextWindowSource,
  }
}

export function formatAgentContextUsageSummary(
  inputTokens: number | undefined,
  contextWindow: number | undefined,
): { text: string; percentage?: string } {
  const formatThousands = (tokens: number): string => `${Math.round(tokens / 1000)}k`
  const hasUsage = inputTokens != null && inputTokens > 0
  const text = `${hasUsage ? formatThousands(inputTokens) : '—'}${
    contextWindow != null ? ` / ${formatThousands(contextWindow)}` : ''
  }`
  return {
    text,
    ...(hasUsage && contextWindow != null && contextWindow > 0
      ? { percentage: `${((inputTokens / contextWindow) * 100).toFixed(0)}%` }
      : {}),
  }
}

export type IdleContextUsageMergeDecision =
  | 'preserve_running'
  | 'hydrate_running'
  | 'preserve_live'
  | 'restore_history'
  | 'preserve_shell'
  | 'clear'

export function decideIdleContextUsageMerge(input: {
  state?: {
    running: boolean
    inputTokens?: number
    contextUsageOrigin?: 'live' | 'history'
    contextUsageInvalidated?: boolean
    contextWindowOwner?: string
    backgroundWaiting?: boolean
    contextCompaction?: unknown
  }
  restoredUsage?: RestoredAgentContextUsage
  currentOwner: string
}): IdleContextUsageMergeDecision {
  const { state, restoredUsage, currentOwner } = input
  // 压缩事件已明确判定旧 usage 失效时，消息缓存中的旧快照可能尚未写入压缩边界；
  // 失效信号优先，不能被这段短暂滞后的历史快照重新水合成压缩前高占用。
  if (state?.contextUsageInvalidated) {
    return state.running ? 'preserve_running' : 'preserve_shell'
  }
  if (state?.running) {
    const ownerMatches = state.contextWindowOwner == null
      || state.contextWindowOwner === currentOwner
    const restoredMatches = restoredUsage?.contextWindowOwner === currentOwner
    return (state.inputTokens == null || state.inputTokens <= 0)
      && ownerMatches
      && restoredMatches
      ? 'hydrate_running'
      : 'preserve_running'
  }
  if (
    state?.inputTokens !== undefined
    && state.contextUsageOrigin === 'live'
    && state.contextWindowOwner === currentOwner
  ) {
    return 'preserve_live'
  }
  if (restoredUsage) return 'restore_history'
  if (state?.backgroundWaiting || state?.contextCompaction) return 'preserve_shell'
  return 'clear'
}

/** 将历史 usage 合并进当前流状态；运行态仅补缺失 usage，不覆盖实时输出与工具进度。 */
export function mergeAgentContextUsageHydrationState(input: {
  state?: AgentStreamState
  restoredUsage?: RestoredAgentContextUsage
  currentOwner: string
}): AgentStreamState | undefined {
  const { state, restoredUsage, currentOwner } = input
  const decision = decideIdleContextUsageMerge({ state, restoredUsage, currentOwner })

  if (decision === 'preserve_running') return state
  if (decision === 'hydrate_running' && state && restoredUsage) {
    return {
      ...state,
      ...restoredUsage,
      running: true,
      contextUsageOrigin: 'history',
      contextUsageInvalidated: false,
    }
  }
  if (decision === 'preserve_live' && state) {
    return {
      ...state,
      running: false,
      toolActivities: [],
    }
  }
  if (decision === 'restore_history' && restoredUsage) {
    return {
      running: false,
      backgroundWaiting: state?.backgroundWaiting,
      toolActivities: [],
      ...restoredUsage,
      contextUsageOrigin: 'history',
      contextUsageInvalidated: false,
      contextCompaction: state?.contextCompaction,
    }
  }
  if (decision === 'preserve_shell' && state) {
    return {
      running: false,
      backgroundWaiting: state.backgroundWaiting,
      toolActivities: [],
      contextCompaction: state.contextCompaction,
      contextUsageInvalidated: state.contextUsageInvalidated,
    }
  }
  return undefined
}

export function buildAgentContextWindowOwner(
  runtime: AgentRuntime,
  channelId: string | undefined,
  modelId: string | undefined,
): string {
  return `${runtime}:${channelId ?? ''}:${modelId ?? ''}`
}

export function resolveRunContextWindow(
  modelId: string | undefined,
  provider: ProviderType | undefined,
  previous: number | undefined,
  previousOwner: string | undefined,
  currentOwner: string,
): number | undefined {
  if (previous != null && previousOwner === currentOwner) return previous
  return provider
    ? inferAgentSdkContextWindow(modelId, provider)
    : inferContextWindow(modelId)
}

interface CacheUsageFields {
  input_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

function sumInputTokens(usage: CacheUsageFields): number {
  return usage.input_tokens
    + (usage.cache_read_input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
}

function stableUsageMessageKey(message: SDKMessage): string {
  const record = message as Record<string, unknown>
  if (typeof record.uuid === 'string' && record.uuid.length > 0) {
    return `${message.type}:uuid:${record.uuid}`
  }
  if (message.type === 'result') {
    const result = message as SDKResultMessage
    return `result:${result.session_id ?? ''}:${result.subtype}:${result.terminal_reason ?? ''}:${JSON.stringify(result.usage ?? null)}`
  }
  if (message.type === 'assistant') {
    const assistant = message as SDKAssistantMessage
    return `assistant:${assistant.session_id ?? ''}:${assistant.parent_tool_use_id ?? ''}:${JSON.stringify(assistant.message?.usage ?? null)}:${JSON.stringify(assistant.message?.content ?? null)}`
  }
  return `${message.type}:${JSON.stringify(record)}`
}

/**
 * 历史刷新完成前 persisted/live 尾部可能短暂重叠。只消除两个序列边界上的有序重叠，
 * 不按内容全局去重，避免误删会话中两次内容与 usage 恰好相同的真实请求。
 */
function mergeUsageMessageSequences(
  persistedMessages: readonly SDKMessage[],
  liveMessages: readonly SDKMessage[],
): SDKMessage[] {
  if (persistedMessages.length === 0) return [...liveMessages]
  if (liveMessages.length === 0) return [...persistedMessages]

  let overlap = Math.min(persistedMessages.length, liveMessages.length)
  for (; overlap > 0; overlap--) {
    const persistedStart = persistedMessages.length - overlap
    const liveStart = liveMessages.length - overlap
    let matches = true
    for (let index = 0; index < overlap; index++) {
      if (stableUsageMessageKey(persistedMessages[persistedStart + index]!)
        !== stableUsageMessageKey(liveMessages[liveStart + index]!)) {
        matches = false
        break
      }
    }
    if (matches) break
  }

  return overlap > 0
    ? [...persistedMessages.slice(0, persistedMessages.length - overlap), ...liveMessages]
    : [...persistedMessages, ...liveMessages]
}

function readReliableCacheUsage(usage: CacheUsageFields | undefined): {
  inputTokens: number
  cacheReadTokens: number
} | undefined {
  if (
    !usage
    || usage.cache_read_input_tokens == null
    || usage.cache_creation_input_tokens == null
  ) return undefined
  const rawInput = usage.input_tokens
  const cacheRead = usage.cache_read_input_tokens
  const cacheCreation = usage.cache_creation_input_tokens
  if (
    !Number.isFinite(rawInput)
    || !Number.isFinite(cacheRead)
    || !Number.isFinite(cacheCreation)
    || rawInput < 0
    || cacheRead < 0
    || cacheCreation < 0
  ) return undefined
  const inputTokens = rawInput + cacheRead + cacheCreation
  if (!Number.isFinite(inputTokens) || inputTokens <= 0 || cacheRead > inputTokens) return undefined
  return { inputTokens, cacheReadTokens: cacheRead }
}

/**
 * 从会话消息计算 Token 加权缓存命中率。
 *
 * - 正常 Pi turn 使用每个顶层 final assistant 的 request usage，覆盖工具循环中的多次 provider call。
 * - 没有 assistant usage 的兼容端点，才使用该 turn 唯一 result 的聚合 usage 兜底。
 * - result 与 assistant 不会同时计入；partial、子 Agent 消息、合成压缩 result 均忽略。
 * - 缺缓存明细或数据异常的请求只降低统计覆盖率，不会抹掉会话内其他有效样本。
 */
export function calculateAgentSessionCacheMetrics(
  persistedMessages: readonly SDKMessage[],
  liveMessages: readonly SDKMessage[] = [],
): AgentSessionCacheMetrics {
  const messages = mergeUsageMessageSequences(persistedMessages, liveMessages)
  let totalInputTokens = 0
  let totalCacheReadTokens = 0
  let measuredRequests = 0
  let totalRequests = 0
  let turnAssistantCandidates = 0
  let turnMeasuredRequests = 0
  let turnAssistantInputTokens = 0
  let turnAssistantCacheReadTokens = 0

  const addMeasuredUsage = (usage: CacheUsageFields): void => {
    const reliable = readReliableCacheUsage(usage)
    if (!reliable) return
    totalInputTokens += reliable.inputTokens
    totalCacheReadTokens += reliable.cacheReadTokens
    measuredRequests++
  }
  const commitAssistantTurn = (): void => {
    totalRequests += turnAssistantCandidates
    measuredRequests += turnMeasuredRequests
    totalInputTokens += turnAssistantInputTokens
    totalCacheReadTokens += turnAssistantCacheReadTokens
    turnAssistantCandidates = 0
    turnMeasuredRequests = 0
    turnAssistantInputTokens = 0
    turnAssistantCacheReadTokens = 0
  }

  for (const message of messages) {
    if (message.type === 'assistant') {
      const assistant = message as SDKAssistantMessage
      const record = assistant as unknown as Record<string, unknown>
      if (assistant.parent_tool_use_id || assistant.isReplay || record._partial === true || !assistant.message?.usage) continue
      turnAssistantCandidates++
      const reliable = readReliableCacheUsage(assistant.message.usage as CacheUsageFields)
      if (reliable) {
        turnMeasuredRequests++
        turnAssistantInputTokens += reliable.inputTokens
        turnAssistantCacheReadTokens += reliable.cacheReadTokens
      }
      continue
    }

    if (!isUsableResult(message)) continue
    if (turnAssistantCandidates > 0) {
      commitAssistantTurn()
    } else if (message.usage) {
      totalRequests++
      addMeasuredUsage(message.usage)
    }
  }

  if (turnAssistantCandidates > 0) commitAssistantTurn()
  const hitRate = measuredRequests > 0
    && totalInputTokens > 0
    && totalCacheReadTokens <= totalInputTokens
    ? totalCacheReadTokens / totalInputTokens
    : undefined
  return {
    inputTokens: totalInputTokens,
    cacheReadTokens: totalCacheReadTokens,
    hitRate,
    measuredRequests,
    totalRequests,
  }
}

function isUsableResult(message: SDKMessage): message is SDKResultMessage {
  return message.type === 'result'
    && !(message as SDKResultMessage).isSyntheticCompactionResult
}

function findLatestResultIndex(messages: SDKMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message && isUsableResult(message)) return index
  }
  return -1
}

function findLatestAssistantWithUsage(
  messages: SDKMessage[],
  startIndex: number,
  endIndex: number,
): { index: number; message: SDKAssistantMessage } | undefined {
  for (let index = endIndex; index >= startIndex; index--) {
    const message = messages[index]
    if (!message || message.type !== 'assistant') continue
    const assistant = message as SDKAssistantMessage
    if (assistant.parent_tool_use_id || !assistant.message?.usage || assistant.error) continue
    return { index, message: assistant }
  }
  return undefined
}

function findLatestSuccessfulCompaction(
  messages: SDKMessage[],
  afterIndex: number,
): { estimatedTokensAfter?: number } | undefined {
  for (let index = messages.length - 1; index > afterIndex; index--) {
    const message = messages[index]
    if (!message || message.type !== 'system') continue
    const system = message as SDKSystemMessage
    if (getSDKCompactStatus(system) !== 'success') continue
    return system.compactionEstimatedTokensAfter != null && system.compactionEstimatedTokensAfter > 0
      ? { estimatedTokensAfter: system.compactionEstimatedTokensAfter }
      : {}
  }
  return undefined
}

function matchesTarget(
  historicalModelId: string | undefined,
  historicalProvider: ProviderType | undefined,
  historicalChannelId: string | undefined,
  historicalRuntime: AgentRuntime | undefined,
  target: AgentContextUsageTarget,
): boolean {
  if (
    historicalModelId
    && target.modelId
    && historicalModelId.toLowerCase() !== target.modelId.toLowerCase()
  ) {
    return false
  }
  if (historicalProvider && target.provider && historicalProvider !== target.provider) {
    return false
  }
  if (historicalChannelId && target.channelId && historicalChannelId !== target.channelId) {
    return false
  }
  if (historicalRuntime && historicalRuntime !== target.runtime) {
    return false
  }
  return true
}

/**
 * 从已持久化的 SDK 消息恢复历史会话最近一次上下文用量。
 *
 * assistant usage 代表当前上下文，优先于 result 的整轮聚合 usage；仅在兼容端点
 * 没有 assistant usage 时使用 result 兜底。若 usage 后发生成功压缩，则恢复压缩后的
 * token 估算值，避免重启后重新显示压缩前的高占用。
 */
export function restoreAgentContextUsageFromMessages(
  messages: SDKMessage[],
  target: AgentContextUsageTarget,
): RestoredAgentContextUsage | undefined {
  const resultIndex = findLatestResultIndex(messages)
  const latestResult = resultIndex >= 0
    ? messages[resultIndex] as SDKResultMessage | undefined
    : undefined
  const latestAssistantMatch = findLatestAssistantWithUsage(messages, 0, messages.length - 1)
  const hasNewerIncompleteTurn = latestAssistantMatch != null && latestAssistantMatch.index > resultIndex
  const result = hasNewerIncompleteTurn ? undefined : latestResult

  let assistantMatch = latestAssistantMatch
  if (result) {
    let assistantStartIndex = 0
    for (let index = resultIndex - 1; index >= 0; index--) {
      const message = messages[index]
      if (message && isUsableResult(message)) {
        assistantStartIndex = index + 1
        break
      }
    }
    assistantMatch = findLatestAssistantWithUsage(
      messages,
      assistantStartIndex,
      resultIndex - 1,
    )
  }
  const assistant = assistantMatch?.message
  const assistantUsage = assistant?.message.usage
  const resultUsage = result?.usage
  const usage = assistantUsage ?? resultUsage
  if (!usage) return undefined

  const historicalModelId = result?._channelModelId
    ?? assistant?._channelModelId
    ?? assistant?.message.model
  const historicalProvider = result?._channelProvider ?? assistant?._channelProvider
  const historicalChannelId = result?._channelId ?? assistant?._channelId
  const historicalRuntime = result?._agentRuntime ?? assistant?._agentRuntime
  if (!matchesTarget(
    historicalModelId,
    historicalProvider,
    historicalChannelId,
    historicalRuntime,
    target,
  )) return undefined

  const resolvedResultWindow = result ? resolveSDKResultContextWindow(result) : undefined
  const fallbackModelId = historicalModelId ?? target.modelId
  const fallbackProvider = historicalProvider ?? target.provider
  const fallbackWindow = fallbackProvider
    ? inferAgentSdkContextWindow(fallbackModelId, fallbackProvider)
    : inferContextWindow(fallbackModelId)
  const persistedContextWindow = result?._contextWindow ?? assistant?._contextWindow
  const persistedContextWindowSource = result?._contextWindowSource ?? assistant?._contextWindowSource
  const contextWindow = resolvedResultWindow?.contextWindow ?? persistedContextWindow ?? fallbackWindow
  const contextWindowSource = resolvedResultWindow?.source
    ?? (persistedContextWindow != null ? persistedContextWindowSource ?? 'runtime' : undefined)
    ?? (contextWindow != null ? 'name_fallback' : undefined)
  const contextBreakdown = result?._contextBreakdown ?? assistant?._contextBreakdown

  // result 仅提供窗口/成本元数据时，真正的上下文 usage 仍来自 assistant；自动压缩边界
  // 会先于同一 run 的最终 result 到达，因此必须从 assistant 位置开始寻找后续压缩。
  const usageIndex = assistantUsage ? assistantMatch?.index ?? -1 : resultIndex
  const successfulCompaction = findLatestSuccessfulCompaction(messages, usageIndex)
  // 成功压缩会立即使旧 assistant usage 失效。旧版本未持久化自动压缩后的预估值时，
  // 宁可隐藏占用等待下一次真实 usage，也不能恢复压缩前的高占用。
  if (successfulCompaction && successfulCompaction.estimatedTokensAfter == null) return undefined
  const compactionEstimate = successfulCompaction?.estimatedTokensAfter
  const contextWindowOwner = buildAgentContextWindowOwner(
    target.runtime,
    target.channelId,
    target.modelId,
  )

  if (compactionEstimate != null) {
    return {
      inputTokens: compactionEstimate,
      costUsd: result?.total_cost_usd,
      contextWindow,
      contextWindowSource,
      contextWindowOwner,
      contextUsageIsEstimated: true,
      model: target.modelId ?? historicalModelId,
    }
  }

  return {
    inputTokens: sumInputTokens(usage),
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheCreationTokens: usage.cache_creation_input_tokens,
    costUsd: result?.total_cost_usd,
    ...(contextBreakdown && { contextBreakdown }),
    contextWindow,
    contextWindowSource,
    contextWindowOwner,
    contextUsageIsEstimated: false,
    model: target.modelId ?? historicalModelId,
  }
}

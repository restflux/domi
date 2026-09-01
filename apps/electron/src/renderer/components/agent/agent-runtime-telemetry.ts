import * as React from 'react'
import type { SDKAssistantMessage, SDKMessage } from '@domi/shared'
import type { AgentStreamState, ToolActivity } from '@/atoms/agent-atoms'
import { getToolPhrase } from './tool-phrase'

const TOKEN_RATE_WINDOW_MS = 3_000
const TOKEN_RATE_STALE_MS = 1_250
const TOKEN_RATE_MIN_SAMPLE_MS = 250

export type AgentRuntimePhaseKind = 'preparing' | 'thinking' | 'responding' | 'tool' | 'compacting'

export interface AgentRuntimePhase {
  kind: AgentRuntimePhaseKind
  label: string
  detail?: string
}

export interface AgentRuntimeOutputSnapshot {
  estimatedTextTokens: number
  hasTextOutput: boolean
  latestBlockKind: 'text' | 'thinking' | 'tool' | null
}

export interface AgentTokenRateSample {
  at: number
  tokens: number
}

export interface AgentRuntimeProviderUsageSnapshot {
  inputTokens: number
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  providerRequestCount: number
}

export interface AgentRuntimeTelemetry {
  phase: AgentRuntimePhase
  elapsedSeconds: number
  /** 当前 run 已结算 provider 调用的输入总量（含缓存读写）。 */
  inputTokens: number | null
  /** 当前 run 已生成的输出 token；provider usage 可用时优先使用真实值，否则使用文本流估算。 */
  outputTokens: number | null
  outputTokensEstimated: boolean
  cacheReadTokens: number
  cacheCreationTokens: number
  providerRequestCount: number
  tokensPerSecond: number | null
}

export interface AgentRuntimeSummary {
  runStartedAt: number
  elapsedSeconds: number
  inputTokens: number | null
  outputTokens: number | null
  outputTokensEstimated: boolean
  cacheReadTokens: number
  cacheCreationTokens: number
  providerRequestCount: number
}

export interface AgentRuntimeRailUiState {
  activeRunStartedAt: number | undefined
  summary: AgentRuntimeSummary | null
}

export type AgentRuntimeRailAction =
  | { type: 'reset'; activeRunStartedAt: number | undefined }
  | { type: 'new_run'; startedAt: number }
  | { type: 'complete_run'; summary: AgentRuntimeSummary }
  | { type: 'provider_usage'; startedAt: number | undefined; usage: AgentRuntimeProviderUsageSnapshot }
  | { type: 'dismiss_summary' }

export interface AgentRuntimeRailState {
  summary: AgentRuntimeSummary | null
  captureTelemetry: (telemetry: AgentRuntimeTelemetry) => void
  dismissSummary: () => void
}

interface AgentRuntimeTextEstimate {
  text: string
  tokens: number
}

export interface AgentRuntimeOutputEstimateState {
  runStartedAt: number | undefined
  textBlocks: Map<string, AgentRuntimeTextEstimate>
}

export function reduceAgentRuntimeRailState(
  state: AgentRuntimeRailUiState,
  action: AgentRuntimeRailAction,
): AgentRuntimeRailUiState {
  switch (action.type) {
    case 'reset':
      return { activeRunStartedAt: action.activeRunStartedAt, summary: null }
    case 'new_run':
      if (state.activeRunStartedAt === action.startedAt) return state
      return { activeRunStartedAt: action.startedAt, summary: null }
    case 'complete_run':
      if (state.activeRunStartedAt !== action.summary.runStartedAt) return state
      return { ...state, activeRunStartedAt: undefined, summary: action.summary }
    case 'provider_usage': {
      const summary = state.summary
      if (!summary || action.usage.providerRequestCount <= 0) return state
      if (action.startedAt !== undefined && summary.runStartedAt !== action.startedAt) return state
      return {
        ...state,
        summary: {
          ...summary,
          inputTokens: action.usage.inputTokens,
          outputTokens: action.usage.outputTokens,
          outputTokensEstimated: false,
          cacheReadTokens: action.usage.cacheReadTokens,
          cacheCreationTokens: action.usage.cacheCreationTokens,
          providerRequestCount: action.usage.providerRequestCount,
        },
      }
    }
    case 'dismiss_summary':
      return state.summary ? { ...state, summary: null } : state
  }
}

function isCjkOrEmoji(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u.test(value)
}

/**
 * Renderer-only short-window estimate used while provider usage is not yet available.
 * CJK and emoji are weighted near one token; other visible characters use the common
 * four-characters-per-token approximation. Final usage remains authoritative elsewhere.
 */
export function estimateStreamingTextTokens(text: string): number {
  let estimated = 0
  for (const character of text) {
    if (/\s/u.test(character)) continue
    estimated += isCjkOrEmoji(character) ? 1 : 0.25
  }
  return estimated
}

export function updateAgentRuntimeOutputEstimate(
  messages: readonly SDKMessage[],
  runStartedAt: number | undefined,
  previous: AgentRuntimeOutputEstimateState = { runStartedAt: undefined, textBlocks: new Map() },
): { snapshot: AgentRuntimeOutputSnapshot; state: AgentRuntimeOutputEstimateState } {
  let estimatedTextTokens = 0
  let hasTextOutput = false
  let latestBlockKind: AgentRuntimeOutputSnapshot['latestBlockKind'] = null
  const textBlocks = new Map<string, AgentRuntimeTextEstimate>()
  const canReusePrevious = previous.runStartedAt === runStartedAt

  if (runStartedAt === undefined) {
    return {
      snapshot: { estimatedTextTokens, hasTextOutput, latestBlockKind },
      state: { runStartedAt, textBlocks },
    }
  }

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]
    if (message?.type !== 'assistant') continue
    const record = message as SDKAssistantMessage & { _domiLiveRunStartedAt?: number; uuid?: string }
    if (record._domiLiveRunStartedAt !== runStartedAt) continue

    for (let blockIndex = 0; blockIndex < record.message.content.length; blockIndex += 1) {
      const block = record.message.content[blockIndex]
      if (!block) continue
      if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
        if (block.text.length === 0) continue
        hasTextOutput = true
        latestBlockKind = 'text'
        // final assistant 的输出由 provider usage 结算；这里只估算尚未结算的文本，避免重复。
        const shouldEstimate = (record as { _partial?: boolean })._partial === true || !record.message.usage
        if (!shouldEstimate) continue
        const cacheKey = `${record.uuid ?? messageIndex}:${blockIndex}`
        const priorBlock = canReusePrevious ? previous.textBlocks.get(cacheKey) : undefined
        const tokens = priorBlock && block.text.startsWith(priorBlock.text)
          ? priorBlock.tokens + estimateStreamingTextTokens(block.text.slice(priorBlock.text.length))
          : estimateStreamingTextTokens(block.text)
        textBlocks.set(cacheKey, { text: block.text, tokens })
        estimatedTextTokens += tokens
      } else if (block.type === 'thinking' && 'thinking' in block && typeof block.thinking === 'string') {
        if (block.thinking.length > 0) latestBlockKind = 'thinking'
      } else if (block.type === 'tool_use') {
        latestBlockKind = 'tool'
      }
    }
  }

  return {
    snapshot: { estimatedTextTokens, hasTextOutput, latestBlockKind },
    state: { runStartedAt, textBlocks },
  }
}

export function getAgentRuntimeOutputSnapshot(
  messages: readonly SDKMessage[],
  runStartedAt: number | undefined,
): AgentRuntimeOutputSnapshot {
  return updateAgentRuntimeOutputEstimate(messages, runStartedAt).snapshot
}

/** 逐条聚合当前 run 已 final 的顶层 assistant provider usage。 */
export function getAgentRuntimeProviderUsageSnapshot(
  messages: readonly SDKMessage[],
  runStartedAt: number | undefined,
): AgentRuntimeProviderUsageSnapshot {
  const snapshot: AgentRuntimeProviderUsageSnapshot = {
    inputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    providerRequestCount: 0,
  }
  if (runStartedAt === undefined) return snapshot

  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const assistant = message as SDKAssistantMessage & { _domiLiveRunStartedAt?: number; _partial?: boolean }
    if (
      assistant._domiLiveRunStartedAt !== runStartedAt
      || assistant._partial === true
      || assistant.parent_tool_use_id
      || assistant.isReplay
      || !assistant.message.usage
    ) continue
    const usage = assistant.message.usage
    const uncached = usage.input_tokens
    const output = usage.output_tokens ?? 0
    const cacheRead = usage.cache_read_input_tokens ?? 0
    const cacheCreation = usage.cache_creation_input_tokens ?? 0
    if (![uncached, output, cacheRead, cacheCreation].every((value) => Number.isFinite(value) && value >= 0)) continue
    snapshot.uncachedInputTokens += uncached
    snapshot.cacheReadTokens += cacheRead
    snapshot.cacheCreationTokens += cacheCreation
    snapshot.inputTokens += uncached + cacheRead + cacheCreation
    snapshot.outputTokens += output
    snapshot.providerRequestCount += 1
  }
  return snapshot
}

export function getActiveAgentTool(activities: readonly ToolActivity[]): ToolActivity | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index]
    if (activity && !activity.done && !activity.isBackground) return activity
  }
  return null
}

export function resolveAgentRuntimePhase({
  streamState,
  output,
}: {
  streamState: AgentStreamState | undefined
  output: AgentRuntimeOutputSnapshot
}): AgentRuntimePhase {
  if (streamState?.isCompacting || streamState?.contextCompaction?.status === 'running') {
    return { kind: 'compacting', label: 'Compacting context' }
  }

  const activeTool = getActiveAgentTool(streamState?.toolActivities ?? [])
  if (activeTool) {
    return {
      kind: 'tool',
      label: 'Using tools',
      detail: activeTool.intent
        ?? activeTool.displayName
        ?? getToolPhrase(activeTool.toolName, activeTool.input).label,
    }
  }

  if (output.latestBlockKind === 'text') return { kind: 'responding', label: 'Writing response' }
  if (output.latestBlockKind === 'thinking') return { kind: 'thinking', label: 'Thinking' }
  if (output.latestBlockKind === 'tool') return { kind: 'tool', label: 'Using tools' }
  return { kind: 'preparing', label: 'Preparing' }
}

export function updateAgentTokenRateSamples({
  samples,
  at,
  tokens,
  active,
}: {
  samples: readonly AgentTokenRateSample[]
  at: number
  tokens: number
  active: boolean
}): { samples: AgentTokenRateSample[]; rate: number | null } {
  if (!active) return { samples: [], rate: null }

  const cutoff = at - TOKEN_RATE_WINDOW_MS
  let next = samples.filter((sample) => sample.at >= cutoff && sample.tokens <= tokens)
  const latest = next[next.length - 1]
  if (!latest || latest.tokens !== tokens) next = [...next, { at, tokens }]

  const newest = next[next.length - 1]
  if (!newest || at - newest.at > TOKEN_RATE_STALE_MS) return { samples: next, rate: null }

  const oldest = next[0]
  if (!oldest) return { samples: next, rate: null }
  const elapsedMs = newest.at - oldest.at
  const tokenDelta = newest.tokens - oldest.tokens
  if (elapsedMs < TOKEN_RATE_MIN_SAMPLE_MS || tokenDelta <= 0) return { samples: next, rate: null }

  return {
    samples: next,
    rate: tokenDelta / (elapsedMs / 1_000),
  }
}

export function resolveAgentRuntimeOutputTokens({
  providerOutputTokens,
  estimatedTextTokens,
  hasTextOutput,
  streaming,
}: {
  providerOutputTokens: number | undefined
  estimatedTextTokens: number
  hasTextOutput: boolean
  streaming: boolean
}): { value: number | null; estimated: boolean } {
  const settledOutput = providerOutputTokens != null && providerOutputTokens > 0 ? providerOutputTokens : 0
  const unsettledEstimate = streaming && hasTextOutput && estimatedTextTokens > 0
    ? Math.max(1, Math.round(estimatedTextTokens))
    : 0
  if (settledOutput > 0 || unsettledEstimate > 0) {
    return { value: settledOutput + unsettledEstimate, estimated: unsettledEstimate > 0 }
  }
  return { value: null, estimated: false }
}

export function formatAgentRuntimeDuration(seconds: number): string {
  const safeSeconds = Math.max(0, seconds)
  if (safeSeconds < 60) return `${safeSeconds.toFixed(1)}s`
  const minutes = Math.floor(safeSeconds / 60)
  return `${minutes}m ${(safeSeconds % 60).toFixed(1)}s`
}

export function isAgentRetryIssue(retrying: AgentStreamState['retrying'] | undefined): boolean {
  return retrying?.phase === 'scheduled'
    || retrying?.phase === 'running'
    || retrying?.phase === 'exhausted'
    || retrying?.phase === 'cancelled'
}

export function resolveAgentIssueLabel(
  retrying: AgentStreamState['retrying'] | undefined,
  error: string | null,
): string {
  if (retrying?.phase === 'scheduled') {
    return `网络暂时中断，等待第 ${retrying.currentAttempt}/${retrying.maxAttempts} 次自动恢复`
  }
  if (retrying?.phase === 'running') {
    return `正在执行第 ${retrying.currentAttempt}/${retrying.maxAttempts} 次自动恢复`
  }
  if (retrying?.phase === 'exhausted') return '自动恢复已耗尽，请检查连接或重试'
  if (retrying?.phase === 'cancelled') return '自动恢复已取消'
  return error ?? 'Agent 运行异常'
}

export function useAgentRuntimeRailState({
  enabled,
  scopeKey,
  streaming,
  startedAt,
  providerUsage,
}: {
  enabled: boolean
  scopeKey: string
  streaming: boolean
  startedAt: number | undefined
  providerUsage: AgentRuntimeProviderUsageSnapshot
}): AgentRuntimeRailState {
  const latestRunRef = React.useRef<AgentRuntimeSummary | null>(null)
  const scopeKeyRef = React.useRef(scopeKey)
  const enabledRef = React.useRef(enabled)
  const [state, dispatch] = React.useReducer(reduceAgentRuntimeRailState, {
    activeRunStartedAt: enabled && streaming ? startedAt : undefined,
    summary: null,
  })

  React.useLayoutEffect(() => {
    if (scopeKeyRef.current === scopeKey && enabledRef.current === enabled) return
    scopeKeyRef.current = scopeKey
    enabledRef.current = enabled
    latestRunRef.current = null
    dispatch({ type: 'reset', activeRunStartedAt: enabled && streaming ? startedAt : undefined })
  }, [enabled, scopeKey, startedAt, streaming])

  const captureTelemetry = React.useCallback((telemetry: AgentRuntimeTelemetry) => {
    if (!enabled || !streaming || startedAt === undefined) return
    latestRunRef.current = {
      runStartedAt: startedAt,
      elapsedSeconds: telemetry.elapsedSeconds,
      inputTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens,
      outputTokensEstimated: telemetry.outputTokensEstimated,
      cacheReadTokens: telemetry.cacheReadTokens,
      cacheCreationTokens: telemetry.cacheCreationTokens,
      providerRequestCount: telemetry.providerRequestCount,
    }
  }, [enabled, startedAt, streaming])

  React.useLayoutEffect(() => {
    if (!enabled) return
    if (streaming && startedAt !== undefined) {
      if (state.activeRunStartedAt !== startedAt) dispatch({ type: 'new_run', startedAt })
      return
    }

    const activeRunStartedAt = state.activeRunStartedAt
    const latestRun = latestRunRef.current
    if (activeRunStartedAt === undefined || latestRun?.runStartedAt !== activeRunStartedAt) return

    dispatch({
      type: 'complete_run',
      summary: {
        ...latestRun,
        elapsedSeconds: Math.max(latestRun.elapsedSeconds, (Date.now() - activeRunStartedAt) / 1_000),
      },
    })
  }, [enabled, startedAt, state.activeRunStartedAt, streaming])

  React.useLayoutEffect(() => {
    if (!enabled || streaming || providerUsage.providerRequestCount <= 0) return
    dispatch({ type: 'provider_usage', startedAt, usage: providerUsage })
  }, [enabled, providerUsage, startedAt, streaming])

  const dismissSummary = React.useCallback(() => dispatch({ type: 'dismiss_summary' }), [])

  return {
    summary: state.summary,
    captureTelemetry,
    dismissSummary,
  }
}

export function useAgentRuntimeTelemetry({
  streaming,
  streamState,
  liveMessages,
  providerUsage,
}: {
  streaming: boolean
  streamState: AgentStreamState | undefined
  liveMessages: readonly SDKMessage[]
  providerUsage?: AgentRuntimeProviderUsageSnapshot
}): AgentRuntimeTelemetry {
  const [clock, setClock] = React.useState(() => Date.now())
  const [tokensPerSecond, setTokensPerSecond] = React.useState<number | null>(null)
  const samplesRef = React.useRef<AgentTokenRateSample[]>([])
  const outputEstimateRef = React.useRef<AgentRuntimeOutputEstimateState>({
    runStartedAt: streamState?.startedAt,
    textBlocks: new Map(),
  })
  const tokenRateStaleTimerRef = React.useRef<number | undefined>(undefined)
  const runStartedAtRef = React.useRef<number | undefined>(streamState?.startedAt)

  const output = React.useMemo(() => {
    const next = updateAgentRuntimeOutputEstimate(
      liveMessages,
      streamState?.startedAt,
      outputEstimateRef.current,
    )
    outputEstimateRef.current = next.state
    return next.snapshot
  }, [liveMessages, streamState?.startedAt])
  const phase = React.useMemo(
    () => resolveAgentRuntimePhase({ streamState, output }),
    [output, streamState],
  )

  React.useEffect(() => {
    if (!streaming) {
      samplesRef.current = []
      setTokensPerSecond(null)
      return
    }
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 500)
    return () => window.clearInterval(timer)
  }, [streaming, streamState?.startedAt])

  React.useEffect(() => {
    if (runStartedAtRef.current !== streamState?.startedAt) {
      runStartedAtRef.current = streamState?.startedAt
      samplesRef.current = []
      setTokensPerSecond(null)
    }

    if (tokenRateStaleTimerRef.current !== undefined) {
      window.clearTimeout(tokenRateStaleTimerRef.current)
      tokenRateStaleTimerRef.current = undefined
    }

    const activeTextStream = streaming
      && phase.kind === 'responding'
      && output.hasTextOutput
    const next = updateAgentTokenRateSamples({
      samples: samplesRef.current,
      at: Date.now(),
      tokens: output.estimatedTextTokens,
      active: activeTextStream,
    })
    samplesRef.current = next.samples
    setTokensPerSecond((current) => {
      if (current === null && next.rate === null) return current
      if (current !== null && next.rate !== null && Math.abs(current - next.rate) < 0.05) return current
      return next.rate
    })

    if (next.rate !== null) {
      tokenRateStaleTimerRef.current = window.setTimeout(() => {
        tokenRateStaleTimerRef.current = undefined
        setTokensPerSecond(null)
      }, TOKEN_RATE_STALE_MS)
    }

    return () => {
      if (tokenRateStaleTimerRef.current !== undefined) {
        window.clearTimeout(tokenRateStaleTimerRef.current)
        tokenRateStaleTimerRef.current = undefined
      }
    }
  }, [output.estimatedTextTokens, output.hasTextOutput, phase.kind, streamState?.startedAt, streaming])

  const showTokenRate = streaming && phase.kind === 'responding' && output.hasTextOutput
  const resolvedProviderUsage = providerUsage ?? getAgentRuntimeProviderUsageSnapshot(liveMessages, streamState?.startedAt)

  const outputTokenTelemetry = resolveAgentRuntimeOutputTokens({
    providerOutputTokens: resolvedProviderUsage.providerRequestCount > 0 ? resolvedProviderUsage.outputTokens : undefined,
    estimatedTextTokens: output.estimatedTextTokens,
    hasTextOutput: output.hasTextOutput,
    streaming,
  })

  return {
    phase,
    elapsedSeconds: streamState?.startedAt === undefined ? 0 : Math.max(0, (clock - streamState.startedAt) / 1_000),
    inputTokens: resolvedProviderUsage.providerRequestCount > 0 ? resolvedProviderUsage.inputTokens : null,
    outputTokens: outputTokenTelemetry.value,
    outputTokensEstimated: outputTokenTelemetry.estimated,
    cacheReadTokens: resolvedProviderUsage.cacheReadTokens,
    cacheCreationTokens: resolvedProviderUsage.cacheCreationTokens,
    providerRequestCount: resolvedProviderUsage.providerRequestCount,
    tokensPerSecond: showTokenRate ? tokensPerSecond : null,
  }
}

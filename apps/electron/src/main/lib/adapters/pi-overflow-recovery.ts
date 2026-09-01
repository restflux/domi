import type { AssistantMessage } from '@earendil-works/pi-ai/compat'

const PROMPT_TOO_LONG_PATTERNS = [
  'prompt is too long',
  'prompt_too_long',
  'input is too long',
  'context_length_exceeded',
  'maximum context length',
  'context length',
  'context window',
  'maximum context',
  'token limit',
  'too many tokens',
  'exceeds the model',
  'exceed the model',
] as const

export function isPiPromptTooLongError(...messages: Array<string | undefined>): boolean {
  const text = messages
    .filter((message): message is string => typeof message === 'string')
    .join(' ')
    .toLowerCase()
  return PROMPT_TOO_LONG_PATTERNS.some((pattern) => text.includes(pattern))
}

/**
 * Pi 会先发出 agent_end，随后才判断是否需要 overflow compaction。
 * 这两类终态必须暂缓，否则外层会在 Pi 调用 continue() 前释放 session。
 */
export interface PiOverflowRecoveryModel {
  provider: string
  id: string
  contextWindow?: number
  maxTokens?: number
}

/**
 * 与 Pi 0.84 的 isRecoverableLength 保持一致。
 * 此处不能静态导入 ESM-only 的 pi-ai/compat，否则 CJS 主进程会在启动时崩溃。
 */
function isPiRecoverableLength(message: AssistantMessage, desiredMaxOutput: number): boolean {
  return message.stopReason === 'length'
    && desiredMaxOutput > 0
    && message.usage.output < desiredMaxOutput
}

export function shouldDeferPiOverflowTerminalMessage(
  message: AssistantMessage,
  model: PiOverflowRecoveryModel | undefined,
): boolean {
  // Pi AgentSession._checkCompaction 只恢复当前 session.model 产生的消息。Extension
  // 可以在同一 Session 内切换模型，因此不能使用创建 query 时捕获的初始 model。
  if (!model || message.provider !== model.provider || message.model !== model.id) return false

  if (message.stopReason === 'error' && isPiPromptTooLongError(message.errorMessage)) return true

  // 与 Pi 0.84 AgentSession._checkCompaction 使用同一个上游判定。部分 Provider
  // 会在低于模型原始输出上限时返回 length；Pi 会 compact-and-retry 一次，因此
  // Domi 必须保留当前 assistant UUID，不能把截断帧先作为独立最终回答落到 UI。
  // 含 tool call 的 length 例外：Pi core 会拒绝执行截断参数、生成 error toolResult，
  // 并在同一个 agent loop 继续下一回合；此时不会由 AgentSession 进入 compaction。
  const hasToolCall = message.content.some((block) => block.type === 'toolCall')
  if (!hasToolCall && isPiRecoverableLength(message, model.maxTokens ?? 0)) return true

  if (!hasToolCall && model.contextWindow && message.stopReason === 'length' && message.usage?.output === 0) {
    const inputTokens = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0)
    return inputTokens >= model.contextWindow * 0.99
  }

  return false
}

export function shouldDeferPiOverflowTerminalError(
  message: AssistantMessage | undefined,
  model: PiOverflowRecoveryModel | undefined,
  willRetry: boolean,
  abortRequested: boolean,
): boolean {
  return !willRetry
    && !abortRequested
    && !!message
    && shouldDeferPiOverflowTerminalMessage(message, model)
}

export type PiOverflowRecoveryAction = 'none' | 'discard' | 'release'

/**
 * 只管理“有一个 overflow 终态正在等待 native compaction”的生命周期。
 * deferred error 本体仍由 retry terminal gate 保存，避免形成两个真相来源。
 */
export function createPiOverflowRecoveryState(): {
  defer: () => void
  clear: () => void
  isPending: () => boolean
  settleCompaction: (input: {
    reason: string
    aborted: boolean
    hasResult: boolean
    willRetry: boolean
    discard: boolean
  }) => PiOverflowRecoveryAction
  settleFallback: (discard: boolean) => PiOverflowRecoveryAction
} {
  let pending = false

  const settle = (discard: boolean): PiOverflowRecoveryAction => {
    if (!pending) return 'none'
    pending = false
    return discard ? 'discard' : 'release'
  }

  return {
    defer() { pending = true },
    clear() { pending = false },
    isPending() { return pending },
    settleCompaction(input) {
      // pending 只对应 Pi 的 overflow 自动压缩。手工/阈值压缩不能提前释放该终态；
      // 若上游漏发 matching compaction_end，后续 agent_settled fallback 会兜底。
      if (input.reason !== 'overflow') return 'none'
      const recovered = !input.aborted && input.hasResult && input.willRetry
      return settle(input.discard || recovered)
    },
    settleFallback(discard) {
      return settle(discard)
    },
  }
}

import type { isContextOverflow, isRecoverableLength } from '@earendil-works/pi-ai'
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

/** 编排层还会收到纯字符串／stderr 错误；缺少完整 Pi 消息时保留独立兜底，不伪造消息。 */
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

/** 从异步初始化的 pi-ai dynamic import 注入，避免 CJS 主进程静态加载 ESM。 */
export interface PiOverflowClassifiers {
  isContextOverflow: typeof isContextOverflow
  isRecoverableLength: typeof isRecoverableLength
}

export function shouldDeferPiOverflowTerminalMessage(
  message: AssistantMessage,
  model: PiOverflowRecoveryModel | undefined,
  classifiers: PiOverflowClassifiers,
): boolean {
  // Extension 可切换模型，因此使用实时 session.model 而非创建 query 时的模型。
  // 这里只识别暂缓交付候选；投影、最新压缩边界及物理模型的恢复决策仍归 Pi，
  // SDK 未启动恢复时由 agent_settled 释放，不自行发起额外压缩。
  if (!model || message.provider !== model.provider || message.model !== model.id) return false

  if (message.stopReason === 'error') return classifiers.isContextOverflow(message)
  if (message.stopReason !== 'length') return false

  // 截断的工具参数由 Pi core 拒绝并在同一 loop 续跑，不进入 Session 压缩恢复。
  if (message.content.some((block) => block.type === 'toolCall')) return false

  // 使用模型原始输出上限，不使用 Provider 按剩余上下文钳制后的请求上限。
  return classifiers.isRecoverableLength(message, model.maxTokens ?? 0)
    || classifiers.isContextOverflow(message, model.contextWindow)
}

export function shouldDeferPiOverflowTerminalError(
  message: AssistantMessage | undefined,
  model: PiOverflowRecoveryModel | undefined,
  willRetry: boolean,
  abortRequested: boolean,
  classifiers: PiOverflowClassifiers,
): boolean {
  return !willRetry
    && !abortRequested
    && !!message
    && shouldDeferPiOverflowTerminalMessage(message, model, classifiers)
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

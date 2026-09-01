export const MAX_PI_INCOMPLETE_TURN_CONTINUATIONS = 3
export const MAX_PI_EMPTY_TURN_CONTINUATIONS = 1

export const PI_INCOMPLETE_TURN_CONTINUATION_PROMPT = `<domi_incomplete_turn_continuation>
你上一轮没有产生可交付的用户回复，或以明显未完成的过渡句结束。不要声称已经执行尚未发生的工具调用，不要重复进度说明，也不要只描述下一步；立即继续调用所需工具，完成剩余工作、验证结果，并且只有在原始需求全部完成后才给出最终答复。
</domi_incomplete_turn_continuation>`

type StopReason =
  | 'aborted'
  | 'runtime_limit'
  | 'terminal_error'
  | 'unsupported_model'
  | 'continuation_limit'
  | 'complete'

export interface PiPromptOutputEvidence {
  sawAssistant: boolean
  hasVisibleText: boolean
  hasToolCall: boolean
  latestVisibleText: string
}

export interface PiIncompleteTurnContinuationOptions {
  modelId?: string
  messages: readonly unknown[]
  /** 当前 prompt 在压缩重建 context 前锁存的输出证据。 */
  promptOutputEvidence?: PiPromptOutputEvidence
  continuationCount: number
  abortRequested: boolean
  runtimeLimitReached: boolean
  terminalSucceeded: boolean
}

export type PiIncompleteTurnContinuationPlan =
  | { shouldContinue: true; prompt: string }
  | { shouldContinue: false; reason: StopReason }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function inspectAssistantContent(messageValue: unknown): { text: string; hasToolCall: boolean } | undefined {
  const message = asRecord(messageValue)
  if (message?.role !== 'assistant') return undefined
  if (typeof message.content === 'string') {
    return { text: message.content.trim(), hasToolCall: false }
  }
  if (!Array.isArray(message.content)) return { text: '', hasToolCall: false }

  const textParts: string[] = []
  let hasToolCall = false
  for (const rawPart of message.content) {
    const part = asRecord(rawPart)
    if (!part) continue
    if ((part.type === 'text' || part.type === 'output_text') && typeof part.text === 'string') {
      textParts.push(part.text)
    }
    if (part.type === 'toolCall' || part.type === 'tool_use' || part.type === 'function_call') {
      hasToolCall = true
    }
  }
  return { text: textParts.join('\n').trim(), hasToolCall }
}

export function createPiPromptOutputEvidence(): PiPromptOutputEvidence {
  return {
    sawAssistant: false,
    hasVisibleText: false,
    hasToolCall: false,
    latestVisibleText: '',
  }
}

export function recordPiPromptAssistantOutput(
  evidence: PiPromptOutputEvidence,
  message: unknown,
): void {
  const inspected = inspectAssistantContent(message)
  if (!inspected) return
  evidence.sawAssistant = true
  evidence.hasVisibleText ||= inspected.text.length > 0
  evidence.hasToolCall ||= inspected.hasToolCall
  evidence.latestVisibleText = inspected.text
}

function getLatestAssistantVisibleText(messages: readonly unknown[]): { text: string; hasToolCall: boolean } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const inspected = inspectAssistantContent(messages[index])
    if (inspected) return inspected
  }
  return undefined
}

/**
 * 所有模型在 thinking-only/空正文成功 stop 时自动恢复一次；压缩重建 context 后，
 * 使用当前 prompt 预先锁存的输出证据，避免原 assistant 消息丢失。已有工具调用绝不重复。
 * Kimi 额外识别“下一步：”类过渡句，并保留独立的三次硬上限。
 */
export function planPiIncompleteTurnContinuation(
  options: PiIncompleteTurnContinuationOptions,
): PiIncompleteTurnContinuationPlan {
  if (options.abortRequested) return { shouldContinue: false, reason: 'aborted' }
  if (options.runtimeLimitReached) return { shouldContinue: false, reason: 'runtime_limit' }
  if (!options.terminalSucceeded) return { shouldContinue: false, reason: 'terminal_error' }

  const locked = options.promptOutputEvidence
  const latest = locked?.sawAssistant
    ? { text: locked.latestVisibleText, hasToolCall: locked.hasToolCall }
    : getLatestAssistantVisibleText(options.messages)
  const isEmptySuccessfulTurn = locked?.sawAssistant
    ? !locked.hasVisibleText && !locked.hasToolCall
    : !!latest && !latest.hasToolCall && latest.text.length === 0

  if (isEmptySuccessfulTurn) {
    if (options.continuationCount >= MAX_PI_EMPTY_TURN_CONTINUATIONS) {
      return { shouldContinue: false, reason: 'continuation_limit' }
    }
    return {
      shouldContinue: true,
      prompt: PI_INCOMPLETE_TURN_CONTINUATION_PROMPT,
    }
  }
  if (latest?.hasToolCall) return { shouldContinue: false, reason: 'complete' }

  if (!options.modelId?.toLowerCase().includes('kimi')) {
    return { shouldContinue: false, reason: 'unsupported_model' }
  }
  if (options.continuationCount >= MAX_PI_INCOMPLETE_TURN_CONTINUATIONS) {
    return { shouldContinue: false, reason: 'continuation_limit' }
  }
  if (!latest || latest.hasToolCall || !/[：:]$/u.test(latest.text)) {
    return { shouldContinue: false, reason: 'complete' }
  }

  return {
    shouldContinue: true,
    prompt: PI_INCOMPLETE_TURN_CONTINUATION_PROMPT,
  }
}

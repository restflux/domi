import { describe, expect, test } from 'bun:test'
import { isContextOverflow, isRecoverableLength } from '@earendil-works/pi-ai'
import type { AssistantMessage } from '@earendil-works/pi-ai/compat'
import {
  createPiOverflowRecoveryState,
  isPiPromptTooLongError,
  shouldDeferPiOverflowTerminalError,
  shouldDeferPiOverflowTerminalMessage,
} from './pi-overflow-recovery'

const CLASSIFIERS = { isContextOverflow, isRecoverableLength }

const RECOVERY_MODEL = {
  provider: 'test-provider',
  id: 'test-model',
  contextWindow: 200_000,
  maxTokens: 8_192,
}

function assistant(overrides: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    stopReason: 'stop',
    api: 'openai-completions',
    provider: RECOVERY_MODEL.provider,
    model: RECOVERY_MODEL.id,
    timestamp: 0,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  }
}

describe('Pi context overflow recognition', () => {
  test('Given 限流错误包含 token 文案 When 原生分类否定溢出 Then 不等待 overflow 压缩', () => {
    const message = assistant({ stopReason: 'error', errorMessage: 'Rate limit exceeded: too many tokens' })

    expect(isContextOverflow(message)).toBe(false)
    expect(shouldDeferPiOverflowTerminalMessage(message, RECOVERY_MODEL, CLASSIFIERS)).toBe(false)
    expect(shouldDeferPiOverflowTerminalError(message, RECOVERY_MODEL, false, false, CLASSIFIERS)).toBe(false)
  })

  test.each([
    ['anthropic', 'request_too_large'],
    ['openai', "This model's maximum context length is 8192 tokens"],
    ['google', 'input token count exceeds the maximum allowed tokens'],
    ['groq', 'Please reduce the length of the messages'],
    ['together', "Input (210000 tokens) is longer than the model's context length (200000 tokens)"],
    ['minimax', 'context window exceeds limit'],
    ['dashscope', 'Range of input length should be [1, 8192]'],
    ['cerebras', '413 status code (no body)'],
  ])('Given %s Provider overflow When 使用公开分类 Then 等待原生恢复 (%s)', (provider, errorMessage) => {
    const model = { ...RECOVERY_MODEL, provider }
    const message = assistant({ provider, stopReason: 'error', errorMessage })

    expect(isContextOverflow(message)).toBe(true)
    expect(shouldDeferPiOverflowTerminalMessage(message, model, CLASSIFIERS)).toBe(true)
    expect(shouldDeferPiOverflowTerminalError(message, model, false, false, CLASSIFIERS)).toBe(true)
  })

  test.each([
    'Throttling error: Too many tokens, please wait before trying again.',
    'Service unavailable: too many tokens',
    'Too many requests: token limit exceeded',
    'Rate limit reached: maximum context length is 8192 tokens',
    'Invalid API key',
  ])('Given 非溢出错误 When 包含疑似 token 文案 Then 不等待压缩 (%s)', (errorMessage) => {
    const message = assistant({ stopReason: 'error', errorMessage })

    expect(isContextOverflow(message)).toBe(false)
    expect(shouldDeferPiOverflowTerminalMessage(message, RECOVERY_MODEL, CLASSIFIERS)).toBe(false)
    expect(shouldDeferPiOverflowTerminalError(message, RECOVERY_MODEL, false, false, CLASSIFIERS)).toBe(false)
  })

  test.each(['400 (no body)', '413 status code (no body)'])('Given 无正文错误 When 非 Cerebras Provider Then 不将 %s 误认成 overflow', (errorMessage) => {
    for (const provider of ['cerebras', 'openai']) {
      const message = assistant({ provider, stopReason: 'error', errorMessage })
      const expected = provider === 'cerebras'
      expect(isContextOverflow(message)).toBe(expected)
      expect(shouldDeferPiOverflowTerminalMessage(message, { ...RECOVERY_MODEL, provider }, CLASSIFIERS)).toBe(expected)
    }
  })

  test('Given 编排层只有错误文本 When 缺少 Pi AssistantMessage Then 保留字符串兜底而不伪造消息', () => {
    expect(isPiPromptTooLongError('API Error', undefined, 'prompt_too_long')).toBe(true)
    expect(isPiPromptTooLongError('maximum context length exceeded')).toBe(true)
    expect(isPiPromptTooLongError('401 invalid API key')).toBe(false)
  })

  test('defers prompt-too-long errors until native compaction settles', () => {
    const message = assistant({ stopReason: 'error', errorMessage: 'Prompt is too long for this model' })

    expect(shouldDeferPiOverflowTerminalMessage(message, RECOVERY_MODEL, CLASSIFIERS)).toBe(true)
    expect(shouldDeferPiOverflowTerminalError(message, RECOVERY_MODEL, false, false, CLASSIFIERS)).toBe(true)
  })

  test('defers zero-output length stops at the context boundary', () => {
    const message = assistant({
      stopReason: 'length',
      usage: {
        input: 198_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        totalTokens: 198_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    })

    expect(shouldDeferPiOverflowTerminalMessage(message, RECOVERY_MODEL, CLASSIFIERS)).toBe(true)
  })

  test('defers Pi native recoverable length stops below the model output limit', () => {
    const message = assistant({
      stopReason: 'length',
      usage: {
        input: 120_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 4_096,
        totalTokens: 124_096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    })

    expect(shouldDeferPiOverflowTerminalMessage(message, RECOVERY_MODEL, CLASSIFIERS)).toBe(true)
    expect(shouldDeferPiOverflowTerminalError(message, RECOVERY_MODEL, false, false, CLASSIFIERS)).toBe(true)
  })

  test('does not defer length tool calls because Pi core rejects and continues them inside the same loop', () => {
    const toolCallLength = assistant({
      stopReason: 'length',
      content: [{
        type: 'toolCall',
        id: 'call-truncated',
        name: 'write',
        arguments: { path: 'src/incomplete.ts' },
      }],
      usage: {
        input: 120_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 4_096,
        totalTokens: 124_096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    })

    expect(shouldDeferPiOverflowTerminalMessage(toolCallLength, RECOVERY_MODEL, CLASSIFIERS)).toBe(false)
  })

  test('Given SDK 的静默溢出成功回答 When 无须重试 Then 不暂缓成功终态', () => {
    const message = assistant({ usage: {
      ...assistant({}).usage, input: 201_000, totalTokens: 201_000,
    } })
    expect(isContextOverflow(message, RECOVERY_MODEL.contextWindow)).toBe(true)
    expect(shouldDeferPiOverflowTerminalMessage(message, RECOVERY_MODEL, CLASSIFIERS)).toBe(false)
  })

  test.each([197_999, 198_000])('Given 模型无输出上限 When 输入和缓存共 %i tokens Then 使用原生 contextWindow 边界', (inputTokens) => {
    const model = { ...RECOVERY_MODEL, maxTokens: 0 }
    const message = assistant({ stopReason: 'length', usage: {
      ...assistant({}).usage, input: inputTokens - 10_000, cacheRead: 10_000,
      cacheWrite: 20_000, totalTokens: inputTokens + 20_000,
    } })
    const expected = inputTokens === 198_000
    expect(isRecoverableLength(message, model.maxTokens)).toBe(false)
    expect(isContextOverflow(message, model.contextWindow)).toBe(expected)
    expect(shouldDeferPiOverflowTerminalMessage(message, model, CLASSIFIERS)).toBe(expected)
  })

  test('uses the live session model and ignores a stale-model terminal', () => {
    const message = assistant({ stopReason: 'error', errorMessage: 'Prompt is too long for this model' })
    const switchedModel = { ...RECOVERY_MODEL, provider: 'other-provider', id: 'other-model' }

    expect(shouldDeferPiOverflowTerminalMessage(message, switchedModel, CLASSIFIERS)).toBe(false)
    expect(shouldDeferPiOverflowTerminalError(message, switchedModel, false, false, CLASSIFIERS)).toBe(false)
  })

  test('does not defer unrecoverable length stops, successful responses, retries, or aborts', () => {
    const exhaustedLength = assistant({
      stopReason: 'length',
      usage: {
        input: 120_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 8_192,
        totalTokens: 128_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    })
    const overflow = assistant({ stopReason: 'error', errorMessage: 'maximum context length exceeded' })

    expect(shouldDeferPiOverflowTerminalMessage(exhaustedLength, RECOVERY_MODEL, CLASSIFIERS)).toBe(false)
    expect(shouldDeferPiOverflowTerminalMessage(assistant({ stopReason: 'stop' }), RECOVERY_MODEL, CLASSIFIERS)).toBe(false)
    expect(shouldDeferPiOverflowTerminalError(overflow, RECOVERY_MODEL, true, false, CLASSIFIERS)).toBe(false)
    expect(shouldDeferPiOverflowTerminalError(overflow, RECOVERY_MODEL, false, true, CLASSIFIERS)).toBe(false)
  })
})

describe('Pi context overflow recovery lifecycle', () => {
  test('discards the deferred error after successful overflow compaction and retry', () => {
    const state = createPiOverflowRecoveryState()
    state.defer()

    expect(state.settleCompaction({ reason: 'overflow', aborted: false, hasResult: true, willRetry: true, discard: false })).toBe('discard')
    expect(state.isPending()).toBe(false)
  })

  test('releases the deferred error when compaction fails or is aborted', () => {
    const failed = createPiOverflowRecoveryState()
    failed.defer()
    expect(failed.settleCompaction({ reason: 'overflow', aborted: false, hasResult: false, willRetry: false, discard: false })).toBe('release')

    const aborted = createPiOverflowRecoveryState()
    aborted.defer()
    expect(aborted.settleCompaction({ reason: 'overflow', aborted: true, hasResult: false, willRetry: false, discard: false })).toBe('release')
  })

  test('ignores unrelated compaction events while overflow recovery is pending', () => {
    const state = createPiOverflowRecoveryState()
    state.defer()

    expect(state.settleCompaction({ reason: 'threshold', aborted: false, hasResult: true, willRetry: false, discard: false })).toBe('none')
    expect(state.isPending()).toBe(true)
  })

  test('discards pending overflow state when the user aborts or interrupts', () => {
    const aborted = createPiOverflowRecoveryState()
    aborted.defer()
    expect(aborted.settleCompaction({ reason: 'overflow', aborted: true, hasResult: false, willRetry: false, discard: true })).toBe('discard')

    const interrupted = createPiOverflowRecoveryState()
    interrupted.defer()
    expect(interrupted.settleFallback(true)).toBe('discard')
  })

  test('releases once on agent_settled when compaction_end is missing', () => {
    const state = createPiOverflowRecoveryState()
    state.defer()

    expect(state.settleFallback(false)).toBe('release')
    expect(state.settleFallback(false)).toBe('none')
  })
})

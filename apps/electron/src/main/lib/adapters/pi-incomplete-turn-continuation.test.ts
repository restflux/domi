import { describe, expect, test } from 'bun:test'
import {
  createPiPromptOutputEvidence,
  planPiIncompleteTurnContinuation,
  recordPiPromptAssistantOutput,
} from './pi-incomplete-turn-continuation'

const assistant = (text: string): unknown => ({
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'internal' },
    { type: 'text', text },
  ],
})

const thinkingOnlyAssistant = (): unknown => ({
  role: 'assistant',
  content: [{ type: 'thinking', thinking: 'Planning image generation call' }],
})

const toolCallAssistant = (): unknown => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id: 'call-1', name: 'mcp__gpt_image__imagegen', arguments: { prompt: 'draw' } }],
})

describe('Pi 未完成轮次自动续跑', () => {
  test('Kimi 以未完成冒号过渡句收尾时自动续跑', () => {
    for (const text of [
      '补单分支截断的测试：',
      '在面板根部挂上确认弹窗：',
      '快好了，还差弹窗 JSX 挂载，马上完成。先看面板结尾结构：',
    ]) {
      expect(planPiIncompleteTurnContinuation({
        modelId: 'kimi-k3',
        messages: [assistant(text)],
        continuationCount: 0,
        abortRequested: false,
        runtimeLimitReached: false,
        terminalSucceeded: true,
      })).toMatchObject({ shouldContinue: true })
    }
  })

  test('所有模型的 thinking-only 或空正文成功终态自动续跑一次', () => {
    for (const modelId of ['gpt-5.6-sol', 'claude-sonnet', 'kimi-k3']) {
      expect(planPiIncompleteTurnContinuation({
        modelId,
        messages: [thinkingOnlyAssistant()],
        continuationCount: 0,
        abortRequested: false,
        runtimeLimitReached: false,
        terminalSucceeded: true,
      })).toMatchObject({ shouldContinue: true })
      expect(planPiIncompleteTurnContinuation({
        modelId,
        messages: [assistant('')],
        continuationCount: 1,
        abortRequested: false,
        runtimeLimitReached: false,
        terminalSucceeded: true,
      })).toEqual({ shouldContinue: false, reason: 'continuation_limit' })
    }
  })

  test('压缩重建 context 后原 assistant 已不在 messages 中时仍使用本轮锁存证据续跑一次', () => {
    const evidence = createPiPromptOutputEvidence()
    recordPiPromptAssistantOutput(evidence, thinkingOnlyAssistant())
    const base = {
      modelId: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'compaction summary context' }],
      promptOutputEvidence: evidence,
      continuationCount: 0,
      abortRequested: false,
      runtimeLimitReached: false,
      terminalSucceeded: true,
    }

    expect(planPiIncompleteTurnContinuation(base)).toMatchObject({ shouldContinue: true })
    expect(planPiIncompleteTurnContinuation({ ...base, continuationCount: 1 }))
      .toEqual({ shouldContinue: false, reason: 'continuation_limit' })
  })

  test('已有工具调用的 assistant 即使无正文也不重复续跑', () => {
    const evidence = createPiPromptOutputEvidence()
    recordPiPromptAssistantOutput(evidence, toolCallAssistant())

    expect(planPiIncompleteTurnContinuation({
      modelId: 'gpt-5.6-sol',
      messages: [toolCallAssistant()],
      promptOutputEvidence: evidence,
      continuationCount: 0,
      abortRequested: false,
      runtimeLimitReached: false,
      terminalSucceeded: true,
    })).toEqual({ shouldContinue: false, reason: 'complete' })
    expect(planPiIncompleteTurnContinuation({
      modelId: 'kimi-k3',
      messages: [toolCallAssistant()],
      continuationCount: 0,
      abortRequested: false,
      runtimeLimitReached: false,
      terminalSucceeded: true,
    })).toEqual({ shouldContinue: false, reason: 'complete' })
  })

  test('完整回答、其他模型的可见过渡句、异常终态与 Kimi 达到上限时均不自动续跑', () => {
    const base = {
      modelId: 'kimi-k3',
      messages: [assistant('修改完成，测试已经通过。')],
      continuationCount: 0,
      abortRequested: false,
      runtimeLimitReached: false,
      terminalSucceeded: true,
    }
    expect(planPiIncompleteTurnContinuation(base)).toEqual({ shouldContinue: false, reason: 'complete' })
    expect(planPiIncompleteTurnContinuation({ ...base, modelId: 'gpt-5.6-sol', messages: [assistant('下一步：')] }))
      .toEqual({ shouldContinue: false, reason: 'unsupported_model' })
    expect(planPiIncompleteTurnContinuation({ ...base, terminalSucceeded: false, messages: [assistant('下一步：')] }))
      .toEqual({ shouldContinue: false, reason: 'terminal_error' })
    expect(planPiIncompleteTurnContinuation({ ...base, continuationCount: 3, messages: [assistant('下一步：')] }))
      .toEqual({ shouldContinue: false, reason: 'continuation_limit' })
  })

  test('Pi length recovery 尚未 settled 时不触发 Kimi 冒号续跑', () => {
    expect(planPiIncompleteTurnContinuation({
      modelId: 'kimi-k3',
      messages: [assistant('被 length 截断的下一步：')],
      continuationCount: 0,
      abortRequested: false,
      runtimeLimitReached: false,
      // Adapter 只会在最终 result 成功后允许 continuation；恢复中的内部
      // agent_end/compaction 不得启动第二套自动续跑。
      terminalSucceeded: false,
    })).toEqual({ shouldContinue: false, reason: 'terminal_error' })
  })

  test('用户中止或运行限制优先阻止续跑', () => {
    const base = {
      modelId: 'gpt-5.6-sol',
      messages: [thinkingOnlyAssistant()],
      continuationCount: 0,
      abortRequested: false,
      runtimeLimitReached: false,
      terminalSucceeded: true,
    }
    expect(planPiIncompleteTurnContinuation({ ...base, abortRequested: true }))
      .toEqual({ shouldContinue: false, reason: 'aborted' })
    expect(planPiIncompleteTurnContinuation({ ...base, runtimeLimitReached: true }))
      .toEqual({ shouldContinue: false, reason: 'runtime_limit' })
  })
})

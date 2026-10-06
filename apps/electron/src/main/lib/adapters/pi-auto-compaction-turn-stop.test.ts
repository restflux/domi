import { describe, expect, test } from 'bun:test'
import { runAgentLoop } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai'
import {
  PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
  PI_COMPACTION_CONTINUATION_PROMPT,
  canRunSessionTerminatingTool,
  continuePiAfterCompaction,
  planPiCompactionContinuation,
} from './pi-agent-adapter'

const MODEL = {
  api: 'openai-completions',
  provider: 'test-provider',
  id: 'test-model',
  name: 'test-model',
  reasoning: false,
  input: ['text'],
  contextWindow: 100_000,
  maxTokens: 4_096,
} as const

function completed(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream()
  stream.end(message)
  return stream
}

describe('Pi 1.0 native compaction boundary', () => {
  test('uses Pi finishTurn as the only loop-stop decision after a tool turn', async () => {
    let providerCalls = 0

    await runAgentLoop(
      [{ role: 'user', content: [{ type: 'text', text: '完成任务' }], timestamp: Date.now() }],
      {
        messages: [],
        tools: [{
          name: 'finish',
          label: 'Finish',
          description: 'finish',
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: 'text', text: 'done' }], details: {} }),
        }],
      },
      {
        model: MODEL as never,
        convertToLlm: (messages) => messages as never,
        finishTurn: async () => ({ action: 'end' }),
      },
      () => {},
      undefined,
      async () => {
        providerCalls += 1
        return completed({
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-1', name: 'finish', arguments: {} }],
          api: MODEL.api,
          provider: MODEL.provider,
          model: MODEL.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'toolUse',
          timestamp: Date.now(),
        } as AssistantMessage)
      },
    )

    expect(providerCalls).toBe(1)
  })

  test('keeps session-terminating tools exclusive to their own batch', () => {
    expect(canRunSessionTerminatingTool('CompactContext', ['CompactContext'])).toBe(true)
    expect(canRunSessionTerminatingTool('CompactContext', ['CompactContext', 'Read'])).toBe(false)
    expect(canRunSessionTerminatingTool('Read', ['Read'])).toBe(false)
  })

  test('plans a bounded hidden continuation without reintroducing a user prompt', () => {
    expect(planPiCompactionContinuation({ continuationCount: 0, abortRequested: false, runtimeLimitReached: false })).toEqual({
      shouldContinue: true,
      prompt: PI_COMPACTION_CONTINUATION_PROMPT,
    })
    expect(planPiCompactionContinuation({ continuationCount: 20, abortRequested: false, runtimeLimitReached: false })).toEqual({
      shouldContinue: false,
      reason: 'continuation_limit',
    })
  })

  test('delivers compaction continuation through Pi custom-message semantics', async () => {
    const calls: Array<{ customType: string; content: unknown; options: unknown }> = []
    await continuePiAfterCompaction({
      sendCustomMessage: async (message, options) => {
        calls.push({ customType: message.customType, content: message.content, options })
      },
    }, '继续原任务')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      customType: PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
      options: { triggerTurn: true },
    })
  })
})

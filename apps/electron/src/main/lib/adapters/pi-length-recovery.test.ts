import { describe, expect, test } from 'bun:test'
import { runAgentLoop, type AgentEvent } from '@earendil-works/pi-agent-core'
import {
  createAssistantMessageEventStream,
  isContextOverflow,
  isRecoverableLength,
  type AssistantMessageEventStream,
} from '@earendil-works/pi-ai'
import { convertToLlm } from '@earendil-works/pi-coding-agent'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai/compat'
import { Type } from 'typebox'
import { createPiAssistantUuidTracker } from './pi-agent-adapter'
import {
  createPiOverflowRecoveryState,
  shouldDeferPiOverflowTerminalError,
  shouldDeferPiOverflowTerminalMessage,
} from './pi-overflow-recovery'
import { createPiRetryTerminalGate } from './pi-retry-control'

const CLASSIFIERS = { isContextOverflow, isRecoverableLength }

const MODEL: Model<'openai-completions'> = {
  id: 'length-test-model',
  name: 'Length Test Model',
  api: 'openai-completions',
  provider: 'length-test-provider',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
}

function usage(output: number) {
  return {
    input: 120_000,
    cacheRead: 0,
    cacheWrite: 0,
    output,
    totalTokens: 120_000 + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function assistant(
  stopReason: AssistantMessage['stopReason'],
  output: number,
  content: AssistantMessage['content'] = [],
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    stopReason,
    usage: usage(output),
    timestamp: Date.now(),
  }
}

function completedStream(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  stream.end(message)
  return stream
}

describe('Pi 1.0 native length recovery', () => {
  test('does not execute tool calls from a length-truncated assistant message', async () => {
    let streamCalls = 0
    let executeCalls = 0
    const events: AgentEvent[] = []
    const truncated = assistant('length', 4_096, [{
      type: 'toolCall',
      id: 'call-truncated',
      name: 'dangerous_write',
      arguments: { path: 'src/incomplete.ts' },
    }])
    const recovered = assistant('stop', 128, [{ type: 'text', text: 'Recovered safely.' }])

    const result = await runAgentLoop(
      [{ role: 'user', content: [{ type: 'text', text: 'write the file' }], timestamp: Date.now() }],
      {
        messages: [],
        tools: [{
          name: 'dangerous_write',
          label: 'Dangerous Write',
          description: 'Must not run from a truncated response',
          parameters: Type.Object({ path: Type.String() }),
          execute: async () => {
            executeCalls += 1
            return { content: [{ type: 'text', text: 'executed' }], details: {} }
          },
        }],
      },
      {
        model: MODEL,
        convertToLlm,
      },
      (event) => { events.push(event) },
      undefined,
      async () => {
        streamCalls += 1
        return completedStream(streamCalls === 1 ? truncated : recovered)
      },
    )

    expect(executeCalls).toBe(0)
    expect(streamCalls).toBe(2)
    expect(result).toContainEqual(recovered)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool_execution_end',
      toolCallId: 'call-truncated',
      isError: true,
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'message_end',
      message: expect.objectContaining({
        role: 'toolResult',
        toolCallId: 'call-truncated',
        isError: true,
      }),
    }))
  })
})

describe('Domi length recovery terminal lifecycle', () => {
  test('discards the truncated final frame and preserves its UUID for the recovered frame', () => {
    let nextUuid = 0
    const tracker = createPiAssistantUuidTracker(() => `assistant-${++nextUuid}`)
    const gate = createPiRetryTerminalGate<{ message: AssistantMessage; uuid: string }>()
    const recovery = createPiOverflowRecoveryState()
    const truncated = assistant('length', 4_096, [{ type: 'text', text: 'unfinished:' }])
    const truncatedUuid = tracker.get()

    expect(shouldDeferPiOverflowTerminalMessage(truncated, MODEL, CLASSIFIERS)).toBe(true)
    gate.defer({ message: truncated, uuid: truncatedUuid })
    expect(shouldDeferPiOverflowTerminalError(
      gate.peek()?.message,
      MODEL,
      false,
      false,
      CLASSIFIERS,
    )).toBe(true)
    recovery.defer()

    const action = recovery.settleCompaction({
      reason: 'overflow',
      aborted: false,
      hasResult: true,
      willRetry: true,
      discard: false,
    })
    expect(action).toBe('discard')
    expect(gate.settle(action === 'discard')).toBeUndefined()

    // Adapter 的 deferred 分支不会 reset tracker；恢复帧会原地替换截断 partial。
    expect(tracker.get()).toBe(truncatedUuid)
    tracker.reset()
    expect(tracker.get()).toBe('assistant-2')
  })

  test('releases the truncated final frame when native compaction cannot recover', () => {
    const pending = { message: assistant('length', 4_096) }
    const gate = createPiRetryTerminalGate<typeof pending>()
    const recovery = createPiOverflowRecoveryState()
    gate.defer(pending)
    recovery.defer()

    const action = recovery.settleCompaction({
      reason: 'overflow',
      aborted: false,
      hasResult: false,
      willRetry: false,
      discard: false,
    })
    expect(action).toBe('release')
    expect(gate.settle(action === 'discard')).toBe(pending)
    expect(recovery.isPending()).toBe(false)
  })

  test('discards a pending length terminal when cancellation wins during compaction', () => {
    const gate = createPiRetryTerminalGate<{ message: AssistantMessage }>()
    const recovery = createPiOverflowRecoveryState()
    gate.defer({ message: assistant('length', 4_096) })
    recovery.defer()

    const action = recovery.settleCompaction({
      reason: 'overflow',
      aborted: true,
      hasResult: false,
      willRetry: false,
      discard: true,
    })
    expect(action).toBe('discard')
    expect(gate.settle(action === 'discard')).toBeUndefined()
    expect(recovery.isPending()).toBe(false)
  })
})

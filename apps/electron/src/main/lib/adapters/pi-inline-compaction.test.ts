import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Agent, runAgentLoop, type AgentEvent, type AgentMessage, type PrepareNextTurnContext } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai/compat'
import { AgentSession } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const MODEL = {
  id: 'inline-compaction-model',
  name: 'Inline Compaction Model',
  api: 'openai-completions',
  provider: 'inline-test-provider',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8_192,
} as const

function usage(totalTokens: number) {
  return {
    input: totalTokens,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function assistant(content: AssistantMessage['content'], totalTokens = 10_000): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
    usage: usage(totalTokens),
    timestamp: Date.now(),
  } as AssistantMessage
}

function toolResult(text = 'x'.repeat(40_000)): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  } as ToolResultMessage
}

function completed(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  stream.end(message)
  return stream
}

describe('Pi 1.0 Agent loop finishTurn lifecycle', () => {
  test('uses finishTurn to stop after a completed tool turn', async () => {
    const events: AgentEvent[] = []
    let streamCalls = 0
    const first = assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }])

    await runAgentLoop(
      [{ role: 'user', content: [{ type: 'text', text: 'read' }], timestamp: Date.now() }],
      { messages: [], tools: [{
        name: 'read',
        label: 'Read',
        description: 'read',
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text', text: 'result' }], details: {} }),
      }] },
      {
        model: MODEL as never,
        convertToLlm: (messages) => messages as never,
        finishTurn: () => ({ action: 'end' }),
      },
      (event) => { events.push(event) },
      undefined,
      async () => {
        streamCalls += 1
        return completed(first)
      },
    )

    expect(streamCalls).toBe(1)
    expect(events.at(-1)?.type).toBe('agent_end')
  })

  test('continues the same loop only after inline compaction replaced provider context', async () => {
    const order: string[] = []
    let streamCalls = 0
    const first = assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], 78_000)
    const second = assistant([{ type: 'text', text: 'continued' }])
    const compacted = {
      role: 'compactionSummary',
      summary: 'checkpoint',
      tokensBefore: 88_000,
      timestamp: Date.now(),
    } as AgentMessage

    await runAgentLoop(
      [{ role: 'user', content: [{ type: 'text', text: 'read' }], timestamp: Date.now() }],
      { messages: [], tools: [{
        name: 'read',
        label: 'Read',
        description: 'read',
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text', text: 'x'.repeat(40_000) }], details: {} }),
      }] },
      {
        model: MODEL as never,
        convertToLlm: (messages) => messages as never,
        prepareNextTurn: (turn) => {
          order.push('compaction_start', 'compaction_end')
          return { context: { ...turn.context, messages: [compacted] } }
        },
      },
      (event) => {
        if (event.type === 'agent_end') order.push('agent_end')
      },
      undefined,
      async (_model, context) => {
        streamCalls += 1
        order.push(`provider-${streamCalls}`)
        if (streamCalls === 2) {
          expect(context.messages[0] as unknown).toEqual(compacted)
          expect(context.messages.filter(message => message.role === 'system')).toHaveLength(1)
        }
        return completed(streamCalls === 1 ? first : second)
      },
    )

    expect(order).toEqual([
      'provider-1',
      'compaction_start',
      'compaction_end',
      'provider-2',
      'agent_end',
    ])
  })

  test('Given 顺序工具批次 When 首个工具触发取消 Then 不再执行后续工具且向后续流传递取消信号', async () => {
    const controller = new AbortController()
    const executed: string[] = []
    let providerCalls = 0
    await runAgentLoop(
      [{ role: 'user', content: '执行两个工具', timestamp: Date.now() }],
      {
        messages: [],
        tools: ['first', 'second'].map((name) => ({
          name,
          label: name,
          description: name,
          parameters: Type.Object({}),
          execute: async () => {
            executed.push(name)
            controller.abort()
            return { content: [{ type: 'text' as const, text: 'cancelled' }], details: {} }
          },
        })),
      },
      { model: MODEL as never, toolExecution: 'sequential', convertToLlm: (messages) => messages as never },
      () => {},
      controller.signal,
      async (_model, _context, options) => {
        providerCalls += 1
        if (providerCalls > 1) {
          expect(options?.signal?.aborted).toBe(true)
          return completed({ ...assistant([]), stopReason: 'aborted' })
        }
        return completed(assistant(['first', 'second'].map((name) => ({
          type: 'toolCall', id: name, name, arguments: {},
        }))))
      },
    )

    expect(executed).toEqual(['first'])
    expect(controller.signal.aborted).toBe(true)
  })

  test('ends a tool batch before follow-up scheduling when finishTurn returns end', async () => {
    let streamCalls = 0

    await runAgentLoop(
      [{ role: 'user', content: [{ type: 'text', text: 'finish' }], timestamp: Date.now() }],
      { messages: [], tools: [{
        name: 'finish',
        label: 'Finish',
        description: 'finish',
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text', text: 'finished' }], details: {} }),
      }] },
      {
        model: MODEL as never,
        convertToLlm: (messages) => messages as never,
        finishTurn: async () => ({ action: 'end' }),
      },
      () => {},
      undefined,
      async () => {
        streamCalls += 1
        return completed(assistant([{ type: 'toolCall', id: 'call-1', name: 'finish', arguments: {} }]))
      },
    )

    expect(streamCalls).toBe(1)
  })
})

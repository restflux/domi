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

describe('patched Pi Agent loop prepareNextTurn lifecycle', () => {
  test('reports whether another provider request will follow and honors a graceful inline stop', async () => {
    const events: AgentEvent[] = []
    const willContinue: boolean[] = []
    let streamCalls = 0
    const first = assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }])
    const second = assistant([{ type: 'text', text: 'done' }])

    await runAgentLoop(
      [{ role: 'user', content: [{ type: 'text', text: 'read' }], timestamp: Date.now() }],
      { systemPrompt: 'test', messages: [], tools: [{
        name: 'read',
        label: 'Read',
        description: 'read',
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text', text: 'result' }], details: {} }),
      }] },
      {
        model: MODEL as never,
        convertToLlm: (messages) => messages as never,
        prepareNextTurn: (turn) => {
          willContinue.push(turn.willContinue)
          return turn.willContinue ? { stop: true } : undefined
        },
      },
      (event) => { events.push(event) },
      undefined,
      async () => {
        streamCalls += 1
        return completed(streamCalls === 1 ? first : second)
      },
    )

    expect(willContinue).toEqual([true])
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
      { systemPrompt: 'test', messages: [], tools: [{
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
          if (!turn.willContinue) return undefined
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
        if (streamCalls === 2) expect(context.messages as unknown[]).toEqual([compacted])
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

  test('ends terminating tool batches before next-turn preparation', async () => {
    const willContinue: boolean[] = []
    let endedByTool: boolean | undefined
    let streamCalls = 0

    await runAgentLoop(
      [{ role: 'user', content: [{ type: 'text', text: 'finish' }], timestamp: Date.now() }],
      { systemPrompt: 'test', messages: [], tools: [{
        name: 'finish',
        label: 'Finish',
        description: 'finish',
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text', text: 'finished' }], details: {}, terminate: true }),
      }] },
      {
        model: MODEL as never,
        convertToLlm: (messages) => messages as never,
        prepareNextTurn: (turn) => {
          willContinue.push(turn.willContinue)
          return undefined
        },
        getFollowUpMessages: async () => [{
          role: 'user',
          content: [{ type: 'text', text: 'must not run after termination' }],
          timestamp: Date.now(),
        }],
      },
      (event) => {
        if (event.type === 'agent_end') {
          endedByTool = (event as AgentEvent & { terminatedByTool?: boolean }).terminatedByTool
        }
      },
      undefined,
      async () => {
        streamCalls += 1
        return completed(assistant([{ type: 'toolCall', id: 'call-1', name: 'finish', arguments: {} }]))
      },
    )

    expect(willContinue).toEqual([])
    expect(endedByTool).toBe(true)
    expect(streamCalls).toBe(1)
  })
})

type InlineOutcome =
  | { status: 'not_started' }
  | { status: 'compacted'; result: unknown }
  | { status: 'failed'; errorMessage: string }
  | { status: 'aborted' }

interface InlineTestSession {
  agent: {
    state: { messages: AgentMessage[]; tools: unknown[]; model: typeof MODEL; thinkingLevel: 'off' }
    prepareNextTurn?: (signal?: AbortSignal) => Promise<unknown>
    prepareNextTurnWithContext?: (turn: PrepareNextTurnContext, signal?: AbortSignal) => Promise<Record<string, unknown> | undefined>
    prepareRequestWithContext?: (request: { context: PrepareNextTurnContext['context']; runtimeContext: PrepareNextTurnContext['context'] }, signal?: AbortSignal) => Promise<Record<string, unknown> | undefined>
    prepareRequest?: (signal?: AbortSignal) => Promise<Record<string, unknown> | undefined>
    transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>
  }
  settingsManager: { getCompactionSettings: () => { enabled: boolean; reserveTokens: number; keepRecentTokens: number } }
  _baseSystemPrompt: string
  _systemPromptOverride?: string
  _lastAutoCompactionOutcome: InlineOutcome
  _runAutoCompaction: (reason: string, willRetry: boolean, inline?: boolean) => Promise<boolean>
  _appendInlineCompactionAnchor: () => void
  _withCompactionKeepRecentTokens: <T>(tokens: number, run: () => Promise<T>) => Promise<T>
  _installAgentNextTurnRefresh: () => void
  _emit: (event: unknown) => void
  supportsInlineTurnCompaction: boolean
}

function inlineTurn(): PrepareNextTurnContext {
  const message = assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], 78_000)
  const result = toolResult()
  return {
    message,
    toolResults: [result],
    context: {
      systemPrompt: 'old',
      messages: [message, result],
      tools: [],
    },
    newMessages: [message, result],
    willContinue: true,
  }
}

async function prepareInlineRequest(session: InlineTestSession, turn = inlineTurn()) {
  const nextTurn = await session.agent.prepareNextTurnWithContext?.(turn)
  const context = (nextTurn?.context ?? turn.context) as PrepareNextTurnContext['context']
  return await session.agent.prepareRequestWithContext?.({ context, runtimeContext: context })
}

function createInlineSession(): InlineTestSession {
  const session = Object.create(AgentSession.prototype) as InlineTestSession
  session.agent = {
    state: { messages: [], tools: [], model: MODEL, thinkingLevel: 'off' },
  }
  session.settingsManager = {
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 20_000, keepRecentTokens: 20_000 }),
  }
  session._baseSystemPrompt = 'refreshed'
  session._lastAutoCompactionOutcome = { status: 'not_started' }
  session._emit = () => {}
  session._appendInlineCompactionAnchor = () => {}
  return session
}

describe('patched Pi AgentSession inline compaction', () => {
  test('runs compaction inside a real Agent loop before its second provider request', async () => {
    const order: string[] = []
    let providerCalls = 0
    const compactedMessages = [{
      role: 'compactionSummary',
      summary: 'checkpoint',
      tokensBefore: 88_000,
      timestamp: Date.now(),
    }] as AgentMessage[]
    const agent = new Agent({
      initialState: {
        systemPrompt: 'test',
        model: MODEL as never,
        thinkingLevel: 'off',
        tools: [{
          name: 'read',
          label: 'Read',
          description: 'read',
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: 'text', text: 'x'.repeat(40_000) }], details: {} }),
        }],
      },
      convertToLlm: (messages) => messages as never,
      streamFn: async (_model, context) => {
        providerCalls += 1
        order.push(`provider-${providerCalls}`)
        if (providerCalls === 2) expect(context.messages as unknown[]).toEqual(compactedMessages)
        return completed(providerCalls === 1
          ? assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], 78_000)
          : assistant([{ type: 'text', text: 'continued' }]))
      },
    })
    agent.subscribe((event) => {
      if (event.type === 'turn_end') order.push('turn_end')
      if (event.type === 'agent_end') order.push('agent_end')
    })

    const session = createInlineSession()
    session.agent = agent as unknown as InlineTestSession['agent']
    session._runAutoCompaction = async (_reason, _willRetry, inline) => {
      expect(inline).toBe(true)
      order.push('compaction_start', 'compaction_end')
      agent.state.messages = compactedMessages
      session._lastAutoCompactionOutcome = { status: 'compacted', result: {} }
      return false
    }
    session._installAgentNextTurnRefresh()

    await agent.prompt('read')

    expect(order).toEqual([
      'provider-1',
      'turn_end',
      'compaction_start',
      'compaction_end',
      'provider-2',
      'turn_end',
      'agent_end',
    ])
  })

  test('keeps the persisted inline anchor out of provider context', async () => {
    const moduleUrl = pathToFileURL(resolve(
      'node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js',
    )).href
    const { convertToLlm } = await import(moduleUrl) as {
      convertToLlm: (messages: AgentMessage[]) => AgentMessage[]
    }

    expect(convertToLlm([{
      role: 'custom',
      customType: 'pi_inline_compaction_anchor',
      content: [{ type: 'text', text: 'internal boundary' }],
      display: false,
      details: { internal: true, excludeFromContext: true },
      timestamp: Date.now(),
    } as AgentMessage])).toEqual([])
  })

  test('compacts after tool results and replaces the same loop context before the next request', async () => {
    const session = createInlineSession()
    const calls: Array<{ reason: string; willRetry: boolean; inline?: boolean }> = []
    const compactedMessages = [{ role: 'compactionSummary', summary: 'checkpoint', timestamp: Date.now() }] as AgentMessage[]
    session._runAutoCompaction = async (reason, willRetry, inline) => {
      calls.push({ reason, willRetry, inline })
      session.agent.state.messages = compactedMessages
      session._lastAutoCompactionOutcome = { status: 'compacted', result: {} }
      return false
    }

    session._installAgentNextTurnRefresh()
    const snapshot = await prepareInlineRequest(session)

    expect(session.supportsInlineTurnCompaction).toBe(true)
    expect(calls).toEqual([{ reason: 'threshold', willRetry: false, inline: true }])
    expect(snapshot?.stop).toBeUndefined()
    expect((snapshot?.context as { messages: AgentMessage[] }).messages).toEqual(compactedMessages)
    expect((snapshot?.context as { systemPrompt: string }).systemPrompt).toBe('refreshed')
  })

  test('uses one aggressive anchor retry when the completed tool turn has no default cut point', async () => {
    const session = createInlineSession()
    const observedKeepRecent: number[] = []
    let attempts = 0
    let anchors = 0
    session._appendInlineCompactionAnchor = () => { anchors += 1 }
    session._runAutoCompaction = async (_reason, _willRetry, inline) => {
      expect(inline).toBe(true)
      attempts += 1
      observedKeepRecent.push(session.settingsManager.getCompactionSettings().keepRecentTokens)
      session._lastAutoCompactionOutcome = attempts === 1
        ? { status: 'not_started' }
        : { status: 'compacted', result: {} }
      return false
    }

    session._installAgentNextTurnRefresh()
    const snapshot = await prepareInlineRequest(session)

    expect(attempts).toBe(2)
    expect(anchors).toBe(1)
    expect(observedKeepRecent).toEqual([20_000, 0])
    expect(session.settingsManager.getCompactionSettings().keepRecentTokens).toBe(20_000)
    expect(snapshot?.stop).toBeUndefined()
  })

  test('allows one aggressive retry when direct post-compaction estimation remains unsafe, then fails closed', async () => {
    const session = createInlineSession()
    let attempts = 0
    let anchors = 0
    session.agent.state.messages = [{
      role: 'user',
      content: [{ type: 'text', text: 'unprojectable context '.repeat(20_000) }],
      timestamp: Date.now(),
    }]
    session._appendInlineCompactionAnchor = () => { anchors += 1 }
    session._runAutoCompaction = async () => {
      attempts += 1
      session._lastAutoCompactionOutcome = { status: 'compacted', result: {} }
      return false
    }

    session._installAgentNextTurnRefresh()
    const snapshot = await prepareInlineRequest(session)

    expect(attempts).toBe(2)
    expect(anchors).toBe(1)
    expect(snapshot?.stop).toBe(true)
  })

  test('fails closed without a second provider request when inline summarization fails', async () => {
    const session = createInlineSession()
    session._runAutoCompaction = async () => {
      session._lastAutoCompactionOutcome = { status: 'failed', errorMessage: 'summary failed' }
      return false
    }

    session._installAgentNextTurnRefresh()
    const snapshot = await prepareInlineRequest(session)

    expect(snapshot?.stop).toBe(true)
  })

  test('does not compact after agent_end from a terminating tool batch', async () => {
    const prototype = AgentSession.prototype as unknown as Record<string, unknown>
    const originalInstallToolHooks = prototype._installAgentToolHooks
    const originalInstallNextTurnRefresh = prototype._installAgentNextTurnRefresh
    const originalBuildRuntime = prototype._buildRuntime
    prototype._installAgentToolHooks = () => {}
    prototype._installAgentNextTurnRefresh = () => {}
    prototype._buildRuntime = () => {}

    try {
      let calls = 0
      const session = new AgentSession({
        agent: { state: { messages: [] }, subscribe: () => () => {}, hasQueuedMessages: () => false },
        sessionManager: { appendMessage: () => {} },
        settingsManager: { getRetrySettings: () => ({ enabled: false }) },
        resourceLoader: {},
        cwd: process.cwd(),
        modelRuntime: {},
      } as never) as unknown as {
        _handleAgentEvent: (event: AgentEvent & { terminatedByTool?: boolean }) => Promise<void>
        _handlePostAgentRun: () => Promise<boolean>
        _checkCompaction: (message: AssistantMessage) => Promise<boolean>
        _emitExtensionEvent: (event: AgentEvent) => Promise<void>
        _lastAssistantMessage: AssistantMessage | undefined
      }
      session._checkCompaction = async () => { calls += 1; return false }
      session._emitExtensionEvent = async () => {}
      session._lastAssistantMessage = inlineTurn().message as AssistantMessage

      await session._handleAgentEvent({
        type: 'agent_end',
        messages: inlineTurn().newMessages,
        terminatedByTool: true,
      } as AgentEvent & { terminatedByTool: true })
      await session._handlePostAgentRun()

      expect(calls).toBe(0)
    } finally {
      prototype._installAgentToolHooks = originalInstallToolHooks
      prototype._installAgentNextTurnRefresh = originalInstallNextTurnRefresh
      prototype._buildRuntime = originalBuildRuntime
    }
  })

  test('keeps post-agent compaction available after a normal completed turn', async () => {
    const prototype = AgentSession.prototype as unknown as Record<string, unknown>
    const originalInstallToolHooks = prototype._installAgentToolHooks
    const originalInstallNextTurnRefresh = prototype._installAgentNextTurnRefresh
    const originalBuildRuntime = prototype._buildRuntime
    prototype._installAgentToolHooks = () => {}
    prototype._installAgentNextTurnRefresh = () => {}
    prototype._buildRuntime = () => {}

    try {
      let calls = 0
      const session = new AgentSession({
        agent: { state: { messages: [] }, subscribe: () => () => {}, hasQueuedMessages: () => false },
        sessionManager: { appendMessage: () => {} },
        settingsManager: { getRetrySettings: () => ({ enabled: false }) },
        resourceLoader: {},
        cwd: process.cwd(),
        modelRuntime: {},
      } as never) as unknown as {
        _handleAgentEvent: (event: AgentEvent) => Promise<void>
        _handlePostAgentRun: () => Promise<boolean>
        _checkCompaction: (message: AssistantMessage) => Promise<boolean>
        _emitExtensionEvent: (event: AgentEvent) => Promise<void>
        _lastAssistantMessage: AssistantMessage | undefined
      }
      session._checkCompaction = async () => { calls += 1; return false }
      session._emitExtensionEvent = async () => {}
      session._lastAssistantMessage = inlineTurn().message as AssistantMessage

      await session._handleAgentEvent({ type: 'agent_end', messages: inlineTurn().newMessages })
      await session._handlePostAgentRun()

      expect(calls).toBe(1)
    } finally {
      prototype._installAgentToolHooks = originalInstallToolHooks
      prototype._installAgentNextTurnRefresh = originalInstallNextTurnRefresh
      prototype._buildRuntime = originalBuildRuntime
    }
  })
})

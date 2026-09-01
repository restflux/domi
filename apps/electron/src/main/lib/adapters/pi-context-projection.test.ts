import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Agent, type AgentEvent, type AgentMessage } from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai/compat'
import { AgentSession } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const MODEL = {
  id: 'context-projection-model',
  name: 'Context Projection Model',
  api: 'openai-completions',
  provider: 'projection-test-provider',
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

function completed(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  stream.end(message)
  return stream
}

function toolResult(text: string, overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'bash',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
    ...overrides,
  } as ToolResultMessage
}

async function loadProjectionModule() {
  const moduleUrl = pathToFileURL(resolve(
    'node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js',
  )).href
  return await import(moduleUrl) as {
    projectProviderContextMessages: (
      messages: AgentMessage[],
      options?: { maxTotalToolTextChars?: number; maxToolTextChars?: number; minToolTextChars?: number },
    ) => AgentMessage[]
  }
}

interface ProjectionTestSession {
  agent: Agent
  settingsManager: {
    getCompactionSettings: () => { enabled: boolean; reserveTokens: number; keepRecentTokens: number }
  }
  sessionManager: {
    appendCustomMessageEntry: (...args: unknown[]) => void
  }
  _baseSystemPrompt: string
  _systemPromptOverride?: string
  _lastAutoCompactionOutcome:
    | { status: 'not_started' }
    | { status: 'compacted'; result: unknown }
    | { status: 'failed'; errorMessage: string }
    | { status: 'aborted' }
  _runAutoCompaction: (reason: string, willRetry: boolean, inline?: boolean) => Promise<boolean>
  _appendInlineCompactionAnchor: () => void
  _withCompactionKeepRecentTokens: <T>(tokens: number, run: () => Promise<T>) => Promise<T>
  _installAgentNextTurnRefresh: () => void
  _emit: (event: unknown) => void
}

function createProjectionSession(agent: Agent): ProjectionTestSession {
  const session = Object.create(AgentSession.prototype) as ProjectionTestSession
  session.agent = agent
  session.settingsManager = {
    getCompactionSettings: () => ({ enabled: true, reserveTokens: 20_000, keepRecentTokens: 20_000 }),
  }
  session.sessionManager = { appendCustomMessageEntry: () => {} }
  session._baseSystemPrompt = 'test'
  session._lastAutoCompactionOutcome = { status: 'not_started' }
  session._appendInlineCompactionAnchor = () => {}
  session._emit = () => {}
  return session
}

describe('Pi provider-context-only tool output projection', () => {
  test('keeps small outputs byte-for-byte and projects large text with head, omission metadata, and tail', async () => {
    const { projectProviderContextMessages } = await loadProjectionModule()
    const small = toolResult('small output')
    const largeText = `HEAD:${'a'.repeat(40_000)}:MIDDLE:${'b'.repeat(40_000)}:TAIL:exit code 17\nD:/workspace/file.ts`
    const large = toolResult(largeText, { isError: true })
    const source = [small, large] as AgentMessage[]

    const projected = projectProviderContextMessages(source, {
      maxTotalToolTextChars: 12_000,
      maxToolTextChars: 12_000,
      minToolTextChars: 4_000,
    })

    expect(projected[0]).toBe(small)
    expect(source[1]).toBe(large)
    expect((large.content[0] as { text: string }).text).toBe(largeText)

    const projectedLarge = projected[1] as ToolResultMessage
    const projectedText = (projectedLarge.content[0] as { text: string }).text
    expect(projectedLarge).not.toBe(large)
    expect(projectedLarge.toolCallId).toBe('call-1')
    expect(projectedLarge.toolName).toBe('bash')
    expect(projectedLarge.isError).toBe(true)
    expect(projectedText).toStartWith('HEAD:')
    expect(projectedText).toContain('characters omitted from provider context')
    expect(projectedText).toContain(`Original tool output: ${largeText.length} characters`)
    expect(projectedText).toEndWith('TAIL:exit code 17\nD:/workspace/file.ts')
    expect(projectedText).not.toContain(':MIDDLE:')
    expect(projectedText.length).toBeLessThan(13_000)
  })

  test('keeps the SessionManager transcript entry complete after building a projected provider copy', async () => {
    const { projectProviderContextMessages } = await loadProjectionModule()
    const managerUrl = pathToFileURL(resolve(
      'node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js',
    )).href
    const { SessionManager } = await import(managerUrl) as {
      SessionManager: { inMemory: (cwd?: string) => {
        appendMessage: (message: AgentMessage) => string
        buildSessionContext: () => { messages: AgentMessage[] }
        getEntries: () => Array<{ type: string; message?: AgentMessage }>
      } }
    }
    const rawText = `persisted-head\n${'p'.repeat(80_000)}\npersisted-tail`
    const manager = SessionManager.inMemory('D:/workspace')
    const persistedMessage = toolResult(rawText)
    manager.appendMessage(persistedMessage)

    const projected = projectProviderContextMessages(manager.buildSessionContext().messages, {
      maxTotalToolTextChars: 8_000,
      maxToolTextChars: 8_000,
      minToolTextChars: 4_000,
    })

    expect((((projected[0] as ToolResultMessage).content[0]) as { text: string }).text).toContain('characters omitted from provider context')
    const entry = manager.getEntries().find((candidate) => candidate.type === 'message')
    expect(((((entry?.message as ToolResultMessage).content[0]) as { text: string }).text)).toBe(rawText)
  })

  test('shares a bounded projection budget across multiple large tool results without mutating persisted messages', async () => {
    const { projectProviderContextMessages } = await loadProjectionModule()
    const firstText = `first-head\n${'1'.repeat(50_000)}\nfirst-tail`
    const secondText = `second-head\n${'2'.repeat(50_000)}\nsecond-tail`
    const source = [toolResult(firstText), toolResult(secondText, { toolCallId: 'call-2', toolName: 'grep' })] as AgentMessage[]

    const projected = projectProviderContextMessages(source, {
      maxTotalToolTextChars: 12_000,
      maxToolTextChars: 10_000,
      minToolTextChars: 4_000,
    })

    const projectedTexts = projected.map((message) => (
      ((message as ToolResultMessage).content[0] as { text: string }).text
    ))
    expect(projectedTexts.join('').length).toBeLessThan(14_000)
    expect(projectedTexts[0]).toStartWith('first-head')
    expect(projectedTexts[0]).toEndWith('first-tail')
    expect(projectedTexts[1]).toStartWith('second-head')
    expect(projectedTexts[1]).toEndWith('second-tail')
    expect(((source[0] as ToolResultMessage).content[0] as { text: string }).text).toBe(firstText)
    expect(((source[1] as ToolResultMessage).content[0] as { text: string }).text).toBe(secondText)
  })
})

describe('Pi pre-request projection and hard guard', () => {
  test('projects a huge tool result before threshold evaluation and skips summarization when projected context is safe', async () => {
    const rawText = `HEAD\n${'x'.repeat(200_000)}\nTAIL exit code 0`
    let providerCalls = 0
    let compactionCalls = 0
    let secondRequestText = ''
    const agent = new Agent({
      initialState: {
        systemPrompt: 'test',
        model: MODEL as never,
        thinkingLevel: 'off',
        tools: [{
          name: 'bash',
          label: 'Bash',
          description: 'bash',
          parameters: Type.Object({}),
          execute: async () => ({ content: [{ type: 'text', text: rawText }], details: { exitCode: 0 } }),
        }],
      },
      convertToLlm: (messages) => messages as never,
      streamFn: async (_model, context) => {
        providerCalls += 1
        if (providerCalls === 2) {
          const result = context.messages.find((message) => message.role === 'toolResult') as ToolResultMessage
          secondRequestText = (result.content[0] as { text: string }).text
        }
        return completed(providerCalls === 1
          ? assistant([{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }], 70_000)
          : assistant([{ type: 'text', text: 'continued' }]))
      },
    })
    const session = createProjectionSession(agent)
    session._runAutoCompaction = async () => {
      compactionCalls += 1
      session._lastAutoCompactionOutcome = { status: 'failed', errorMessage: 'should not compact' }
      return false
    }
    session._installAgentNextTurnRefresh()

    await agent.prompt('run')

    expect(providerCalls).toBe(2)
    expect(compactionCalls).toBe(0)
    expect(secondRequestText).toStartWith('HEAD')
    expect(secondRequestText).toContain('characters omitted from provider context')
    expect(secondRequestText).toEndWith('TAIL exit code 0')
    const persisted = agent.state.messages.find((message) => message.role === 'toolResult') as ToolResultMessage
    expect((persisted.content[0] as { text: string }).text).toBe(rawText)
  })

  test('uses one aggressive retry only when the first compacted provider context is genuinely still unsafe', async () => {
    let providerCalls = 0
    let compactionCalls = 0
    let anchors = 0
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
          execute: async () => ({ content: [{ type: 'text', text: 'x'.repeat(80_000) }], details: {} }),
        }],
      },
      convertToLlm: (messages) => messages as never,
      streamFn: async () => {
        providerCalls += 1
        return completed(providerCalls === 1
          ? assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], 78_000)
          : assistant([{ type: 'text', text: 'continued after aggressive retry' }]))
      },
    })
    const session = createProjectionSession(agent)
    session._appendInlineCompactionAnchor = () => { anchors += 1 }
    session._runAutoCompaction = async (_reason, _willRetry, inline) => {
      expect(inline).toBe(true)
      compactionCalls += 1
      agent.state.messages = compactionCalls === 1
        ? [{
            role: 'user',
            content: [{ type: 'text', text: 'unprojectable user context '.repeat(20_000) }],
            timestamp: Date.now(),
          }]
        : [{ role: 'compactionSummary', summary: 'aggressive checkpoint', tokensBefore: 88_000, timestamp: Date.now() }]
      session._lastAutoCompactionOutcome = { status: 'compacted', result: {} }
      return false
    }
    session._installAgentNextTurnRefresh()

    await agent.prompt('read')

    expect(compactionCalls).toBe(2)
    expect(anchors).toBe(1)
    expect(providerCalls).toBe(2)
  })

  test('fails closed after one aggressive retry when the final rebuilt context remains unsafe', async () => {
    let providerCalls = 0
    let compactionCalls = 0
    let anchors = 0
    const events: AgentEvent[] = []
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
          execute: async () => ({ content: [{ type: 'text', text: 'x'.repeat(80_000) }], details: {} }),
        }],
      },
      convertToLlm: (messages) => messages as never,
      streamFn: async () => {
        providerCalls += 1
        return completed(assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], 78_000))
      },
    })
    agent.subscribe((event) => { events.push(event) })
    const session = createProjectionSession(agent)
    session._appendInlineCompactionAnchor = () => { anchors += 1 }
    session._runAutoCompaction = async (_reason, _willRetry, inline) => {
      expect(inline).toBe(true)
      compactionCalls += 1
      agent.state.messages = [{
        role: 'user',
        content: [{ type: 'text', text: 'still unsafe '.repeat(40_000) }],
        timestamp: Date.now(),
      }]
      session._lastAutoCompactionOutcome = { status: 'compacted', result: {} }
      return false
    }
    session._installAgentNextTurnRefresh()

    await agent.prompt('read')

    expect(compactionCalls).toBe(2)
    expect(anchors).toBe(1)
    expect(providerCalls).toBe(1)
    expect(events.at(-1)?.type).toBe('agent_end')
  })

  test('ignores retained pre-compaction assistant usage when estimating the rebuilt provider request', async () => {
    for (const staleTokens of [229_094, 217_939]) {
      const staleAssistant = assistant([{ type: 'text', text: 'retained prefix' }], staleTokens)
      staleAssistant.timestamp = 1_000
      const messages: AgentMessage[] = [
        { role: 'compactionSummary', summary: 'checkpoint', tokensBefore: staleTokens, timestamp: 2_000 },
        staleAssistant,
        { role: 'user', content: [{ type: 'text', text: 'continue' }], timestamp: 3_000 },
      ]
      const agent = new Agent({
        initialState: {
          systemPrompt: 'test',
          model: { ...MODEL, contextWindow: 272_000 } as never,
          thinkingLevel: 'off',
          tools: [],
          messages,
        },
        convertToLlm: value => value as never,
        streamFn: async () => completed(assistant([{ type: 'text', text: 'unused' }])),
      })
      const session = createProjectionSession(agent)
      session.settingsManager.getCompactionSettings = () => ({ enabled: true, reserveTokens: 54_400, keepRecentTokens: 20_000 })
      let compactionCalls = 0
      session._runAutoCompaction = async () => {
        compactionCalls += 1
        session._lastAutoCompactionOutcome = { status: 'failed', errorMessage: 'stale usage escaped boundary' }
        return false
      }
      session._installAgentNextTurnRefresh()

      const snapshot = await agent.prepareRequestWithContext?.({
        context: { systemPrompt: 'test', messages, tools: [] },
        runtimeContext: { systemPrompt: 'test', messages, tools: [] },
      })

      expect(compactionCalls).toBe(0)
      expect(snapshot?.stop).toBeUndefined()
    }
  })

  test('stops without a second provider request when inline compaction is cancelled', async () => {
    let providerCalls = 0
    let compactionCalls = 0
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
          execute: async () => ({ content: [{ type: 'text', text: 'x'.repeat(80_000) }], details: {} }),
        }],
      },
      convertToLlm: (messages) => messages as never,
      streamFn: async () => {
        providerCalls += 1
        return completed(assistant([{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], 78_000))
      },
    })
    const session = createProjectionSession(agent)
    session._runAutoCompaction = async () => {
      compactionCalls += 1
      session._lastAutoCompactionOutcome = { status: 'aborted' }
      return false
    }
    session._installAgentNextTurnRefresh()

    await agent.prompt('read')

    expect(compactionCalls).toBe(1)
    expect(providerCalls).toBe(1)
  })

  test('applies the same hard guard to queued follow-up context before another provider request', async () => {
    let providerCalls = 0
    let compactionCalls = 0
    const agent = new Agent({
      initialState: {
        systemPrompt: 'test',
        model: MODEL as never,
        thinkingLevel: 'off',
        tools: [],
      },
      convertToLlm: (messages) => messages as never,
      streamFn: async () => {
        providerCalls += 1
        return completed(assistant([{ type: 'text', text: 'first response' }], 79_000))
      },
    })
    const session = createProjectionSession(agent)
    session._runAutoCompaction = async () => {
      compactionCalls += 1
      session._lastAutoCompactionOutcome = { status: 'failed', errorMessage: 'follow-up context unsafe' }
      return false
    }
    session._installAgentNextTurnRefresh()
    agent.followUp({
      role: 'user',
      content: [{ type: 'text', text: 'follow-up '.repeat(4_000) }],
      timestamp: Date.now(),
    })

    await agent.prompt('hello')

    expect(providerCalls).toBe(1)
    expect(compactionCalls).toBe(1)
  })

  test('applies the hard guard to extension-transformed context before the initial provider request', async () => {
    let providerCalls = 0
    let compactionCalls = 0
    const agent = new Agent({
      initialState: {
        systemPrompt: 'test',
        model: MODEL as never,
        thinkingLevel: 'off',
        tools: [],
      },
      convertToLlm: (messages) => messages as never,
      transformContext: async (messages) => [{
        role: 'user',
        content: [{ type: 'text', text: 'extension context '.repeat(30_000) }],
        timestamp: Date.now(),
      }, ...messages],
      streamFn: async () => {
        providerCalls += 1
        return completed(assistant([{ type: 'text', text: 'unsafe request escaped' }]))
      },
    })
    const session = createProjectionSession(agent)
    session._runAutoCompaction = async () => {
      compactionCalls += 1
      session._lastAutoCompactionOutcome = { status: 'failed', errorMessage: 'no safe cut point' }
      return false
    }
    session._installAgentNextTurnRefresh()

    await agent.prompt('hello')

    expect(compactionCalls).toBe(1)
    expect(providerCalls).toBe(0)
  })
})

describe('Pi fast single-request compaction summary', () => {
  test('projects large tool output and summarizes split-turn history with one provider request', async () => {
    const moduleUrl = pathToFileURL(resolve(
      'node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js',
    )).href
    const utilsUrl = pathToFileURL(resolve(
      'node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/utils.js',
    )).href
    const { compact } = await import(moduleUrl) as {
      compact: (...args: unknown[]) => Promise<{ summary: string }>
    }
    const { createFileOps } = await import(utilsUrl) as {
      createFileOps: () => unknown
    }
    const rawText = `SUMMARY-HEAD\n${'z'.repeat(180_000)}\nSUMMARY-TAIL exit code 9`
    const sourceToolResult = toolResult(rawText, { isError: true })
    let summaryRequests = 0
    let summaryPrompt = ''

    const result = await compact(
      {
        firstKeptEntryId: 'keep-1',
        messagesToSummarize: [
          { role: 'user', content: [{ type: 'text', text: 'prior request' }], timestamp: Date.now() },
          assistant([{ type: 'text', text: 'prior answer' }]),
        ],
        turnPrefixMessages: [
          { role: 'user', content: [{ type: 'text', text: 'current request' }], timestamp: Date.now() },
          assistant([{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: {} }]),
          sourceToolResult,
        ],
        isSplitTurn: true,
        tokensBefore: 120_000,
        fileOps: createFileOps(),
        settings: { enabled: true, reserveTokens: 20_000, keepRecentTokens: 20_000 },
      },
      MODEL,
      'test-key',
      undefined,
      undefined,
      undefined,
      'off',
      async (_model: unknown, context: { messages: Array<{ content: Array<{ text?: string }> }> }) => {
        summaryRequests += 1
        summaryPrompt = context.messages[0]?.content[0]?.text ?? ''
        return completed(assistant([{ type: 'text', text: 'single checkpoint' }]))
      },
    )

    expect(result.summary).toContain('single checkpoint')
    expect(summaryRequests).toBe(1)
    expect(summaryPrompt).toContain('SUMMARY-HEAD')
    expect(summaryPrompt).toContain('characters omitted from provider context')
    expect(summaryPrompt).toContain('SUMMARY-TAIL exit code 9')
    expect(summaryPrompt).not.toContain('z'.repeat(40_000))
    expect((sourceToolResult.content[0] as { text: string }).text).toBe(rawText)
  })

  test('caps checkpoint output at 6144 tokens, shrinks update instructions, and limits rendered file lists', async () => {
    const moduleUrl = pathToFileURL(resolve(
      'node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js',
    )).href
    const utilsUrl = pathToFileURL(resolve(
      'node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/utils.js',
    )).href
    const { compact } = await import(moduleUrl) as {
      compact: (...args: unknown[]) => Promise<{
        summary: string
        details: { readFiles: string[]; modifiedFiles: string[] }
      }>
    }
    const { createFileOps } = await import(utilsUrl) as {
      createFileOps: () => { read: Set<string>; written: Set<string>; edited: Set<string> }
    }
    const fileOps = createFileOps()
    for (let index = 0; index < 35; index += 1) {
      fileOps.read.add(`D:/workspace/read-${String(index).padStart(2, '0')}.ts`)
      fileOps.edited.add(`D:/workspace/edited-${String(index).padStart(2, '0')}.ts`)
    }
    let maxTokens = 0
    let summaryPrompt = ''

    const result = await compact(
      {
        firstKeptEntryId: 'keep-1',
        messagesToSummarize: [
          { role: 'user', content: [{ type: 'text', text: 'Update the implementation.' }], timestamp: Date.now() },
        ],
        turnPrefixMessages: [],
        isSplitTurn: false,
        tokensBefore: 220_000,
        previousSummary: '## Progress\n### Done\n- [x] Old duplicate item',
        fileOps,
        settings: { enabled: true, reserveTokens: 54_400, keepRecentTokens: 20_000 },
      },
      { ...MODEL, maxTokens: 32_000 },
      'test-key',
      undefined,
      undefined,
      undefined,
      'off',
      async (_model: unknown, context: { messages: Array<{ content: Array<{ text?: string }> }> }, options: { maxTokens?: number }) => {
        maxTokens = options.maxTokens ?? 0
        summaryPrompt = context.messages[0]?.content[0]?.text ?? ''
        return completed(assistant([{ type: 'text', text: '## Goal\nContinue.\n\n## Next Steps\n1. Verify.' }]))
      },
    )

    expect(maxTokens).toBe(6_144)
    expect(summaryPrompt).toContain('Aim for 2500-4000 tokens')
    expect(summaryPrompt).toContain('Merge duplicate completed items')
    expect(summaryPrompt).toContain('Remove superseded or stale history')
    expect(summaryPrompt).not.toContain('PRESERVE all existing information')
    expect(result.details.readFiles).toHaveLength(35)
    expect(result.details.modifiedFiles).toHaveLength(35)
    expect(result.summary).toContain('additional read files omitted from checkpoint')
    expect(result.summary).toContain('additional modified files omitted from checkpoint')
    expect(result.summary).not.toContain('read-34.ts')
    expect(result.summary).not.toContain('edited-34.ts')
  })

  test('caps retained provider history at 20000 tokens while preserving persisted tool-call/result continuity', async () => {
    const moduleUrl = pathToFileURL(resolve(
      'node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js',
    )).href
    const { prepareCompaction } = await import(moduleUrl) as {
      prepareCompaction: (entries: Array<Record<string, unknown>>, settings: {
        enabled: boolean; reserveTokens: number; keepRecentTokens: number
      }) => { firstKeptEntryId: string; messagesToSummarize: AgentMessage[] } | undefined
    }
    const entries: Array<Record<string, unknown>> = []
    let parentId: string | null = null
    const appendMessage = (id: string, message: AgentMessage) => {
      entries.push({
        type: 'message', id, parentId, timestamp: new Date(message.timestamp ?? Date.now()).toISOString(), message,
      })
      parentId = id
    }
    for (let turnIndex = 0; turnIndex < 7; turnIndex += 1) {
      appendMessage(`u-${turnIndex}`, {
        role: 'user',
        content: [{ type: 'text', text: `request-${turnIndex}: ${'u'.repeat(8_000)}` }],
        timestamp: 1_000 + turnIndex * 10,
      })
      appendMessage(`a-${turnIndex}`, assistant([{ type: 'text', text: `answer-${turnIndex}: ${'a'.repeat(8_000)}` }], 0))
    }
    appendMessage('u-tool', {
      role: 'user',
      content: [{ type: 'text', text: 'inspect the final build output' }],
      timestamp: 2_000,
    })
    appendMessage('a-tool', assistant([{
      type: 'toolCall', id: 'retained-call', name: 'bash', arguments: { command: 'build' },
    }], 0))
    appendMessage('r-tool', toolResult(`build head\n${'r'.repeat(30_000)}\nbuild tail`, {
      toolCallId: 'retained-call',
    }))
    const source = structuredClone(entries)

    const preparation = prepareCompaction(entries, {
      enabled: true,
      reserveTokens: 54_400,
      keepRecentTokens: 80_000,
    })

    expect(preparation).toBeDefined()
    expect(preparation?.messagesToSummarize.length).toBeGreaterThan(0)
    const firstKeptIndex = entries.findIndex(entry => entry.id === preparation?.firstKeptEntryId)
    expect(firstKeptIndex).toBeGreaterThan(0)
    expect(entries[firstKeptIndex]?.type).toBe('message')
    expect((entries[firstKeptIndex]?.message as AgentMessage).role).not.toBe('toolResult')
    const keptMessages = entries.slice(firstKeptIndex).map(entry => entry.message as AgentMessage)
    const retainedResultIndex = keptMessages.findIndex(message => (
      message.role === 'toolResult' && message.toolCallId === 'retained-call'
    ))
    const retainedCallIndex = keptMessages.findIndex(message => (
      message.role === 'assistant' && message.content.some(block => (
        block.type === 'toolCall' && block.id === 'retained-call'
      ))
    ))
    expect(retainedResultIndex).toBeGreaterThan(retainedCallIndex)
    expect(retainedCallIndex).toBeGreaterThanOrEqual(0)
    expect(entries).toEqual(source)
  })
})

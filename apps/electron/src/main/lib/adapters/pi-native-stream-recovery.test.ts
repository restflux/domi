import { describe, expect, test } from 'bun:test'
import { Type } from 'typebox'
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import type { AssistantMessage, Message, Model } from '@earendil-works/pi-ai'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { createPiRetryTerminalGate, mapPiNativeRetryEvent } from './pi-retry-control.ts'
import type { PiRetryUpdate } from './pi-retry-control.ts'

const STREAM_ERROR = 'stream error: stream disconnected before completion: stream closed before response.completed'
const TOOL_NAME = 'record_completed_step'
const MODEL: Model<'openai-responses'> = {
  id: 'stream-recovery-test', name: '本地断流恢复测试', provider: 'domi-stream-recovery-test', api: 'openai-responses',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
  contextWindow: 200_000, maxTokens: 4_096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant', api: MODEL.api, provider: MODEL.provider, model: MODEL.id,
    content: [{ type: 'text', text: '完成' }], stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...overrides,
  }
}

interface RecoveryScenario {
  failures: number
  errorMessage?: string
  maxRetries?: number
  cancelOnRetry?: boolean
}

/** 使用真正的公开 Session.prompt 与内存工具；所有模型响应在进程内返回。 */
async function runScenario(scenario: RecoveryScenario) {
  const cwd = process.cwd()
  const manager = SessionManager.inMemory(cwd)
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: scenario.maxRetries ?? 2, baseDelayMs: scenario.cancelOnRetry ? 100 : 0 },
  })
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  })
  runtime.registerProvider(MODEL.provider, { api: MODEL.api, baseUrl: MODEL.baseUrl, apiKey: 'test-no-network', models: [MODEL] })
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager: settings, noExtensions: true, disabledBuiltinExtensions: ['mcp'],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  })
  await loader.reload()
  let toolExecutions = 0
  const { session } = await createAgentSession({
    cwd, agentDir: cwd, model: MODEL, modelRuntime: runtime, resourceLoader: loader,
    sessionManager: manager, settingsManager: settings, tools: [TOOL_NAME],
    customTools: [{
      name: TOOL_NAME, label: '记录完成步骤', description: '仅在内存中记录一次工具执行', parameters: Type.Object({}),
      execute: async () => {
        toolExecutions += 1
        return { content: [{ type: 'text', text: '已完成，不需要再次执行' }], details: {} }
      },
    }],
  })
  const requests: Message[][] = []
  const events: AgentSessionEvent[] = []
  const updates: PiRetryUpdate[] = []
  const delivered: AssistantMessage[] = []
  const gate = createPiRetryTerminalGate<AssistantMessage>()
  let cancellation: ReturnType<typeof setTimeout> | undefined
  try {
    await session.bindExtensions({})
    session.agent.streamFunction = (_model, context) => {
      requests.push([...context.messages])
      const ordinal = requests.length
      const response = ordinal === 1
        ? assistant({ stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'completed-step', name: TOOL_NAME, arguments: {} }] })
        : ordinal <= scenario.failures + 1
          ? assistant({ stopReason: 'error', content: [], errorMessage: scenario.errorMessage ?? STREAM_ERROR })
          : assistant()
      const stream = createAssistantMessageEventStream()
      stream.end(response)
      return stream
    }
    session.subscribe((event) => {
      events.push(event)
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        if (event.message.stopReason === 'error') gate.defer(event.message)
        else if (event.message.stopReason === 'stop') delivered.push(event.message)
      } else if (event.type === 'agent_end') {
        const terminal = gate.settle(event.willRetry || !!scenario.cancelOnRetry)
        if (terminal) delivered.push(terminal)
      } else if (event.type === 'auto_retry_start' || event.type === 'auto_retry_end') {
        updates.push(...mapPiNativeRetryEvent(event, { runStartedAt: 1 }))
        if (event.type === 'auto_retry_start' && scenario.cancelOnRetry) {
          // 原生 Session 在发出 start 后才创建 backoff controller，下一事件循环再停止。
          cancellation = setTimeout(() => { void session.abort() }, 0)
        }
      }
    })
    await session.prompt('完成一步后继续，不重复已完成操作')
    await session.waitForIdle()
    expect(events.at(-1)?.type).toBe('agent_settled')
    expect(gate.peek()).toBeUndefined()
    return { requests, events, updates, delivered, toolExecutions, projection: manager.buildSessionProjection().messages }
  } finally {
    clearTimeout(cancellation)
    session.dispose()
  }
}

function expectCompletedToolPreserved(result: Awaited<ReturnType<typeof runScenario>>) {
  expect(result.toolExecutions).toBe(1)
  for (const request of result.requests.slice(1)) {
    expect(request.filter(message => message.role === 'user')).toHaveLength(1)
    expect(request.filter(message => message.role === 'toolResult')).toHaveLength(1)
    expect(request).toContainEqual(expect.objectContaining({ role: 'toolResult', toolCallId: 'completed-step' }))
  }
  expect(result.projection.filter(message => message.role === 'toolResult')).toHaveLength(1)
}

describe('Responses 断流的原生会话恢复', () => {
  test('Given 已完成工具后断流 When 原生续跑成功 Then 不重投用户任务且不重放工具', async () => {
    const result = await runScenario({ failures: 1 })
    expectCompletedToolPreserved(result)
    expect(result.requests).toHaveLength(3)
    expect(result.delivered).toHaveLength(1)
    expect(result.delivered[0]?.stopReason).toBe('stop')
    expect(result.updates.map(update => update.status)).toEqual(['starting', 'cleared'])
    expect(result.events.filter(event => event.type === 'agent_end').map(event => event.willRetry)).toEqual([true, false])
    expect(result.requests[2]?.some(message => message.role === 'assistant' && message.stopReason === 'error')).toBe(false)
  })

  test('Given 持续断流 When 两次重试耗尽 Then 只释放最终错误并停止模型调用', async () => {
    const result = await runScenario({ failures: 10, maxRetries: 2 })
    expectCompletedToolPreserved(result)
    expect(result.requests).toHaveLength(4)
    expect(result.delivered).toHaveLength(1)
    expect(result.delivered[0]).toMatchObject({ stopReason: 'error', errorMessage: STREAM_ERROR })
    expect(result.updates.map(update => update.status)).toEqual(['starting', 'starting', 'failed'])
    expect(result.updates.at(-1)).toMatchObject({ attempt: 2, attemptData: { errorMessage: STREAM_ERROR } })
  })

  test('Given 断流重试等待中 When 用户停止 Then 不再发出请求且显示已取消', async () => {
    const result = await runScenario({ failures: 10, cancelOnRetry: true })
    expectCompletedToolPreserved(result)
    expect(result.requests).toHaveLength(2)
    expect(result.delivered).toEqual([])
    expect(result.updates.map(update => update.status)).toEqual(['starting', 'cancelled'])
  })

  test.each([
    '401 invalid_api_key: authentication failed',
    `429 insufficient_quota: billing limit reached; ${STREAM_ERROR}`,
    'stream disconnected before a local marker',
    'stream closed before responseXcompleted',
  ])('Given 永久性或无关错误 "%s" Then 不自动重试', async (errorMessage) => {
    const result = await runScenario({ failures: 10, errorMessage })
    expectCompletedToolPreserved(result)
    expect(result.requests).toHaveLength(2)
    expect(result.updates).toEqual([])
    expect(result.delivered).toHaveLength(1)
    expect(result.delivered[0]).toMatchObject({ stopReason: 'error', errorMessage })
  })
})

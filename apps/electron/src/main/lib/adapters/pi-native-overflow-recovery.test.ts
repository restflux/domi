import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  isContextOverflow,
  isRecoverableLength,
} from '@earendil-works/pi-ai'
import type { AssistantMessage, Model } from '@earendil-works/pi-ai'
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { createPiAssistantUuidTracker } from './pi-agent-adapter'
import {
  createPiOverflowRecoveryState,
  shouldDeferPiOverflowTerminalError,
  shouldDeferPiOverflowTerminalMessage,
} from './pi-overflow-recovery'
import { createPiRetryTerminalGate } from './pi-retry-control'

const CLASSIFIERS = { isContextOverflow, isRecoverableLength }
const MODEL: Model<'openai-completions'> = {
  id: 'native-recovery-model',
  name: 'Native Recovery Model',
  api: 'openai-completions',
  provider: 'native-recovery-provider',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text: '完整回答' }],
    api: MODEL.api, provider: MODEL.provider, model: MODEL.id,
    stopReason: 'stop', timestamp: Date.now(),
    usage: {
      input: 1_000, output: 128, cacheRead: 0, cacheWrite: 0, totalTokens: 1_128,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  }
}

interface RecoveryScenario {
  responses: AssistantMessage[]
  compaction?: 'success' | 'fail' | 'abort'
  enabled?: boolean
  preserveResponseTimestamp?: boolean
  beforePrompt?: (session: AgentSession) => void
  afterTurn?: (session: AgentSession) => void | Promise<void>
}

/** 真正的 Session.prompt/投影/压缩事件驱动宿主 gate；不访问 SDK 私有恢复方法。 */
async function runRecoveryScenario(scenario: RecoveryScenario) {
  const cwd = mkdtempSync(join(tmpdir(), 'domi-pi-native-recovery-'))
  const manager = SessionManager.inMemory(cwd)
  manager.appendMessage({ role: 'user', content: '旧历史'.repeat(3_000), timestamp: 1 })
  manager.appendMessage(assistant({ timestamp: 2, content: [{ type: 'text', text: '旧回答'.repeat(3_000) }] }))
  const settings = SettingsManager.inMemory({
    compaction: { enabled: scenario.enabled ?? true, reserveTokens: 10_000, keepRecentTokens: 1_000 },
    retry: { enabled: false },
  })
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false,
  })
  runtime.registerProvider(MODEL.provider, {
    api: MODEL.api, baseUrl: MODEL.baseUrl, apiKey: 'test-no-network', models: [MODEL],
  })
  const gate = createPiRetryTerminalGate<{ message: AssistantMessage; uuid: string }>()
  const recovery = createPiOverflowRecoveryState()
  let uuidCount = 0
  const tracker = createPiAssistantUuidTracker(() => `assistant-${++uuidCount}`)
  const delivered: Array<{ message: AssistantMessage; uuid: string }> = []
  const events: AgentSessionEvent[] = []
  const providerMessages: Array<readonly { role: string }[]> = []
  let compactionCalls = 0
  let summarizationCalls = 0
  let aborted = false
  let session: AgentSession | undefined
  const loader = new DefaultResourceLoader({
    cwd, agentDir: cwd, settingsManager: settings,
    noExtensions: true, disabledBuiltinExtensions: ['mcp'],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => {
      pi.on('turn_end', async () => {
        if (session) await scenario.afterTurn?.(session)
      })
      pi.on('session_before_compact', (event) => {
        compactionCalls += 1
        if (scenario.compaction === 'fail') return
        return { compaction: {
          summary: '原生恢复 checkpoint', firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        } }
      })
    }],
  })
  try {
    await loader.reload()
    const result = await createAgentSession({
      cwd, agentDir: cwd, model: MODEL, modelRuntime: runtime,
      resourceLoader: loader, sessionManager: manager, settingsManager: settings, noTools: 'all',
    })
    const active = result.session
    session = active
    await active.bindExtensions({})
    // 所有 Provider 调用都在进程内返回；不读取全局凭据、不付费调用真实 API。
    active.agent.streamFunction = (_model, context, options) => {
      const stream = createAssistantMessageEventStream()
      if (options?.sessionId !== manager.getSessionId()) {
        summarizationCalls += 1
        expect(scenario.compaction).toBe('fail')
        stream.end(assistant({ stopReason: 'error', content: [], errorMessage: 'test compaction failure' }))
        return stream
      }
      providerMessages.push(context.messages)
      const message = scenario.responses[providerMessages.length - 1]
      if (!message) throw new Error('unexpected extra provider call')
      if (!scenario.preserveResponseTimestamp) {
        // 响应在实际请求返回时产生，尤其恢复响应必须位于新压缩边界之后。
        const latestCompaction = manager.getBranch().findLast(entry => entry.type === 'compaction')
        message.timestamp = Math.max(Date.now(), latestCompaction ? Date.parse(latestCompaction.timestamp) + 1 : 0)
      }
      stream.end(message)
      return stream
    }
    const settle = (discard: boolean) => {
      const terminal = gate.settle(discard)
      if (terminal) delivered.push(terminal)
    }
    active.subscribe((event) => {
      events.push(event)
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const message = event.message
        const terminal = { message, uuid: tracker.get() }
        if (message.stopReason === 'error' || shouldDeferPiOverflowTerminalMessage(message, active.model, CLASSIFIERS)) {
          gate.defer(terminal)
        } else {
          delivered.push(terminal)
          tracker.reset()
        }
      } else if (event.type === 'agent_end') {
        if (shouldDeferPiOverflowTerminalError(gate.peek()?.message, active.model, event.willRetry, aborted, CLASSIFIERS)) {
          recovery.defer()
        } else {
          settle(event.willRetry || aborted)
        }
      } else if (event.type === 'compaction_start' && scenario.compaction === 'abort') {
        aborted = true
        active.abortCompaction()
      } else if (event.type === 'compaction_end') {
        const action = recovery.settleCompaction({
          reason: event.reason, aborted: event.aborted, hasResult: !!event.result,
          willRetry: event.willRetry, discard: aborted,
        })
        if (action !== 'none') settle(action === 'discard')
      } else if (event.type === 'agent_settled') {
        const action = recovery.settleFallback(aborted)
        if (action !== 'none') settle(action === 'discard')
      }
    })
    scenario.beforePrompt?.(active)
    await active.prompt('继续当前任务')
    await active.waitForIdle()
    expect(gate.peek()).toBeUndefined()
    expect(recovery.isPending()).toBe(false)
    expect(events.at(-1)?.type).toBe('agent_settled')
    return { delivered, events, providerMessages, compactionCalls, summarizationCalls, manager }
  } finally {
    session?.dispose()
    rmSync(cwd, { recursive: true, force: true })
  }
}

const length = () => assistant({ stopReason: 'length', content: [{ type: 'text', text: '未完成:' }] })
const overflow = () => assistant({ stopReason: 'error', errorMessage: 'request_too_large', content: [] })

describe('Pi 1.0.4 公开 Session 恢复与 Domi 终态交付', () => {
  test.each(['overflow', 'length'])('Given %s When 原生压缩并同 transcript 续跑 Then 只交付恢复帧且 UUID 不变', async (kind) => {
    const failed = kind === 'overflow' ? overflow() : length()
    const final = assistant()
    const result = await runRecoveryScenario({ responses: [failed, final] })

    expect(result.compactionCalls).toBe(1)
    expect(result.providerMessages).toHaveLength(2)
    expect(result.delivered).toEqual([{ message: final, uuid: 'assistant-1' }])
    expect(result.events.filter(event => event.type === 'compaction_start')).toEqual([{ type: 'compaction_start', reason: 'overflow' }])
    expect(result.events.findIndex(event => event.type === 'agent_end')).toBeLessThan(result.events.findIndex(event => event.type === 'compaction_start'))
    expect(result.manager.getBranch().filter(entry => entry.type === 'compaction')).toHaveLength(1)
    const failedEntry = result.manager.getEntries().find(entry => entry.type === 'message' && entry.message === failed)
    expect(failedEntry).toBeDefined()
    const projection = result.manager.buildSessionProjection()
    expect(projection.entries.find(entry => entry.sourceEntry.id === failedEntry?.id)?.messages).toEqual([])
    expect(projection.messages).not.toContainEqual(failed)
    expect(result.providerMessages[1]).not.toContainEqual(failed)
  })

  test('Given 再次 length When 原生一次恢复预算耗尽 Then 不再次压缩且释放最终错误', async () => {
    const second = length()
    const result = await runRecoveryScenario({ responses: [length(), second] })
    expect(result.compactionCalls).toBe(1)
    expect(result.providerMessages).toHaveLength(2)
    expect(result.delivered).toEqual([{ message: second, uuid: 'assistant-1' }])
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'compaction_end', reason: 'overflow', willRetry: false }))
  })

  test('Given 压缩失败 When 原生结束恢复 Then 释放原终态且不另发压缩', async () => {
    const failed = overflow()
    const result = await runRecoveryScenario({ responses: [failed], compaction: 'fail' })
    expect(result.compactionCalls).toBe(1)
    expect(result.summarizationCalls).toBe(1)
    expect(result.providerMessages).toHaveLength(1)
    expect(result.delivered).toEqual([{ message: failed, uuid: 'assistant-1' }])
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'compaction_end', result: undefined, aborted: false, willRetry: false }))
  })

  test('Given 用户取消压缩 When abortCompaction 生效 Then 丢弃待交付终态且不续跑', async () => {
    const result = await runRecoveryScenario({ responses: [length()], compaction: 'abort' })
    expect(result.compactionCalls).toBe(0)
    expect(result.providerMessages).toHaveLength(1)
    expect(result.delivered).toEqual([])
    expect(result.events).toContainEqual(expect.objectContaining({ type: 'compaction_end', aborted: true, willRetry: false }))
  })

  test('Given 限流包含 too many tokens When 原生不判为溢出 Then 正常结束而不进入 overflow 压缩', async () => {
    const failed = assistant({ stopReason: 'error', errorMessage: 'Throttling error: Too many tokens, please wait before trying again.' })
    const result = await runRecoveryScenario({ responses: [failed] })
    expect(result.compactionCalls).toBe(0)
    expect(result.providerMessages).toHaveLength(1)
    expect(result.delivered).toEqual([{ message: failed, uuid: 'assistant-1' }])
    expect(result.events.some(event => event.type === 'compaction_start')).toBe(false)
  })

  test('Given length 已用尽模型输出上限 When SDK 不恢复 Then 交付终态且不压缩', async () => {
    const failed = assistant({ stopReason: 'length' })
    failed.usage.output = MODEL.maxTokens
    failed.usage.totalTokens = failed.usage.input + MODEL.maxTokens
    const result = await runRecoveryScenario({ responses: [failed] })
    expect(result.compactionCalls).toBe(0)
    expect(result.providerMessages).toHaveLength(1)
    expect(result.delivered).toEqual([{ message: failed, uuid: 'assistant-1' }])
  })

  test('Given 原生投影已省略 length 帧 When SDK 跳过恢复 Then fallback 释放而不额外压缩', async () => {
    const failed = length()
    const result = await runRecoveryScenario({ responses: [failed], afterTurn: (active) => {
      const entry = active.sessionManager.getBranch().findLast(entry => entry.type === 'message' && entry.message === failed)
      if (!entry) throw new Error('missing persisted assistant')
      active.sessionManager.appendContextEdit(entry.id, null)
    } })
    expect(result.compactionCalls).toBe(0)
    expect(result.providerMessages).toHaveLength(1)
    expect(result.manager.buildSessionProjection().messages).not.toContainEqual(failed)
    expect(result.delivered).toEqual([{ message: failed, uuid: 'assistant-1' }])
  })

  test('Given 响应早于最新压缩边界 When SDK 跳过旧 overflow Then fallback 释放而不再次压缩', async () => {
    const failed = { ...overflow(), timestamp: 1 }
    const result = await runRecoveryScenario({ responses: [failed], preserveResponseTimestamp: true, beforePrompt: (active) => {
      const kept = active.sessionManager.getBranch().find(entry => entry.type === 'message')
      if (!kept) throw new Error('missing retained history')
      active.sessionManager.appendCompaction('已有 checkpoint', kept.id, 10_000)
      active.refreshContext()
    } })
    expect(result.compactionCalls).toBe(0)
    expect(result.providerMessages).toHaveLength(1)
    expect(result.manager.getBranch().filter(entry => entry.type === 'compaction')).toHaveLength(1)
    expect(result.delivered).toEqual([{ message: failed, uuid: 'assistant-1' }])
  })

  test('Given Extension 已切换实时模型 When 旧模型返回溢出 Then 不为新模型压缩', async () => {
    const failed = overflow()
    const result = await runRecoveryScenario({ responses: [failed], afterTurn: async (active) => {
      await active.setModel({ ...MODEL, id: 'larger-context-model', contextWindow: 400_000 }, { persist: false })
    } })
    expect(result.compactionCalls).toBe(0)
    expect(result.providerMessages).toHaveLength(1)
    expect(result.delivered).toEqual([{ message: failed, uuid: 'assistant-1' }])
    expect(result.manager.getBranch()).toContainEqual(expect.objectContaining({ type: 'model_change', modelId: 'larger-context-model' }))
  })

  test('Given 原生压缩关闭 When SDK 不进入恢复 Then agent_settled 释放一次', async () => {
    const failed = overflow()
    const result = await runRecoveryScenario({ responses: [failed], enabled: false })
    expect(result.compactionCalls).toBe(0)
    expect(result.delivered).toEqual([{ message: failed, uuid: 'assistant-1' }])
    expect(result.events.some(event => event.type === 'compaction_start')).toBe(false)
  })
})

import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import {
  agentExecutionControlsPendingMapAtom,
  agentLiveMessagesAtomFamily,
  agentSessionExecutionControlsAtomFamily,
  agentSessionTemporaryExecutionAtomFamily,
  agentSessionsAtom,
  agentTemporaryExecutionRunTokensAtom,
  applyAgentEvent,
  liveMessagesMapAtom,
  clearAgentStreamError,
  clearHydratedAgentSessionRuntimeState,
  isRetryEventForCurrentStream,
  releaseCompletedAgentSessionRuntimeState,
  resumeAgentStreamState,
  type AgentStreamState,
} from './agent-atoms'

function createStreamState(overrides: Partial<AgentStreamState> = {}): AgentStreamState {
  return {
    running: true,
    toolActivities: [],
    inputTokens: 180_000,
    outputTokens: 2_000,
    cacheReadTokens: 160_000,
    cacheCreationTokens: 18_000,
    contextWindow: 200_000,
    ...overrides,
  }
}

describe('Agent live SDK messages atoms', () => {
  test('Given eight background Agents emit 20 frames each When one session is visible Then it receives zero cross-session notifications', () => {
    const store = createStore()
    let notifications = 0
    const unsubscribe = store.sub(agentLiveMessagesAtomFamily('visible'), () => {
      notifications += 1
    })

    for (let agent = 0; agent < 8; agent += 1) {
      for (let frame = 0; frame < 20; frame += 1) {
        store.set(liveMessagesMapAtom, (prev) => {
          const next = new Map(prev)
          next.set(`background-${agent}`, [{ type: 'result', subtype: `frame-${frame}` } as never])
          return next
        })
      }
    }

    expect(notifications).toBe(0)
    expect(store.get(agentLiveMessagesAtomFamily('visible'))).toEqual([])
    unsubscribe()
  })

  test('Given AgentView subscribes to one session When that session streams Then it is notified', () => {
    const store = createStore()
    let notifications = 0
    const unsubscribe = store.sub(agentLiveMessagesAtomFamily('visible'), () => {
      notifications += 1
    })

    store.set(liveMessagesMapAtom, new Map([
      ['visible', [{ type: 'result', subtype: 'success' } as never]],
    ]))

    expect(notifications).toBe(1)
    expect(store.get(agentLiveMessagesAtomFamily('visible'))).toHaveLength(1)
    unsubscribe()
  })
})

describe('Agent delta resumed state', () => {
  test('Given legacy text events When reducing stream state Then正文 remains exclusively in SDK messages', () => {
    const state = createStreamState({
      retrying: { phase: 'running', currentAttempt: 2, maxAttempts: 8, delaySeconds: 1, reason: 'network', history: [] },
    })

    const deltaState = applyAgentEvent(state, { type: 'text_delta', text: '增量正文' })
    const finalState = applyAgentEvent(deltaState, { type: 'text_complete', text: '权威正文', isIntermediate: false })

    expect('content' in deltaState).toBe(false)
    expect('content' in finalState).toBe(false)
    expect(deltaState.retrying).toBeUndefined()
  })

  test('Given retry and completed compaction state When fresh assistant delta arrives Then transient recovery state is cleared', () => {
    const state = createStreamState({
      retrying: { phase: 'running', currentAttempt: 2, maxAttempts: 8, delaySeconds: 1, reason: 'network', history: [] },
      compactInFlight: true,
      contextCompaction: { status: 'success', summary: 'done' },
    })

    const resumed = resumeAgentStreamState(state)

    expect(resumed.retrying).toBeUndefined()
    expect(resumed.compactInFlight).toBe(false)
    expect(resumed.contextCompaction).toBeUndefined()
  })
})

describe('Agent completed runtime state cleanup', () => {
  const liveMessage = { type: 'result', subtype: 'success' } as never

  test('Given a background session completed and persisted When cleanup runs Then heavy live and stream payloads are released', () => {
    const streamStates = new Map([
      ['background', createStreamState({
        running: false,
        startedAt: 100,
        toolActivities: [{
          toolUseId: 'tool-1',
          toolName: 'Read',
          input: {},
          result: 'large tool result',
          done: true,
        }],
      })],
      ['other', createStreamState({ running: true, startedAt: 200 })],
    ])
    const liveMessages = new Map([
      ['background', [liveMessage]],
      ['other', [liveMessage]],
    ])

    const result = releaseCompletedAgentSessionRuntimeState(streamStates, liveMessages, {
      sessionId: 'background',
      startedAt: 100,
      sessionVisible: false,
      backgroundTasksPending: false,
    })

    expect(result.streamingStates.has('background')).toBe(false)
    expect(result.liveMessages.has('background')).toBe(false)
    expect(result.streamingStates.get('other')).toBe(streamStates.get('other'))
    expect(result.liveMessages.get('other')).toBe(liveMessages.get('other'))
  })

  test('Given the completed session is visible When persisted history has not loaded Then live messages stay mounted without a blank gap', () => {
    const streamStates = new Map([['visible', createStreamState({ running: false, startedAt: 100 })]])
    const liveMessages = new Map([['visible', [liveMessage]]])

    const result = releaseCompletedAgentSessionRuntimeState(streamStates, liveMessages, {
      sessionId: 'visible',
      startedAt: 100,
      sessionVisible: true,
      backgroundTasksPending: false,
    })

    expect(result.streamingStates).toBe(streamStates)
    expect(result.liveMessages).toBe(liveMessages)
  })

  test('Given persisted history has replaced the visible transcript When hydration cleanup runs Then stale live payloads are released', () => {
    const streamStates = new Map([['visible', createStreamState({
      running: false,
      startedAt: 100,
      toolActivities: [{ toolUseId: 'tool-1', toolName: 'Read', input: {}, done: true }],
    })]])
    const liveMessages = new Map([['visible', [liveMessage]]])

    const result = clearHydratedAgentSessionRuntimeState(streamStates, liveMessages, 'visible')

    expect(result.streamingStates.get('visible')).toMatchObject({
      running: false,
      toolActivities: [],
    })
    expect(result.liveMessages.has('visible')).toBe(false)
  })

  test('Given a new run starts before persisted history returns When hydration cleanup runs Then the new live stream remains intact', () => {
    const streamStates = new Map([['visible', createStreamState({
      running: true,
      startedAt: 200,
    })]])
    const liveMessages = new Map([['visible', [liveMessage]]])

    const result = clearHydratedAgentSessionRuntimeState(streamStates, liveMessages, 'visible')

    expect(result.streamingStates).toBe(streamStates)
    expect(result.liveMessages).toBe(liveMessages)
  })

  test('Given background tasks are still pending When an idle completion arrives Then runtime state remains available for resume', () => {
    const streamStates = new Map([['background', createStreamState({
      running: false,
      backgroundWaiting: true,
      startedAt: 100,
    })]])
    const liveMessages = new Map([['background', [liveMessage]]])

    const result = releaseCompletedAgentSessionRuntimeState(streamStates, liveMessages, {
      sessionId: 'background',
      startedAt: 100,
      sessionVisible: false,
      backgroundTasksPending: true,
    })

    expect(result.streamingStates).toBe(streamStates)
    expect(result.liveMessages).toBe(liveMessages)
  })

  test('Given a newer run already replaced the completed run When an old completion arrives Then it cannot clear the newer messages', () => {
    const streamStates = new Map([['background', createStreamState({ running: false, startedAt: 200 })]])
    const liveMessages = new Map([['background', [liveMessage]]])

    const result = releaseCompletedAgentSessionRuntimeState(streamStates, liveMessages, {
      sessionId: 'background',
      startedAt: 100,
      sessionVisible: false,
      backgroundTasksPending: false,
    })

    expect(result.streamingStates).toBe(streamStates)
    expect(result.liveMessages).toBe(liveMessages)
  })

  test('Given stop or error completion persisted partial output When final cleanup runs Then it uses the same release boundary', () => {
    for (const sessionId of ['stopped', 'errored']) {
      const result = releaseCompletedAgentSessionRuntimeState(
        new Map([[sessionId, createStreamState({ running: false, startedAt: 100 })]]),
        new Map([[sessionId, [liveMessage]]]),
        {
          sessionId,
          startedAt: 100,
          sessionVisible: false,
          backgroundTasksPending: false,
        },
      )

      expect(result.streamingStates.has(sessionId)).toBe(false)
      expect(result.liveMessages.has(sessionId)).toBe(false)
    }
  })
})

describe('Agent Execution Controls atoms', () => {
  test('Given two legacy Pi sessions When controls are derived Then each normalizes into Research or Execute', () => {
    const store = createStore()
    store.set(agentSessionsAtom, [
      { id: 'controlled', title: 'Controlled', executionPolicy: 'controlled', workflow: 'direct', createdAt: 1, updatedAt: 1 },
      { id: 'autonomous', title: 'Autonomous', executionPolicy: 'autonomous', workflow: 'plan-first', createdAt: 2, updatedAt: 2 },
    ])

    expect(store.get(agentSessionExecutionControlsAtomFamily('controlled'))).toEqual({ executionPolicy: 'full-access', workflow: 'direct' })
    expect(store.get(agentSessionExecutionControlsAtomFamily('autonomous'))).toEqual({ executionPolicy: 'full-access', workflow: 'read-only' })
  })

  test('Given a new Pi draft session When no persisted controls exist Then it defaults to Execute', () => {
    const store = createStore()
    expect(store.get(agentSessionExecutionControlsAtomFamily('draft'))).toEqual({ executionPolicy: 'full-access', workflow: 'direct' })
  })

  test('Given a run-scoped lease token exists When temporary execution is derived Then only that session is active', () => {
    const store = createStore()
    store.set(agentTemporaryExecutionRunTokensAtom, new Map([['a', 9]]))

    expect(store.get(agentSessionTemporaryExecutionAtomFamily('a'))).toBe(true)
    expect(store.get(agentSessionTemporaryExecutionAtomFamily('b'))).toBe(false)
  })

  test('Given one session has an optimistic update When controls are derived Then other sessions are unchanged', () => {
    const store = createStore()
    store.set(agentSessionsAtom, [
      { id: 'a', title: 'A', executionPolicy: 'controlled', workflow: 'direct', createdAt: 1, updatedAt: 1 },
      { id: 'b', title: 'B', executionPolicy: 'controlled', workflow: 'direct', createdAt: 2, updatedAt: 2 },
    ])
    store.set(agentExecutionControlsPendingMapAtom, new Map([
      ['a', { executionPolicy: 'full-access', workflow: 'direct' }],
    ]))

    expect(store.get(agentSessionExecutionControlsAtomFamily('a')).executionPolicy).toBe('full-access')
    expect(store.get(agentSessionExecutionControlsAtomFamily('b')).executionPolicy).toBe('full-access')
  })
})

describe('Agent 上下文窗口来源优先级', () => {
  test('given 旧的名称推断窗口 when provider catalog 返回更小窗口 then 允许向下修正', () => {
    const result = applyAgentEvent(createStreamState({
      contextWindow: 372_000,
      contextWindowSource: 'name_fallback',
    }), {
      type: 'usage_update',
      usage: {
        contextWindow: 272_000,
        contextWindowSource: 'provider_catalog',
      },
    })

    expect(result).toMatchObject({
      contextWindow: 272_000,
      contextWindowSource: 'provider_catalog',
    })
  })

  test('given 已有 provider catalog 窗口 when 后续流式 usage 携带名称 fallback then 不被覆盖', () => {
    const result = applyAgentEvent(createStreamState({
      contextWindow: 400_000,
      contextWindowSource: 'provider_catalog',
    }), {
      type: 'usage_update',
      usage: {
        contextWindow: 272_000,
        contextWindowSource: 'name_fallback',
      },
    })

    expect(result).toMatchObject({
      contextWindow: 400_000,
      contextWindowSource: 'provider_catalog',
    })
  })

  test('given 已有 runtime 窗口 when 后续名称 fallback 到达 then 保留 runtime 值', () => {
    const result = applyAgentEvent(createStreamState({
      contextWindow: 400_000,
      contextWindowSource: 'runtime',
    }), {
      type: 'usage_update',
      usage: {
        contextWindow: 272_000,
        contextWindowSource: 'name_fallback',
      },
    })

    expect(result).toMatchObject({
      contextWindow: 400_000,
      contextWindowSource: 'runtime',
    })
  })
})

describe('Agent 实时上下文用量', () => {
  test('Given 请求构成事件先到 When usage 随后更新 Then 保留构成供上下文面板归一化', () => {
    const breakdown = {
      capturedAt: 123,
      system: 10,
      skills: 20,
      mcp: 30,
      tools: 15,
      conversation: 25,
    }
    const withBreakdown = applyAgentEvent(createStreamState(), {
      type: 'usage_update',
      usage: { contextBreakdown: breakdown },
    })
    const result = applyAgentEvent(withBreakdown, {
      type: 'usage_update',
      usage: { inputTokens: 40_000, cacheReadTokens: 30_000 },
    })

    expect(result.contextBreakdown).toEqual(breakdown)
    expect(result.inputTokens).toBe(40_000)
  })

  test('Given 已有终态真实 usage When 下一轮 partial 误传零 usage Then 保留最近真实上下文占用', () => {
    const previous = createStreamState({
      inputTokens: 21_953,
      outputTokens: 640,
      cacheReadTokens: 18_000,
      cacheCreationTokens: 953,
      contextUsageOrigin: 'live',
    })

    const result = applyAgentEvent(previous, {
      type: 'usage_update',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    })

    expect(result).toMatchObject({
      inputTokens: 21_953,
      outputTokens: 640,
      cacheReadTokens: 18_000,
      cacheCreationTokens: 953,
      contextUsageOrigin: 'live',
    })
  })
})

describe('Agent 上下文压缩状态', () => {
  test('given Pi 手动压缩提供预估 token when 压缩完成 then 显示预估值并清除旧明细', () => {
    const result = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })

    expect(result).toMatchObject({
      isCompacting: false,
      inputTokens: 32_000,
      contextWindow: 200_000,
      contextUsageIsEstimated: true,
    })
    expect(result.outputTokens).toBeUndefined()
    expect(result.cacheReadTokens).toBeUndefined()
    expect(result.cacheCreationTokens).toBeUndefined()
  })

  test('given 压缩后的预估值 when 当前压缩操作的收尾 result 没有 usage then 保留预估状态', () => {
    const compacted = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })
    const result = applyAgentEvent(compacted, { type: 'complete' })

    expect(result).toMatchObject({
      inputTokens: 32_000,
      contextUsageIsEstimated: true,
    })
  })

  test('given 自动压缩后同一 run 返回聚合 result when 收尾 then 不用累计 usage 覆盖压缩后预估', () => {
    const compacted = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })
    const result = applyAgentEvent(compacted, {
      type: 'complete',
      usage: {
        inputTokens: 5_000_000,
        cacheReadTokens: 4_900_000,
      },
    })

    expect(result).toMatchObject({
      inputTokens: 32_000,
      contextUsageIsEstimated: true,
    })
  })

  test('given 压缩后的预估值 when 收到零 token result then 保留预估状态', () => {
    const compacted = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })
    const result = applyAgentEvent(compacted, {
      type: 'complete',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    })

    expect(result).toMatchObject({
      inputTokens: 32_000,
      contextUsageIsEstimated: true,
    })
  })

  test('given 压缩后的预估值 when 下一轮收到真实 usage then 用真实值覆盖预估状态', () => {
    const compacted = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })
    const result = applyAgentEvent(compacted, {
      type: 'usage_update',
      usage: {
        inputTokens: 36_000,
        cacheReadTokens: 30_000,
        outputTokens: 800,
      },
    })

    expect(result).toMatchObject({
      inputTokens: 36_000,
      cacheReadTokens: 30_000,
      outputTokens: 800,
      contextUsageIsEstimated: false,
      contextUsageInvalidated: false,
    })
  })

  test('given 压缩后的预估值 when 下一轮仅在 result 返回 usage then 用真实值覆盖预估状态', () => {
    const compacted = applyAgentEvent(createStreamState(), {
      type: 'compact_complete',
      status: 'success',
      estimatedTokensAfter: 32_000,
    })
    const nextRun = {
      ...compacted,
      contextCompaction: undefined,
      compactInFlight: false,
    }
    const result = applyAgentEvent(nextRun, {
      type: 'complete',
      usage: {
        inputTokens: 40_000,
        cacheReadTokens: 34_000,
      },
    })

    expect(result).toMatchObject({
      inputTokens: 40_000,
      cacheReadTokens: 34_000,
      contextUsageIsEstimated: false,
    })
  })

  test('given 压缩成功但没有压缩后预估 token when 处理 then 清除已失效的压缩前用量', () => {
    const result = applyAgentEvent(createStreamState(), { type: 'compact_complete', status: 'success' })

    expect(result).toMatchObject({
      isCompacting: false,
      contextCompaction: { status: 'success' },
    })
    expect(result.inputTokens).toBeUndefined()
    expect(result.outputTokens).toBeUndefined()
    expect(result.cacheReadTokens).toBeUndefined()
    expect(result.cacheCreationTokens).toBeUndefined()
    expect(result.contextUsageIsEstimated).toBeUndefined()
    expect(result.contextUsageInvalidated).toBe(true)
  })

  test('given 压缩成功 when 同一流开始下一项工具工作 then 清除压缩终态并恢复正常进度', () => {
    const compacting = applyAgentEvent(createStreamState(), { type: 'compacting' })
    const compacted = applyAgentEvent(compacting, { type: 'compact_complete', status: 'success' })
    const resumed = applyAgentEvent(compacted, {
      type: 'tool_start',
      toolName: 'TaskCreate',
      toolUseId: 'resume-task',
      input: {},
    })

    expect(compacted).toMatchObject({
      isCompacting: false,
      compactInFlight: true,
      contextCompaction: { status: 'success' },
    })
    expect(resumed.contextCompaction).toBeUndefined()
    expect(resumed.compactInFlight).toBe(false)
    expect(resumed.toolActivities).toContainEqual(expect.objectContaining({
      toolUseId: 'resume-task',
      done: false,
    }))
  })

  test('given 压缩成功 when 当前流直接结束 then 保留终态反馈给短时完成提示', () => {
    const compacting = applyAgentEvent(createStreamState(), { type: 'compacting' })
    const compacted = applyAgentEvent(compacting, { type: 'compact_complete', status: 'success' })
    const result = applyAgentEvent(compacted, { type: 'complete' })

    expect(result).toMatchObject({
      compactInFlight: true,
      contextCompaction: { status: 'success' },
    })
  })
})

describe('Agent retry 状态机', () => {
  const runStartedAt = 1_000
  const retryAttempt = {
    attempt: 8,
    totalAttempt: 8,
    maxTotalAttempts: 8,
    timestamp: 2_000,
    reason: 'TypeError: Failed to fetch',
    errorMessage: 'TypeError: Failed to fetch',
    delaySeconds: 128,
  }

  test('given retry 已安排 when 实际请求尚未开始 then 不把它记入执行历史', () => {
    const scheduled = applyAgentEvent(createStreamState({ startedAt: runStartedAt }), {
      type: 'retrying',
      attempt: 8,
      maxAttempts: 8,
      totalAttempt: 8,
      maxTotalAttempts: 8,
      runStartedAt,
      scheduledAt: 1_500,
      delaySeconds: 128,
      reason: 'TypeError: Failed to fetch',
    })

    expect(scheduled.retrying).toMatchObject({
      phase: 'scheduled',
      currentAttempt: 8,
      maxAttempts: 8,
      history: [],
    })
  })

  test('given 第 8 次 retry 已实际开始且最终耗尽 when 更新终态 then 历史不重复追加第 8 项', () => {
    const started = applyAgentEvent(createStreamState({ startedAt: runStartedAt }), {
      type: 'retry_attempt',
      attemptData: retryAttempt,
      runStartedAt,
      maxAttempts: 8,
      totalAttempt: 8,
      maxTotalAttempts: 8,
    })
    const exhausted = applyAgentEvent(started, {
      type: 'retry_failed',
      finalAttempt: { ...retryAttempt, errorMessage: '最终请求仍然失败', reason: '最终请求仍然失败' },
      runStartedAt,
      maxAttempts: 8,
      totalAttempt: 8,
      maxTotalAttempts: 8,
    })

    expect(exhausted.retrying).toMatchObject({ phase: 'exhausted', currentAttempt: 8 })
    expect(exhausted.retrying?.history).toHaveLength(1)
    expect(exhausted.retrying?.history[0]).toMatchObject({ attempt: 8, timestamp: 2_000, reason: '最终请求仍然失败' })
  })

  test('given retry 成功 when 后续输出到达 then 成功状态被自然收起', () => {
    const running = applyAgentEvent(createStreamState({ startedAt: runStartedAt }), {
      type: 'retry_attempt',
      attemptData: retryAttempt,
      runStartedAt,
      maxAttempts: 8,
    })
    const succeeded = applyAgentEvent(running, {
      type: 'retry_cleared',
      runStartedAt,
      attempt: 8,
      maxAttempts: 8,
    })

    expect(succeeded.retrying?.phase).toBe('succeeded')
    expect(applyAgentEvent(succeeded, { type: 'text_delta', text: '已恢复' }).retrying).toBeUndefined()
  })

  test('given 旧 run 的 retry 终态 when 新流已经开始 then 忽略迟到事件', () => {
    const current = createStreamState({ startedAt: runStartedAt + 1 })
    expect(applyAgentEvent(current, {
      type: 'retry_cancelled',
      runStartedAt,
      attempt: 1,
      maxAttempts: 8,
      reason: 'Retry cancelled',
    })).toBe(current)
  })

  test('given 带 run 标识的 retry 事件 when 流式状态缺少同一 startedAt then 严格拒绝它', () => {
    expect(isRetryEventForCurrentStream(createStreamState(), { runStartedAt })).toBe(false)
  })

  test('given retry 终态或错误 when STREAM_COMPLETE 尚未到达 then 不提前释放运行锁', () => {
    const exhausted = applyAgentEvent(createStreamState({ startedAt: runStartedAt }), {
      type: 'retry_failed',
      finalAttempt: retryAttempt,
      runStartedAt,
      maxAttempts: 8,
    })
    const cancelled = applyAgentEvent(createStreamState({ startedAt: runStartedAt }), {
      type: 'retry_cancelled',
      runStartedAt,
      attempt: 1,
      maxAttempts: 8,
      reason: 'Retry cancelled',
    })

    expect(exhausted.running).toBe(true)
    expect(cancelled.running).toBe(true)
    expect(applyAgentEvent(createStreamState(), { type: 'error', message: '终态错误' }).running).toBe(true)
  })
})

describe('Agent 流式错误状态', () => {
  test('given Pi 原生重试成功 when 清理会话错误 then 仅移除该会话的过期记录', () => {
    const errors = new Map([
      ['retried-session', '服务繁忙'],
      ['failed-session', '认证失败'],
    ])

    expect(clearAgentStreamError(errors, 'retried-session')).toEqual(new Map([
      ['failed-session', '认证失败'],
    ]))
  })

  test('given 当前会话没有流式错误 when 清理 then 保持原 Map 引用', () => {
    const errors = new Map([['failed-session', '认证失败']])

    expect(clearAgentStreamError(errors, 'retried-session')).toBe(errors)
  })
})

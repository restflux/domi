import { describe, expect, test } from 'bun:test'
import type { AgentMessage, ShouldStopAfterTurnContext } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai/compat'
import {
  PI_COMPACTION_ANCHOR_CUSTOM_TYPE,
  PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
  PI_COMPACTION_CONTINUATION_PROMPT,
  PI_INCOMPLETE_TURN_CONTINUATION_CUSTOM_TYPE,
  compactCurrentSessionAfterTurn,
  continuePiAfterCompaction,
  continuePiAfterIncompleteTurn,
  installPiAutoCompactionTurnStop,
  withPiCompactionKeepRecentTokens,
} from './pi-agent-adapter'

function assistant(totalTokens: number, toolName = 'read'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: 'tool-1',
      name: toolName,
      arguments: {},
    }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  } as AssistantMessage
}

function toolResult(text = 'ok'): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId: 'tool-1',
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError: false,
    timestamp: Date.now(),
  } as ToolResultMessage
}

type ShouldStopAfterTurn = (context: ShouldStopAfterTurnContext, signal?: AbortSignal) => boolean | Promise<boolean>

function createSession(previousShouldStop?: ShouldStopAfterTurn) {
  const queued: unknown[] = []
  const agent: {
    shouldStopAfterTurn?: ShouldStopAfterTurn
    steer: (message: unknown) => void
  } = {
    shouldStopAfterTurn: previousShouldStop,
    steer: (message: unknown) => { queued.push(message) },
  }
  return {
    session: { agent } as never,
    agent,
    queued,
  }
}

function turn(message: AssistantMessage, toolResults: ToolResultMessage[] = [toolResult()]): ShouldStopAfterTurnContext {
  return {
    message,
    toolResults,
    context: { systemPrompt: 'test', messages: [message, ...toolResults], tools: [] },
    newMessages: [message, ...toolResults],
  }
}

function installOptions(extra: { trailingTokens?: number; enabled?: boolean } = {}) {
  return {
    compactThresholdTokens: 217_600,
    calculateContextTokens: (usage: NonNullable<AssistantMessage['usage']>) => usage.totalTokens ?? 0,
    estimateTokens: (message: AgentMessage) => (
      message.role === 'toolResult' ? extra.trailingTokens ?? 0 : 0
    ),
    enabled: extra.enabled,
  }
}

describe('Pi turn 边界自动压缩', () => {
  test('Given 工具结果将下一次请求推过阈值 When turn 结束 Then 只请求强制压缩，不提前排入 user steering', async () => {
    const { session, agent, queued } = createSession()
    const control = installPiAutoCompactionTurnStop(session, installOptions({ trailingTokens: 7_601 }))

    expect(await agent.shouldStopAfterTurn?.(turn(assistant(210_000)))).toBe(true)
    expect(control.needsCompaction()).toBe(true)
    expect(control.takeCompacted()).toBe(false)
    expect(queued).toHaveLength(0)
  })

  test('Given 强制或原生压缩真正成功 When 结算 turn Then 才允许安排隐藏续跑', async () => {
    const { session, agent } = createSession()
    const control = installPiAutoCompactionTurnStop(session, installOptions())

    expect(await agent.shouldStopAfterTurn?.(turn(assistant(300_000)))).toBe(true)
    control.settle('success')
    expect(control.needsCompaction()).toBe(false)
    expect(control.takeCompacted()).toBe(true)
    expect(control.takeCompacted()).toBe(false)
  })

  test('Given Pi 支持 inline compaction When Domi 安装兼容 hook Then 不再停止当前 loop', async () => {
    const { session, agent } = createSession()
    const control = installPiAutoCompactionTurnStop(session, installOptions({ enabled: false }))

    expect(await agent.shouldStopAfterTurn?.(turn(assistant(300_000)))).toBe(false)
    expect(control.needsCompaction()).toBe(false)
  })

  test('Given 用量仍等于阈值或当前回合无需继续工具循环 Then 不提前停止', async () => {
    const atThreshold = createSession()
    const thresholdControl = installPiAutoCompactionTurnStop(atThreshold.session, installOptions())
    expect(await atThreshold.agent.shouldStopAfterTurn?.(turn(assistant(217_600)))).toBe(false)
    expect(thresholdControl.needsCompaction()).toBe(false)

    const finalTurn = createSession()
    const finalControl = installPiAutoCompactionTurnStop(finalTurn.session, installOptions())
    expect(await finalTurn.agent.shouldStopAfterTurn?.(turn(assistant(300_000), []))).toBe(false)
    expect(finalControl.needsCompaction()).toBe(false)
  })

  test('Given 已有 Worktree 等更高优先级停止条件 When 组合 hook Then 不请求自动压缩', async () => {
    const { session, agent, queued } = createSession(() => true)
    const control = installPiAutoCompactionTurnStop(session, installOptions())

    expect(await agent.shouldStopAfterTurn?.(turn(assistant(300_000)))).toBe(true)
    expect(control.needsCompaction()).toBe(false)
    expect(queued).toHaveLength(0)
  })

  test('Given 当前批次调用终止型工具 When 超过阈值 Then 由终止工具自己的生命周期接管', async () => {
    const { session, agent, queued } = createSession()
    const control = installPiAutoCompactionTurnStop(session, installOptions())

    expect(await agent.shouldStopAfterTurn?.(turn(assistant(300_000, 'ReadyForReview')))).toBe(false)
    expect(control.needsCompaction()).toBe(false)
    expect(queued).toHaveLength(0)
  })

  test('Given 无 pending 自动压缩请求 When 收到无关 noop 失败事件 Then 不会永久禁用后续 turn-stop', async () => {
    const { session, agent } = createSession()
    const control = installPiAutoCompactionTurnStop(session, installOptions())

    control.settle('failed')
    expect(control.takeFailure()).toBeUndefined()
    expect(await agent.shouldStopAfterTurn?.(turn(assistant(300_000)))).toBe(true)
    expect(control.needsCompaction()).toBe(true)
  })

  test('Given 原生或强制压缩失败 When 后续仍超阈值 Then 暴露失败且不形成无限停止压缩循环', async () => {
    const { session, agent, queued } = createSession()
    const control = installPiAutoCompactionTurnStop(session, installOptions())

    expect(await agent.shouldStopAfterTurn?.(turn(assistant(300_000)))).toBe(true)
    control.settle('failed')
    expect(control.needsCompaction()).toBe(false)
    expect(control.takeCompacted()).toBe(false)
    expect(control.takeFailure()).toBe('failed')
    expect(control.takeFailure()).toBeUndefined()
    expect(await agent.shouldStopAfterTurn?.(turn(assistant(310_000)))).toBe(false)
    expect(queued).toHaveLength(0)
  })
})

describe('Pi 压缩后隐藏续跑', () => {
  test('Given provider usage 低于原生阈值但工具结果已越线 When 强制压缩并续跑 Then 成功边界严格先于隐藏下一轮', async () => {
    const { session, agent } = createSession()
    const control = installPiAutoCompactionTurnStop(session, installOptions({ trailingTokens: 7_601 }))
    const order: string[] = []

    expect(await agent.shouldStopAfterTurn?.(turn(assistant(210_000)))).toBe(true)
    const compactionResult = await compactCurrentSessionAfterTurn({
      sessionId: 'session-1',
      compact: async () => {
        order.push('compaction_start')
        control.settle('success')
        order.push('compaction_end')
        return {} as never
      },
      sendCustomMessage: async () => {},
    }, {
      onNoop: () => {},
      hasFreshSuccessfulBoundary: () => true,
    })
    expect(compactionResult).toBe('compacted')
    expect(control.takeCompacted()).toBe(true)

    await continuePiAfterCompaction({
      sendCustomMessage: async () => { order.push('hidden_continuation') },
    }, PI_COMPACTION_CONTINUATION_PROMPT)
    expect(order).toEqual(['compaction_start', 'compaction_end', 'hidden_continuation'])
  })

  test('Given 默认 keepRecentTokens 令单 turn 无法切分 When aggressive retry 执行 Then 临时降为 0 并在结束后恢复', async () => {
    const settings = {
      getCompactionSettings: () => ({ enabled: true, reserveTokens: 54_400, keepRecentTokens: 20_000 }),
    }
    const observed: number[] = []
    const originalGetter = settings.getCompactionSettings

    await withPiCompactionKeepRecentTokens(settings as never, 0, async () => {
      observed.push(settings.getCompactionSettings().keepRecentTokens)
    })

    expect(observed).toEqual([0])
    expect(settings.getCompactionSettings().keepRecentTokens).toBe(20_000)
    expect(settings.getCompactionSettings).toBe(originalGetter)

    const inheritedSettings = Object.create({
      getCompactionSettings: () => ({ enabled: true, reserveTokens: 54_400, keepRecentTokens: 20_000 }),
    }) as typeof settings
    await withPiCompactionKeepRecentTokens(inheritedSettings as never, 0, async () => {
      expect(inheritedSettings.getCompactionSettings().keepRecentTokens).toBe(0)
    })
    expect(Object.hasOwn(inheritedSettings, 'getCompactionSettings')).toBe(false)
    expect(inheritedSettings.getCompactionSettings().keepRecentTokens).toBe(20_000)

    await expect(withPiCompactionKeepRecentTokens(settings as never, 0, async () => {
      throw new Error('summary failed')
    })).rejects.toThrow('summary failed')
    expect(settings.getCompactionSettings().keepRecentTokens).toBe(20_000)
  })

  test('Given 大型单 turn 没有 Pi cut point When 首次压缩返回 Nothing to compact Then 隐藏 anchor 后重试并成功', async () => {
    const order: string[] = []
    const customMessages: Array<{ message: unknown; options: unknown }> = []
    let compactAttempts = 0

    const result = await compactCurrentSessionAfterTurn({
      sessionId: 'session-1',
      compact: async () => {
        compactAttempts += 1
        order.push(`compact-${compactAttempts}`)
        if (compactAttempts === 1) throw new Error('Nothing to compact (session too small)')
        order.push('compaction_end')
        return {} as never
      },
      sendCustomMessage: async (message, options) => {
        order.push('anchor')
        customMessages.push({ message, options })
      },
    }, {
      onNoop: () => { order.push('noop-visible') },
      hasFreshSuccessfulBoundary: () => true,
      retryAfterAnchor: async () => {
        order.push('aggressive-retry')
        compactAttempts += 1
        order.push(`compact-${compactAttempts}`)
        order.push('compaction_end')
      },
    })

    expect(result).toBe('compacted')
    expect(order).toEqual(['compact-1', 'anchor', 'aggressive-retry', 'compact-2', 'compaction_end'])
    expect(customMessages).toEqual([{
      message: {
        customType: PI_COMPACTION_ANCHOR_CUSTOM_TYPE,
        content: [{ type: 'text', text: 'Domi internal compaction boundary. No user action is requested.' }],
        display: false,
        details: { internal: true, reason: 'auto_compaction_anchor' },
      },
      options: undefined,
    }])
  })

  test('Given Pi 报告 Already compacted When 没有本轮新成功边界 Then 不授予续跑许可', async () => {
    const noopMessages: unknown[] = []
    const result = await compactCurrentSessionAfterTurn({
      sessionId: 'session-1',
      compact: async () => { throw new Error('Already compacted') },
      sendCustomMessage: async () => {},
    }, {
      onNoop: (message) => { noopMessages.push(message) },
      hasFreshSuccessfulBoundary: () => false,
    })

    expect(result).toBe('already_compacted_without_fresh_boundary')
    expect(noopMessages).toHaveLength(1)
  })

  test('Given Pi 已在本轮完成原生压缩 When 手动 compact 竞争返回 Already compacted Then 复用可信成功边界', async () => {
    const result = await compactCurrentSessionAfterTurn({
      sessionId: 'session-1',
      compact: async () => { throw new Error('Already compacted') },
      sendCustomMessage: async () => {},
    }, {
      onNoop: () => {},
      hasFreshSuccessfulBoundary: () => true,
    })

    expect(result).toBe('already_compacted')
  })

  test('Given anchor 后 Pi 仍无可压缩内容 When 二次返回 Nothing to compact Then 准确失败且不再重试', async () => {
    let compactAttempts = 0
    let anchors = 0
    let noopMessages = 0
    const result = await compactCurrentSessionAfterTurn({
      sessionId: 'session-1',
      compact: async () => {
        compactAttempts += 1
        throw new Error('Nothing to compact (session too small)')
      },
      sendCustomMessage: async () => { anchors += 1 },
    }, {
      onNoop: () => { noopMessages += 1 },
      hasFreshSuccessfulBoundary: () => false,
    })

    expect(result).toBe('nothing_to_compact')
    expect(compactAttempts).toBe(2)
    expect(anchors).toBe(1)
    expect(noopMessages).toBe(1)
  })

  test('Given thinking-only 成功终态需要恢复 When 续跑 Then 使用不可见 custom message 而不是 user prompt', async () => {
    const calls: Array<{ message: unknown; options: unknown }> = []
    await continuePiAfterIncompleteTurn({
      sendCustomMessage: async (message, options) => { calls.push({ message, options }) },
    }, 'continue original task')

    expect(calls).toEqual([{
      message: {
        customType: PI_INCOMPLETE_TURN_CONTINUATION_CUSTOM_TYPE,
        content: [{ type: 'text', text: 'continue original task' }],
        display: false,
        details: { internal: true, reason: 'incomplete_turn_continuation' },
      },
      options: { triggerTurn: true },
    }])
  })

  test('Given 压缩已成功 When 恢复原任务 Then 使用不可见 custom message 而不是 user prompt', async () => {
    const calls: Array<{ message: unknown; options: unknown }> = []
    await continuePiAfterCompaction({
      sendCustomMessage: async (message, options) => { calls.push({ message, options }) },
    }, PI_COMPACTION_CONTINUATION_PROMPT)

    expect(calls).toEqual([{
      message: {
        customType: PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
        content: [{ type: 'text', text: PI_COMPACTION_CONTINUATION_PROMPT }],
        display: false,
        details: { internal: true, reason: 'auto_compaction_continuation' },
      },
      options: { triggerTurn: true },
    }])
  })
})

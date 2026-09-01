import { describe, expect, test } from 'bun:test'
import {
  buildCurrentSessionCompactionTool,
  buildWorktreeHandoffTool,
  canRunSessionTerminatingTool,
  finalizeWorktreeHandoffRequest,
  installWorktreeHandoffLoopStop,
  type PiWorktreeHandoffControl,
  type WorktreeHandoffRequest,
} from './pi-agent-adapter'

describe('ForkToWorktree terminating tool', () => {
  test('Given explicit CompactContext When 工具成功 Then 保留工具内压缩调度并终止当前批次', async () => {
    let requested = 0
    const sdk = { defineTool: (definition: unknown) => definition } as never
    const tool = buildCurrentSessionCompactionTool(sdk, () => { requested += 1 })

    const result = await (tool.execute as unknown as () => Promise<{ terminate?: boolean; content: Array<{ text?: string }> }>)()

    expect(requested).toBe(1)
    expect(result.terminate).toBe(true)
    expect(result.content[0]?.text).toContain('scheduled')
  })

  test('Given 单独调用 When 宿主校验通过 Then 安排带可信证明的 terminating handoff', async () => {
    const validated: WorktreeHandoffRequest[] = []
    const scheduled: unknown[] = []
    const control: PiWorktreeHandoffControl = {
      validate: async (request) => {
        validated.push(request)
        return { targetRevision: 7, targetCurrentOid: 'head-7', dirtyConfirmed: true }
      },
      ready: () => undefined,
    }
    const sdk = { defineTool: (definition: unknown) => definition } as never
    const tool = buildWorktreeHandoffTool(sdk, control, (request) => scheduled.push(request))

    const result = await (tool.execute as unknown as (id: string, input: unknown) => Promise<unknown>)('call-1', {
      task: '  在隔离工作区继续实现并运行测试  ',
    })

    expect(validated).toEqual([{ task: '在隔离工作区继续实现并运行测试' }])
    expect(scheduled).toEqual([{
      task: '在隔离工作区继续实现并运行测试',
      toolCallId: 'call-1',
      targetRevision: 7,
      targetCurrentOid: 'head-7',
      dirtyConfirmed: true,
    }])
    expect((result as { terminate?: boolean }).terminate).toBe(true)
  })

  test('Given dirty 宿主确认拒绝 When 调用 Then 不安排 handoff', async () => {
    const scheduled: unknown[] = []
    const control: PiWorktreeHandoffControl = {
      validate: async () => { throw new Error('用户未确认 Local 未提交修改') },
      ready: () => undefined,
    }
    const sdk = { defineTool: (definition: unknown) => definition } as never
    const tool = buildWorktreeHandoffTool(sdk, control, (request) => scheduled.push(request))

    await expect((tool.execute as unknown as (id: string, input: unknown) => Promise<unknown>)('call-1', { task: '继续任务' })).rejects.toThrow('未确认')
    expect(scheduled).toEqual([])
  })

  test('Given assistant/toolResult/Pi entry 均落盘 When finalize Then 提交闭合 fork point', () => {
    const ready: unknown[] = []
    const control: PiWorktreeHandoffControl = {
      validate: async () => ({ targetRevision: 1, targetCurrentOid: 'head-1', dirtyConfirmed: false }),
      ready: (request) => { ready.push(request) },
    }
    const scheduled = {
      task: '继续任务',
      toolCallId: 'tool-1',
      targetRevision: 3,
      targetCurrentOid: 'head-3',
      dirtyConfirmed: false,
    }
    finalizeWorktreeHandoffRequest(scheduled, {
      assistantMessageUuid: 'assistant-final',
      toolResultMessageUuid: 'tool-result-final',
      piToolResultEntryId: 'entry-result',
    }, control)
    expect(ready).toEqual([{
      task: '继续任务',
      targetRevision: 3,
      targetCurrentOid: 'head-3',
      dirtyConfirmed: false,
      assistantMessageUuid: 'assistant-final',
      toolResultMessageUuid: 'tool-result-final',
      piToolResultEntryId: 'entry-result',
    }])
    expect(() => finalizeWorktreeHandoffRequest(scheduled, {
      assistantMessageUuid: 'assistant-final',
    }, control)).toThrow('完整')
  })

  test('Given Extension 在 prepareNextTurn 后重新入队 When public turn hook checks terminating handoff Then 强制停止并只清队列一次', async () => {
    let terminating = false
    let queuedByExtension = false
    let clearCount = 0
    const context = { messages: [] }
    const signal = new AbortController().signal
    const previousCalls: Array<{ context: unknown; signal?: AbortSignal }> = []
    const agent = {
      shouldStopAfterTurn: async (receivedContext: unknown, receivedSignal?: AbortSignal) => {
        previousCalls.push({ context: receivedContext, signal: receivedSignal })
        return false
      },
    }
    const session = {
      agent,
      clearQueue: () => {
        clearCount += 1
        queuedByExtension = false
      },
    } as never

    installWorktreeHandoffLoopStop(session, () => terminating)

    expect(await agent.shouldStopAfterTurn?.(context, signal)).toBe(false)
    queuedByExtension = true
    terminating = true
    expect(await agent.shouldStopAfterTurn?.(context, signal)).toBe(true)
    expect(queuedByExtension).toBe(false)
    expect(await agent.shouldStopAfterTurn?.(context, signal)).toBe(true)
    expect(clearCount).toBe(1)
    expect(previousCalls).toEqual([
      { context, signal },
      { context, signal },
      { context, signal },
    ])
  })

  test('Given existing public turn hook already stops When Domi installs handoff hook Then preserves short-circuit without clearing queue', async () => {
    let domiPredicateCalls = 0
    let clearCount = 0
    const context = { messages: [] }
    const signal = new AbortController().signal
    const agent = {
      shouldStopAfterTurn: async (receivedContext: unknown, receivedSignal?: AbortSignal) => {
        expect(receivedContext).toBe(context)
        expect(receivedSignal).toBe(signal)
        return true
      },
    }
    const session = { agent, clearQueue: () => { clearCount += 1 } } as never

    installWorktreeHandoffLoopStop(session, () => {
      domiPredicateCalls += 1
      return true
    })

    expect(await agent.shouldStopAfterTurn?.(context, signal)).toBe(true)
    expect(domiPredicateCalls).toBe(0)
    expect(clearCount).toBe(0)
  })

  test('Given terminating tool 与其它工具混用 When 检查批次 Then fail closed', () => {
    expect(canRunSessionTerminatingTool('ForkToWorktree', ['ForkToWorktree'])).toBe(true)
    expect(canRunSessionTerminatingTool('ForkToWorktree', ['Read', 'ForkToWorktree'])).toBe(false)
    expect(canRunSessionTerminatingTool('ReadyForReview', ['ReadyForReview'])).toBe(true)
    expect(canRunSessionTerminatingTool('ReadyForReview', ['Bash', 'ReadyForReview'])).toBe(false)
    expect(canRunSessionTerminatingTool('RequestNextWorktreeIteration', ['RequestNextWorktreeIteration'])).toBe(true)
    expect(canRunSessionTerminatingTool('RequestNextWorktreeIteration', ['Read', 'RequestNextWorktreeIteration'])).toBe(false)
    expect(canRunSessionTerminatingTool('RequestWorktreePreviewRevision', ['RequestWorktreePreviewRevision'])).toBe(true)
    expect(canRunSessionTerminatingTool('RequestWorktreePreviewRevision', ['Read', 'RequestWorktreePreviewRevision'])).toBe(false)
    expect(canRunSessionTerminatingTool('CompactContext', ['CompactContext', 'ForkToWorktree'])).toBe(false)
  })
})

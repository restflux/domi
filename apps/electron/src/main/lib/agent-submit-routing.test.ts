import { describe, expect, test } from 'bun:test'
import type { AgentSubmitOrEnqueueInput } from '@domi/shared'
import {
  AgentSubmissionDeduplicator,
  assertAgentSubmissionMayProceed,
  buildDeferredAgentRunInput,
  isStaleActiveQueueError,
  routeAgentSubmission,
} from './agent-submit-routing'

const input: AgentSubmitOrEnqueueInput = {
  sessionId: 'session',
  queueMessageId: 'message',
  queueKind: 'steering',
  userMessage: 'sdk text',
  rawUserMessage: 'raw text',
  channelId: 'deepseek',
  dispatch: 'now',
}

describe('Agent submit-or-enqueue routing', () => {
  test('classifies only an ended active query as safe to hand off to the deferred queue', () => {
    expect(isStaleActiveQueueError(Object.assign(new Error('会话未运行，无法追加消息'), { code: 'agent.query.not_active' }))).toBeTrue()
    expect(isStaleActiveQueueError(new Error('无活跃消息通道可注入队列消息'))).toBeTrue()
    expect(isStaleActiveQueueError(new Error('当前会话没有正在运行的 Agent'))).toBeTrue()
    expect(isStaleActiveQueueError(Object.assign(new Error('query ended'), { code: 'agent.query.not_active' }))).toBeTrue()

    expect(isStaleActiveQueueError(new Error('会话正在回退，请等待完成后再发送'))).toBeFalse()
    expect(isStaleActiveQueueError(new Error('会话项目不匹配'))).toBeFalse()
    expect(isStaleActiveQueueError(new Error('权限请求仍在等待用户确认'))).toBeFalse()
    expect(isStaleActiveQueueError(new Error('[Agent 编排] 队列注入后运行状态已变化: session'))).toBeFalse()
  })

  test('rejects stop, rewind, blocking permission, released Worktree, and workspace ownership mismatches before accepting the message', () => {
    const valid = {
      rewinding: false,
      stopped: false,
      blockingPermission: false,
      delegationCheckoutReleased: false,
      sessionWorkspaceId: 'workspace',
      requestedWorkspaceId: 'workspace',
    }
    expect(() => assertAgentSubmissionMayProceed(valid)).not.toThrow()
    expect(() => assertAgentSubmissionMayProceed({ ...valid, rewinding: true })).toThrow('会话正在回退')
    expect(() => assertAgentSubmissionMayProceed({ ...valid, stopped: true })).toThrow('会话正在停止')
    expect(() => assertAgentSubmissionMayProceed({ ...valid, blockingPermission: true })).toThrow('权限请求仍在等待')
    expect(() => assertAgentSubmissionMayProceed({ ...valid, delegationCheckoutReleased: true })).toThrow('Worktree 占用已释放')
    expect(() => assertAgentSubmissionMayProceed({ ...valid, requestedWorkspaceId: 'other' })).toThrow('会话项目不匹配')
  })

  test('injects into the active run without touching the deferred queue', async () => {
    const events: string[] = []
    const result = await routeAgentSubmission(input, {
      isActive: () => true,
      inject: async () => { events.push('injected') },
      enqueue: () => { events.push('queued'); return true },
    })

    expect(result).toEqual({ disposition: 'injected' })
    expect(events).toEqual(['injected'])
  })

  test('atomically hands an unaccepted message to deferred queue when the active query ends', async () => {
    const events: string[] = []
    const result = await routeAgentSubmission(input, {
      isActive: () => true,
      inject: async () => { throw new Error('无活跃消息通道可注入队列消息') },
      enqueue: () => { events.push('queued'); return true },
    })

    expect(result).toEqual({ disposition: 'queued' })
    expect(events).toEqual(['queued'])
  })

  test('builds the next run with stable uuid while preserving attachments, mentions, asides, and execution controls', () => {
    const runInput = buildDeferredAgentRunInput({
      ...input,
      nextTurnAsides: [{ id: 'aside', content: 'context' }],
      additionalDirectories: ['D:/external'],
      mentionedSkills: ['skill'],
      mentionedMcpServers: ['mcp'],
      mentionedSessionIds: ['other-session'],
      mentionedTodoIds: ['todo'],
      mentionedCalendarEventIds: ['calendar'],
      executionPolicyOverride: 'controlled',
      workflowOverride: 'direct',
      interrupt: true,
    })

    expect(runInput).toMatchObject({
      sessionId: 'session',
      userMessage: 'sdk text',
      rawUserMessage: 'raw text',
      userMessageUuid: 'message',
      additionalDirectories: ['D:/external'],
      nextTurnAsides: [{ id: 'aside', content: 'context' }],
      mentionedSkills: ['skill'],
      mentionedMcpServers: ['mcp'],
      mentionedSessionIds: ['other-session'],
      mentionedTodoIds: ['todo'],
      mentionedCalendarEventIds: ['calendar'],
      executionPolicyOverride: 'controlled',
      workflowOverride: 'direct',
    })
    expect(runInput).not.toHaveProperty('dispatch')
    expect(runInput).not.toHaveProperty('interrupt')
    expect(runInput).not.toHaveProperty('queueKind')
    expect(runInput).not.toHaveProperty('queueMessageId')
  })

  test('coalesces concurrent duplicate submissions and reuses the accepted result', async () => {
    const deduplicator = new AgentSubmissionDeduplicator()
    let calls = 0
    const submit = async () => {
      calls += 1
      await Promise.resolve()
      return { disposition: 'queued' as const }
    }

    const [first, duplicate] = await Promise.all([
      deduplicator.submit(input, submit),
      deduplicator.submit(input, submit),
    ])
    const lateDuplicate = await deduplicator.submit(input, submit)

    expect(first).toEqual({ disposition: 'queued' })
    expect(duplicate).toEqual(first)
    expect(lateDuplicate).toEqual(first)
    expect(calls).toBe(1)
  })

  test('rechecks stop/rewind ownership before a stale active channel can enter deferred queue', async () => {
    let enqueued = false
    await expect(routeAgentSubmission(input, {
      isActive: () => true,
      inject: async () => { throw new Error('无活跃消息通道可注入队列消息') },
      beforeEnqueue: () => { throw new Error('会话正在停止，请等待本轮完全结束后再发送') },
      enqueue: () => { enqueued = true; return true },
    })).rejects.toThrow('会话正在停止')
    expect(enqueued).toBeFalse()
  })

  test('does not disguise permission, ownership, rewind, or ambiguous post-injection failures as queued success', async () => {
    for (const error of [
      new Error('会话项目不匹配'),
      new Error('权限请求仍在等待用户确认'),
      new Error('会话正在回退，请等待完成后再发送'),
      new Error('[Agent 编排] 队列注入后运行状态已变化: session'),
    ]) {
      let enqueued = false
      await expect(routeAgentSubmission(input, {
        isActive: () => true,
        inject: async () => { throw error },
        enqueue: () => { enqueued = true; return true },
      })).rejects.toThrow(error.message)
      expect(enqueued).toBeFalse()
    }
  })
})

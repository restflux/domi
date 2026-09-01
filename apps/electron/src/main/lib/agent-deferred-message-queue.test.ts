import { describe, expect, test } from 'bun:test'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
import type { AgentDeferredQueueMessageInput } from '@domi/shared'
import { AgentDeferredMessageQueue } from './agent-deferred-message-queue'

function message(id: string, sessionId = 'session'): AgentDeferredQueueMessageInput {
  return {
    sessionId,
    queueMessageId: id,
    queueKind: 'steering',
    userMessage: `sdk:${id}`,
    rawUserMessage: `raw:${id}`,
    userMessageUuid: id,
    channelId: 'deepseek',
    modelId: 'deepseek-v4-flash',
    workspaceId: 'workspace',
    additionalDirectories: ['D:/external'],
    nextTurnAsides: [{ id: 'aside-1', content: 'aside' }],
    mentionedSkills: ['skill'],
    mentionedMcpServers: ['mcp'],
    mentionedSessionIds: ['other-session'],
    mentionedTodoIds: ['todo'],
    mentionedCalendarEventIds: ['calendar'],
  }
}

describe('main deferred Agent message queue', () => {
  test('starts an accepted idle-session message once with its complete payload and stable uuid', () => {
    const started: AgentDeferredQueueMessageInput[] = []
    const statuses: Array<{ messageId: string; startedAt: number }> = []
    const queue = new AgentDeferredMessageQueue({
      isActive: () => false,
      startRun: (input) => { started.push(input) },
      onStarted: (input, startedAt) => statuses.push({ messageId: input.queueMessageId, startedAt }),
      now: () => 123,
    })
    const input = message('message-1')

    expect(queue.enqueue(input)).toBeTrue()
    expect(queue.enqueue(input)).toBeFalse()

    expect(started).toEqual([{ ...input, startedAt: 123, userMessageUuid: 'message-1' }])
    expect(statuses).toEqual([{ messageId: 'message-1', startedAt: 123 }])
    expect(queue.isDispatching('session')).toBeTrue()
  })

  test('waits for the active run, preserves queue order changes, and synchronizes cancellation results', () => {
    let active = true
    const scheduled: Array<() => void> = []
    const started: string[] = []
    const queue = new AgentDeferredMessageQueue({
      isActive: () => active,
      startRun: (input) => { started.push(input.queueMessageId) },
      onStarted: () => {},
      schedule: (callback) => scheduled.push(callback),
    })

    queue.enqueue(message('first'))
    queue.enqueue(message('second'))
    queue.enqueue(message('third'))
    expect(started).toEqual([])
    expect(queue.move({ sessionId: 'session', sourceId: 'third', targetId: 'first', placement: 'before' })).toBeTrue()
    expect(queue.cancel({ sessionId: 'session', messageId: 'second' })).toBeTrue()
    expect(queue.cancel({ sessionId: 'session', messageId: 'second' })).toBeFalse()

    active = false
    queue.onRunComplete('session', false, false)
    scheduled.shift()?.()

    expect(started).toEqual(['third'])
    expect(queue.cancel({ sessionId: 'session', messageId: 'third' })).toBeFalse()
  })

  test('serializes a new run against late completion callbacks and never starts the same message twice', async () => {
    let active = true
    const firstRun = deferred()
    const started: string[] = []
    const scheduled: Array<() => void> = []
    const queue = new AgentDeferredMessageQueue({
      isActive: () => active,
      startRun: (input) => {
        started.push(input.queueMessageId)
        return input.queueMessageId === 'first' ? firstRun.promise : Promise.resolve()
      },
      onStarted: () => {},
      schedule: (callback) => scheduled.push(callback),
    })

    queue.enqueue(message('first'))
    queue.enqueue(message('second'))
    active = false
    queue.onRunComplete('session', false, false)
    queue.onRunComplete('session', false, false)
    for (const callback of scheduled.splice(0)) callback()
    expect(started).toEqual(['first'])

    firstRun.resolve()
    await firstRun.promise
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual(['first', 'second'])
  })

  test('does not dispatch while background work owns the run and clears pending messages when stop wins', () => {
    let active = true
    const scheduled: Array<() => void> = []
    const started: string[] = []
    const queue = new AgentDeferredMessageQueue({
      isActive: () => active,
      startRun: (input) => { started.push(input.queueMessageId) },
      onStarted: () => {},
      schedule: (callback) => scheduled.push(callback),
    })

    queue.enqueue(message('waiting'))
    active = false
    queue.onRunComplete('session', false, true)
    expect(scheduled).toHaveLength(0)
    expect(started).toEqual([])

    queue.onRunComplete('session', true, false)
    expect(queue.hasPending('session')).toBeFalse()
    expect(started).toEqual([])
  })
})

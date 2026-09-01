import { describe, expect, test } from 'bun:test'
import type { AgentAssistantDeltaPayload } from '@domi/shared'
import {
  createAgentDeltaFrameBatcher,
  hasAgentAssistantDeltaControlEvent,
} from './agent-delta-frame-batcher'
import {
  applyAssistantDeltasToPreview,
  createAssistantDeltaPreview,
  upsertAgentSDKMessage,
} from './agent-assistant-delta'

class FakeScheduler {
  private nextId = 1
  private readonly callbacks = new Map<number, () => void>()
  private readonly cancelled = new Map<number, () => void>()

  maxPending = 0
  cancelCount = 0

  readonly schedule = (callback: () => void): number => {
    const id = this.nextId++
    this.callbacks.set(id, callback)
    this.maxPending = Math.max(this.maxPending, this.callbacks.size)
    return id
  }

  readonly cancel = (id: number): void => {
    const callback = this.callbacks.get(id)
    if (callback) {
      this.cancelled.set(id, callback)
      this.cancelCount += 1
    }
    this.callbacks.delete(id)
  }

  runScheduled(): void {
    const callbacks = [...this.callbacks.values()]
    this.callbacks.clear()
    for (const callback of callbacks) callback()
  }

  runCancelled(): void {
    const callbacks = [...this.cancelled.values()]
    this.cancelled.clear()
    for (const callback of callbacks) callback()
  }
}

class FakeFrames {
  private readonly scheduler = new FakeScheduler()

  get maxPending(): number {
    return this.scheduler.maxPending
  }

  get cancelCount(): number {
    return this.scheduler.cancelCount
  }

  readonly request = this.scheduler.schedule
  readonly cancel = this.scheduler.cancel

  runFrame(): void {
    this.scheduler.runScheduled()
  }

  runCancelled(): void {
    this.scheduler.runCancelled()
  }
}

class FakeFallbacks {
  private readonly scheduler = new FakeScheduler()

  readonly delays: number[] = []

  get maxPending(): number {
    return this.scheduler.maxPending
  }

  get cancelCount(): number {
    return this.scheduler.cancelCount
  }

  readonly schedule = (callback: () => void, delayMs: number): number => {
    this.delays.push(delayMs)
    return this.scheduler.schedule(callback)
  }
  readonly cancel = this.scheduler.cancel

  runFallback(): void {
    this.scheduler.runScheduled()
  }

  runCancelled(): void {
    this.scheduler.runCancelled()
  }
}


function delta(sessionId: string, runStartedAt: number, text: string): AgentAssistantDeltaPayload {
  return {
    uuid: `assistant-${runStartedAt}`,
    session_id: sessionId,
    runStartedAt,
    deltas: [{ type: 'text_delta', contentIndex: 0, delta: text }],
  }
}

function textOf(payloads: readonly AgentAssistantDeltaPayload[]): string {
  return payloads.flatMap((payload) => payload.deltas)
    .map((item) => item.type === 'text_delta' ? item.delta : '')
    .join('')
}

describe('Agent renderer delta frame batcher', () => {
  test('flushes visible output through the watchdog when animation frames are background-throttled', () => {
    const frames = new FakeFrames()
    const fallbacks = new FakeFallbacks()
    const commits: Array<Map<string, AgentAssistantDeltaPayload[]>> = []
    const batcher = createAgentDeltaFrameBatcher({
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      scheduleFallback: fallbacks.schedule,
      cancelFallback: fallbacks.cancel,
      commit: (pending) => commits.push(pending),
    })
    batcher.setVisibleSession('session')

    batcher.enqueue('session', delta('session', 1, 'still delivered'))
    fallbacks.runFallback()

    expect(commits).toHaveLength(1)
    expect(textOf(commits[0]?.get('session') ?? [])).toBe('still delivered')
    expect(fallbacks.delays).toEqual([100])
    expect(frames.cancelCount).toBe(1)

    frames.runCancelled()
    expect(commits).toHaveLength(1)
  })

  test('cancels the watchdog when the animation frame flushes first', () => {
    const frames = new FakeFrames()
    const fallbacks = new FakeFallbacks()
    const commits: Array<Map<string, AgentAssistantDeltaPayload[]>> = []
    const batcher = createAgentDeltaFrameBatcher({
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      scheduleFallback: fallbacks.schedule,
      cancelFallback: fallbacks.cancel,
      commit: (pending) => commits.push(pending),
    })
    batcher.setVisibleSession('session')

    batcher.enqueue('session', delta('session', 1, 'frame wins'))
    frames.runFrame()

    expect(commits).toHaveLength(1)
    expect(fallbacks.cancelCount).toBe(1)

    fallbacks.runCancelled()
    expect(commits).toHaveLength(1)
  })

  test('keeps scheduler backlog bounded across a long background-throttled stream', () => {
    const frames = new FakeFrames()
    const fallbacks = new FakeFallbacks()
    const commits: Array<Map<string, AgentAssistantDeltaPayload[]>> = []
    const batcher = createAgentDeltaFrameBatcher({
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      scheduleFallback: fallbacks.schedule,
      cancelFallback: fallbacks.cancel,
      commit: (pending) => commits.push(pending),
    })
    batcher.setVisibleSession('session')

    for (let batch = 0; batch < 50; batch += 1) {
      batcher.enqueue('session', delta('session', 1, `${batch},`))
      fallbacks.runFallback()
    }

    expect(commits).toHaveLength(50)
    expect(frames.maxPending).toBe(1)
    expect(fallbacks.maxPending).toBe(1)
    expect(frames.cancelCount).toBe(50)

    frames.runCancelled()
    expect(commits).toHaveLength(50)
  })

  test('classifies only tool-call deltas as legacy control work', () => {
    expect(hasAgentAssistantDeltaControlEvent(delta('session', 1, 'text'))).toBeFalse()
    expect(hasAgentAssistantDeltaControlEvent({
      ...delta('session', 1, ''),
      deltas: [{
        type: 'toolcall_start',
        contentIndex: 0,
        toolCall: { id: 'tool-1', name: 'Bash', arguments: { command: 'pwd' } },
      }],
    })).toBeTrue()
  })

  test('keeps eight hidden sessions and 160 delta frames entirely off React state', () => {
    const frames = new FakeFrames()
    const commits: Array<Map<string, AgentAssistantDeltaPayload[]>> = []
    const batcher = createAgentDeltaFrameBatcher({
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      commit: (pending) => commits.push(pending),
    })
    batcher.setVisibleSession('visible')

    for (let agent = 0; agent < 8; agent += 1) {
      for (let frame = 0; frame < 20; frame += 1) {
        batcher.enqueue(`background-${agent}`, delta(`background-${agent}`, 1, `${frame},`))
        frames.runFrame()
      }
    }

    expect(commits).toHaveLength(0)
  })

  test('commits only the visible session on the next animation frame and keeps background sessions off React state', () => {
    const frames = new FakeFrames()
    const commits: Array<Map<string, AgentAssistantDeltaPayload[]>> = []
    const batcher = createAgentDeltaFrameBatcher({
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      commit: (pending) => commits.push(pending),
    })
    batcher.setVisibleSession('visible')

    batcher.enqueue('visible', delta('visible', 1, 'a'))
    batcher.enqueue('background-1', delta('background-1', 1, 'x'))
    batcher.enqueue('visible', delta('visible', 1, 'b'))
    batcher.enqueue('background-2', delta('background-2', 1, 'y'))

    expect(commits).toHaveLength(0)
    frames.runFrame()

    expect(commits).toHaveLength(1)
    expect(textOf(commits[0]?.get('visible') ?? [])).toBe('ab')
    expect(commits[0]?.has('background-1')).toBeFalse()
    expect(commits[0]?.has('background-2')).toBeFalse()

    frames.runFrame()
    expect(commits).toHaveLength(1)
  })

  test('flushes all ordered background output immediately when that session becomes visible', () => {
    const frames = new FakeFrames()
    const commits: Array<Map<string, AgentAssistantDeltaPayload[]>> = []
    const batcher = createAgentDeltaFrameBatcher({
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      commit: (pending) => commits.push(pending),
    })
    batcher.setVisibleSession('front')

    batcher.enqueue('background', delta('background', 1, 'a'))
    batcher.enqueue('background', delta('background', 1, 'b'))
    frames.runFrame()
    expect(commits).toHaveLength(0)

    batcher.setVisibleSession('background')
    expect(commits).toHaveLength(1)
    const backgroundPayloads = commits[0]?.get('background') ?? []
    expect(textOf(backgroundPayloads)).toBe('ab')
    expect(backgroundPayloads).toHaveLength(1)
    expect(backgroundPayloads[0]?.deltas).toHaveLength(1)
  })

  test('flushes one hidden session synchronously before final while leaving other background output buffered', () => {
    const frames = new FakeFrames()
    const commits: Array<Map<string, AgentAssistantDeltaPayload[]>> = []
    const batcher = createAgentDeltaFrameBatcher({
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      commit: (pending) => commits.push(pending),
    })
    batcher.setVisibleSession('visible')

    batcher.enqueue('finishing', delta('finishing', 1, 'final-prefix'))
    batcher.enqueue('other', delta('other', 1, 'background'))
    batcher.flushSession('finishing')

    expect(commits).toHaveLength(1)
    expect(textOf(commits[0]?.get('finishing') ?? [])).toBe('final-prefix')
    expect(commits[0]?.has('other')).toBeFalse()

    frames.runFrame()
    expect(commits).toHaveLength(1)
    batcher.setVisibleSession('other')
    expect(commits).toHaveLength(2)
    expect(textOf(commits[1]?.get('other') ?? [])).toBe('background')
  })

  test('flushes the pending preview and cancels both schedulers before the authoritative final replaces the same uuid', () => {
    const frames = new FakeFrames()
    const fallbacks = new FakeFallbacks()
    let messages: import('@domi/shared').SDKMessage[] = []
    const batcher = createAgentDeltaFrameBatcher({
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      scheduleFallback: fallbacks.schedule,
      cancelFallback: fallbacks.cancel,
      commit: (pending) => {
        for (const payload of pending.get('session') ?? []) {
          const current = messages.find((message) => (message as { uuid?: string }).uuid === payload.uuid)
          const preview = current?.type === 'assistant'
            ? current as import('@domi/shared').SDKAssistantMessage
            : createAssistantDeltaPreview(payload)
          messages = upsertAgentSDKMessage(messages, applyAssistantDeltasToPreview(preview, payload.deltas))
        }
      },
    })

    batcher.setVisibleSession('session')
    batcher.enqueue('session', delta('session', 1, 'preview'))
    batcher.flushSession('session')
    expect(frames.cancelCount).toBe(1)
    expect(fallbacks.cancelCount).toBe(1)

    messages = upsertAgentSDKMessage(messages, {
      type: 'assistant',
      uuid: 'assistant-1',
      session_id: 'session',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'authoritative final' }] },
    } as import('@domi/shared').SDKAssistantMessage)
    frames.runCancelled()
    fallbacks.runCancelled()

    expect(messages).toHaveLength(1)
    expect((messages[0] as import('@domi/shared').SDKAssistantMessage).message.content)
      .toEqual([{ type: 'text', text: 'authoritative final' }])
  })

  test('cancels stale schedulers when the visible session is discarded before switching sessions', () => {
    const frames = new FakeFrames()
    const fallbacks = new FakeFallbacks()
    const commits: Array<Map<string, AgentAssistantDeltaPayload[]>> = []
    const batcher = createAgentDeltaFrameBatcher({
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      scheduleFallback: fallbacks.schedule,
      cancelFallback: fallbacks.cancel,
      commit: (pending) => commits.push(pending),
    })
    batcher.setVisibleSession('old')
    batcher.enqueue('old', delta('old', 1, 'discarded'))
    batcher.enqueue('next', delta('next', 2, 'preserved'))

    batcher.discardSession('old')
    batcher.setVisibleSession('next')

    expect(commits).toHaveLength(1)
    expect(textOf(commits[0]?.get('next') ?? [])).toBe('preserved')
    expect(frames.cancelCount).toBe(1)
    expect(fallbacks.cancelCount).toBe(1)

    frames.runCancelled()
    fallbacks.runCancelled()
    expect(commits).toHaveLength(1)
  })

  test('drops queued old-run deltas and ignores stale callbacks after watchdog flush and dispose', () => {
    const frames = new FakeFrames()
    const fallbacks = new FakeFallbacks()
    const commits: Array<Map<string, AgentAssistantDeltaPayload[]>> = []
    const batcher = createAgentDeltaFrameBatcher({
      requestFrame: frames.request,
      cancelFrame: frames.cancel,
      scheduleFallback: fallbacks.schedule,
      cancelFallback: fallbacks.cancel,
      commit: (pending) => commits.push(pending),
    })
    batcher.setVisibleSession('session')

    batcher.enqueue('session', delta('session', 1, 'old'))
    batcher.enqueue('session', delta('session', 2, 'new'))
    fallbacks.runFallback()
    frames.runCancelled()

    expect(commits).toHaveLength(1)
    expect(textOf(commits[0]?.get('session') ?? [])).toBe('new')

    batcher.enqueue('session', delta('session', 2, 'late'))
    batcher.dispose()
    frames.runCancelled()
    fallbacks.runCancelled()
    expect(commits).toHaveLength(1)
    expect(frames.cancelCount).toBe(2)
    expect(fallbacks.cancelCount).toBe(1)
  })
})

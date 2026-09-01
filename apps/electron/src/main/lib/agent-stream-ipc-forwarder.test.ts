import { describe, expect, test } from 'bun:test'
import type { AgentAssistantDeltaPayload } from '@domi/shared'
import { createAgentStreamIpcForwarder } from './agent-stream-ipc-forwarder'

class FakeClock {
  nowMs = 0
  private nextId = 1
  private readonly tasks = new Map<number, { at: number; callback: () => void }>()
  private readonly cancelled: Array<() => void> = []

  readonly setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextId++
    this.tasks.set(id, { at: this.nowMs + Math.max(0, delayMs), callback })
    return id
  }

  readonly clearTimeout = (id: number): void => {
    const task = this.tasks.get(id)
    if (task) this.cancelled.push(task.callback)
    this.tasks.delete(id)
  }

  runCancelled(): void {
    const callbacks = this.cancelled.splice(0)
    for (const callback of callbacks) callback()
  }

  advance(ms: number): void {
    const target = this.nowMs + ms
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      if (!next) break
      const [id, task] = next
      this.tasks.delete(id)
      this.nowMs = task.at
      task.callback()
    }
    this.nowMs = target
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

function emittedText(payloads: AgentAssistantDeltaPayload[]): string {
  return payloads.flatMap((payload) => payload.deltas)
    .map((item) => item.type === 'text_delta' ? item.delta : '')
    .join('')
}

describe('Agent stream IPC forwarder', () => {
  test('uses a smoother default cadence for the visible session while preserving background throttling', () => {
    const clock = new FakeClock()
    const front: AgentAssistantDeltaPayload[] = []
    const background: AgentAssistantDeltaPayload[] = []
    const forwarder = createAgentStreamIpcForwarder({
      now: () => clock.nowMs,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    })
    forwarder.setForegroundSession('front')

    forwarder.enqueue('front', delta('front', 1, 'a'), (payload) => front.push(payload))
    forwarder.enqueue('background', delta('background', 1, 'x'), (payload) => background.push(payload))
    clock.advance(0)
    forwarder.enqueue('front', delta('front', 1, 'b'), (payload) => front.push(payload))
    forwarder.enqueue('background', delta('background', 1, 'y'), (payload) => background.push(payload))

    clock.advance(31)
    expect(emittedText(front)).toBe('a')
    clock.advance(1)
    expect(emittedText(front)).toBe('ab')
    expect(emittedText(background)).toBe('x')

    clock.advance(218)
    expect(emittedText(background)).toBe('xy')
  })

  test('keeps the configured visible session near 20fps and background sessions at or below 4fps without losing deltas', () => {
    const clock = new FakeClock()
    const front: AgentAssistantDeltaPayload[] = []
    const backgrounds = new Map<string, AgentAssistantDeltaPayload[]>(
      Array.from({ length: 8 }, (_, index) => [`background-${index}`, []]),
    )
    const forwarder = createAgentStreamIpcForwarder({
      now: () => clock.nowMs,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      foregroundIntervalMs: 50,
      backgroundIntervalMs: 250,
    })
    forwarder.setForegroundSession('front')

    for (let index = 0; index < 100; index++) {
      forwarder.enqueue('front', delta('front', 1, `${index},`), (payload) => front.push(payload))
      for (const [sessionId, emitted] of backgrounds) {
        forwarder.enqueue(sessionId, delta(sessionId, 1, `${index},`), (payload) => emitted.push(payload))
      }
      clock.advance(10)
    }
    forwarder.flush('front')
    for (const sessionId of backgrounds.keys()) forwarder.flush(sessionId)

    const expectedText = Array.from({ length: 100 }, (_, index) => `${index},`).join('')
    // 1 秒窗口含 t=0 的首批：前台 21 批（20 个稳态间隔），每个后台 5 批（4 个稳态间隔）。
    expect(front).toHaveLength(21)
    expect(emittedText(front)).toBe(expectedText)
    for (const emitted of backgrounds.values()) {
      expect(emitted).toHaveLength(5)
      expect(emittedText(emitted)).toBe(expectedText)
    }
  })

  test('flushes accumulated background output immediately when the session becomes visible and slows the previous foreground session', () => {
    const clock = new FakeClock()
    const first: AgentAssistantDeltaPayload[] = []
    const second: AgentAssistantDeltaPayload[] = []
    const forwarder = createAgentStreamIpcForwarder({
      now: () => clock.nowMs,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      foregroundIntervalMs: 50,
      backgroundIntervalMs: 250,
    })
    forwarder.setForegroundSession('first')
    forwarder.enqueue('first', delta('first', 1, 'a'), (payload) => first.push(payload))
    forwarder.enqueue('second', delta('second', 1, 'x'), (payload) => second.push(payload))
    clock.advance(0)
    forwarder.enqueue('first', delta('first', 1, 'b'), (payload) => first.push(payload))
    forwarder.enqueue('second', delta('second', 1, 'y'), (payload) => second.push(payload))
    clock.advance(20)

    forwarder.setForegroundSession('second')

    expect(emittedText(second)).toBe('xy')
    expect(first).toHaveLength(1)
    clock.advance(30)
    expect(first).toHaveLength(1)
    clock.advance(200)
    expect(emittedText(first)).toBe('ab')
  })

  test('terminal flush is immediate and a new run discards a pending stale-run timer', () => {
    const clock = new FakeClock()
    const emitted: AgentAssistantDeltaPayload[] = []
    const forwarder = createAgentStreamIpcForwarder({
      now: () => clock.nowMs,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      foregroundIntervalMs: 50,
      backgroundIntervalMs: 250,
    })
    forwarder.setForegroundSession('session')
    forwarder.enqueue('session', delta('session', 1, 'old-1'), (payload) => emitted.push(payload))
    clock.advance(0)
    forwarder.enqueue('session', delta('session', 1, 'old-pending'), (payload) => emitted.push(payload))
    clock.advance(10)
    forwarder.enqueue('session', delta('session', 2, 'new'), (payload) => emitted.push(payload))
    clock.runCancelled()
    expect(emitted).toHaveLength(1)

    forwarder.flush('session')
    clock.advance(100)

    expect(emitted).toHaveLength(2)
    expect(emitted[0]?.runStartedAt).toBe(1)
    expect(emitted[1]?.runStartedAt).toBe(2)
    expect(emittedText(emitted)).toBe('old-1new')
  })
})

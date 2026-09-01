import type { AgentAssistantDeltaPayload } from '@domi/shared'

export interface AgentStreamIpcForwarder {
  enqueue: (
    sessionId: string,
    payload: AgentAssistantDeltaPayload,
    send: (payload: AgentAssistantDeltaPayload) => void,
  ) => void
  flush: (sessionId: string) => void
  setForegroundSession: (sessionId: string | null) => void
  release: (sessionId: string) => void
  dispose: () => void
}

export interface AgentStreamIpcForwarderOptions<TTimer = ReturnType<typeof setTimeout>> {
  now?: () => number
  setTimeout?: (callback: () => void, delayMs: number) => TTimer
  clearTimeout?: (timer: TTimer) => void
  foregroundIntervalMs?: number
  backgroundIntervalMs?: number
}

interface PendingSession<TTimer> {
  payload?: AgentAssistantDeltaPayload
  send?: (payload: AgentAssistantDeltaPayload) => void
  timer?: TTimer
  timerGeneration?: number
  lastEmittedAt?: number
}

function sameAssistantRun(
  left: AgentAssistantDeltaPayload,
  right: AgentAssistantDeltaPayload,
): boolean {
  return left.uuid === right.uuid && left.runStartedAt === right.runStartedAt
}

/**
 * 在 main→renderer 边界按会话合并结构化 assistant delta。当前可见会话保持约
 * 30fps，后台会话降到约 4fps；终态可通过 flush() 立即排空。
 */
export function createAgentStreamIpcForwarder<TTimer = ReturnType<typeof setTimeout>>(
  options: AgentStreamIpcForwarderOptions<TTimer> = {},
): AgentStreamIpcForwarder {
  const now = options.now ?? Date.now
  const scheduleTimeout: (callback: () => void, delayMs: number) => TTimer = options.setTimeout
    ?? ((callback, delayMs) => setTimeout(callback, delayMs) as TTimer)
  const cancelTimeout: (timer: TTimer) => void = options.clearTimeout
    ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const foregroundIntervalMs = options.foregroundIntervalMs ?? 32
  const backgroundIntervalMs = options.backgroundIntervalMs ?? 250
  const sessions = new Map<string, PendingSession<TTimer>>()
  let foregroundSessionId: string | null = null
  let disposed = false

  const intervalFor = (sessionId: string): number => (
    sessionId === foregroundSessionId ? foregroundIntervalMs : backgroundIntervalMs
  )

  const cancelTimer = (entry: PendingSession<TTimer>): void => {
    entry.timerGeneration = (entry.timerGeneration ?? 0) + 1
    if (entry.timer === undefined) return
    cancelTimeout(entry.timer)
    entry.timer = undefined
  }

  const emitPending = (entry: PendingSession<TTimer>): void => {
    cancelTimer(entry)
    if (disposed || !entry.payload || !entry.send) return
    const payload = entry.payload
    const send = entry.send
    entry.payload = undefined
    entry.send = undefined
    entry.lastEmittedAt = now()
    send(payload)
  }

  const arm = (sessionId: string, entry: PendingSession<TTimer>): void => {
    if (disposed || !entry.payload || entry.timer !== undefined) return
    const elapsed = entry.lastEmittedAt === undefined ? Number.POSITIVE_INFINITY : now() - entry.lastEmittedAt
    const delay = Math.max(0, intervalFor(sessionId) - elapsed)
    const timerGeneration = (entry.timerGeneration ?? 0) + 1
    entry.timerGeneration = timerGeneration
    entry.timer = scheduleTimeout(() => {
      if (entry.timerGeneration !== timerGeneration) return
      entry.timer = undefined
      emitPending(entry)
    }, delay)
  }

  const rearm = (sessionId: string): void => {
    const entry = sessions.get(sessionId)
    if (!entry?.payload) return
    cancelTimer(entry)
    arm(sessionId, entry)
  }

  const flush = (sessionId: string): void => {
    const entry = sessions.get(sessionId)
    if (!entry) return
    emitPending(entry)
  }

  return {
    enqueue(sessionId, payload, send) {
      if (disposed) return
      let entry = sessions.get(sessionId)
      if (!entry) {
        entry = {}
        sessions.set(sessionId, entry)
      }

      if (entry.payload && !sameAssistantRun(entry.payload, payload)) {
        if (entry.payload.runStartedAt === payload.runStartedAt) {
          // 同一 run 出现新的 assistant UUID 时先保持顺序发送旧 assistant。
          emitPending(entry)
        } else {
          // 新 run 已开始：旧 run 的迟到定时器不得再触达 renderer。
          cancelTimer(entry)
          entry.payload = undefined
          entry.send = undefined
        }
      }

      entry.payload = entry.payload
        ? {
            ...entry.payload,
            ...payload,
            deltas: [...entry.payload.deltas, ...payload.deltas],
          }
        : payload
      entry.send = send
      arm(sessionId, entry)
    },

    flush,

    setForegroundSession(sessionId) {
      if (disposed || foregroundSessionId === sessionId) return
      const previous = foregroundSessionId
      foregroundSessionId = sessionId
      if (previous) rearm(previous)
      if (sessionId) flush(sessionId)
    },

    release(sessionId) {
      const entry = sessions.get(sessionId)
      if (!entry) return
      cancelTimer(entry)
      sessions.delete(sessionId)
    },

    dispose() {
      if (disposed) return
      disposed = true
      for (const entry of sessions.values()) cancelTimer(entry)
      sessions.clear()
      foregroundSessionId = null
    },
  }
}

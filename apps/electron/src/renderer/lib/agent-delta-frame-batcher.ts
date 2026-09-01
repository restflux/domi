import type { AgentAssistantDelta, AgentAssistantDeltaPayload } from '@domi/shared'

export interface AgentDeltaFrameBatcher {
  enqueue: (sessionId: string, payload: AgentAssistantDeltaPayload) => void
  setVisibleSession: (sessionId: string | null) => void
  flushSession: (sessionId: string) => void
  discardSession: (sessionId: string) => void
  dispose: () => void
}

export interface AgentDeltaFrameBatcherOptions {
  requestFrame?: (callback: () => void) => number
  cancelFrame?: (frameId: number) => void
  scheduleFallback?: (callback: () => void, delayMs: number) => number
  cancelFallback?: (fallbackId: number) => void
  fallbackDelayMs?: number
  commit: (pending: Map<string, AgentAssistantDeltaPayload[]>) => void
}

export function hasAgentAssistantDeltaControlEvent(payload: AgentAssistantDeltaPayload): boolean {
  return payload.deltas.some((delta) => (
    delta.type === 'toolcall_start' || delta.type === 'toolcall_end'
  ))
}

function mergeAgentAssistantDeltas(
  previous: readonly AgentAssistantDelta[],
  incoming: readonly AgentAssistantDelta[],
): AgentAssistantDelta[] {
  const merged = [...previous]
  for (const delta of incoming) {
    const latest = merged[merged.length - 1]
    if (
      latest?.type === 'text_delta'
      && delta.type === 'text_delta'
      && latest.contentIndex === delta.contentIndex
    ) {
      merged[merged.length - 1] = { ...delta, delta: latest.delta + delta.delta }
    } else if (
      latest?.type === 'thinking_delta'
      && delta.type === 'thinking_delta'
      && latest.contentIndex === delta.contentIndex
    ) {
      merged[merged.length - 1] = { ...delta, delta: latest.delta + delta.delta }
    } else {
      merged.push(delta)
    }
  }
  return merged
}

/**
 * 将 IPC 回调中到达的 assistant delta 按 session 合并。只有当前真正展示转录的会话
 * 会在下一浏览器帧提交；后台会话保留在非 React 缓冲区，直到切到前台或控制/终态
 * 事件显式 flush，避免并发 Agent 按 N 倍频率写 live-message atoms。
 */
export function createAgentDeltaFrameBatcher(
  options: AgentDeltaFrameBatcherOptions,
): AgentDeltaFrameBatcher {
  const requestFrame = options.requestFrame ?? requestAnimationFrame
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame
  const scheduleFallback = options.scheduleFallback
    ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs) as unknown as number)
  const cancelFallback = options.cancelFallback ?? ((fallbackId) => globalThis.clearTimeout(fallbackId))
  const fallbackDelayMs = options.fallbackDelayMs ?? 100
  const pending = new Map<string, AgentAssistantDeltaPayload[]>()
  let visibleSessionId: string | null = null
  let frameId: number | undefined
  let fallbackId: number | undefined
  let generation = 0
  let disposed = false

  const cancelScheduledFlush = (): void => {
    generation += 1
    if (frameId !== undefined) cancelFrame(frameId)
    if (fallbackId !== undefined) cancelFallback(fallbackId)
    frameId = undefined
    fallbackId = undefined
  }

  const scheduleVisible = (): void => {
    if (
      disposed
      || frameId !== undefined
      || fallbackId !== undefined
      || !visibleSessionId
      || !pending.has(visibleSessionId)
    ) return
    const scheduledGeneration = generation
    const flush = (): void => {
      if (disposed || scheduledGeneration !== generation || !visibleSessionId) return
      const sessionId = visibleSessionId
      cancelScheduledFlush()
      const sessionPending = pending.get(sessionId)
      if (!sessionPending || sessionPending.length === 0) return
      pending.delete(sessionId)
      options.commit(new Map([[sessionId, sessionPending]]))
      scheduleVisible()
    }
    frameId = requestFrame(flush)
    fallbackId = scheduleFallback(flush, fallbackDelayMs)
  }

  const flushSession = (sessionId: string): void => {
    if (disposed) return
    const sessionPending = pending.get(sessionId)
    if (!sessionPending || sessionPending.length === 0) return
    pending.delete(sessionId)
    options.commit(new Map([[sessionId, sessionPending]]))
    if (sessionId === visibleSessionId) cancelScheduledFlush()
    scheduleVisible()
  }

  return {
    enqueue(sessionId, payload) {
      if (disposed) return
      const current = pending.get(sessionId)
      const latest = current?.[current.length - 1]
      if (!current || !latest || latest.runStartedAt !== payload.runStartedAt) {
        pending.set(sessionId, [payload])
      } else if (latest.uuid === payload.uuid) {
        current[current.length - 1] = {
          ...latest,
          ...payload,
          deltas: mergeAgentAssistantDeltas(latest.deltas, payload.deltas),
        }
      } else {
        current.push(payload)
      }
      scheduleVisible()
    },

    setVisibleSession(sessionId) {
      if (disposed || visibleSessionId === sessionId) return
      cancelScheduledFlush()
      visibleSessionId = sessionId
      if (sessionId) flushSession(sessionId)
      else scheduleVisible()
    },

    flushSession,

    discardSession(sessionId) {
      pending.delete(sessionId)
      if (sessionId === visibleSessionId) cancelScheduledFlush()
      scheduleVisible()
    },

    dispose() {
      if (disposed) return
      disposed = true
      cancelScheduledFlush()
      pending.clear()
      visibleSessionId = null
    },
  }
}

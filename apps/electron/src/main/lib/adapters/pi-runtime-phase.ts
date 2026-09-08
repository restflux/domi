import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { AgentRuntimePhaseUpdate } from '@domi/shared'

/** 请求级等待不能由历史正文推断；仅有效的新输出结束等待。 */
export function createPiRuntimePhaseTracker(
  runStartedAt: number,
  notify: (update: AgentRuntimePhaseUpdate) => void,
) {
  let current: AgentRuntimePhaseUpdate['phase'] | undefined
  let retryEmpty = false
  const emit = (phase: AgentRuntimePhaseUpdate['phase']) => {
    if (current === phase) return
    current = phase
    notify({ phase, runStartedAt })
  }
  return {
    retryEmptyResponse() { retryEmpty = true },
    requestStarted() {
      emit(retryEmpty ? 'empty_retry' : 'waiting')
      retryEmpty = false
    },
    observe(event: AgentSessionEvent) {
      if (event.type !== 'message_update') return
      const update = event.assistantMessageEvent
      const effective = (update.type === 'text_delta' || update.type === 'thinking_delta' || update.type === 'toolcall_delta')
        ? update.delta.length > 0
        : (update.type === 'text_end' || update.type === 'thinking_end')
          ? update.content.length > 0
          : update.type === 'toolcall_start' || update.type === 'toolcall_end'
      if (effective) emit('receiving')
    },
  }
}

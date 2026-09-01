import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { PiRunAuditRecorder } from '../audit/pi-run-audit.ts'
import { isAssistantPiMessage } from './pi-message-adapter.ts'

function isEffectiveAssistantUpdate(
  event: Extract<AgentSessionEvent, { type: 'message_update' }>,
): boolean {
  const update = event.assistantMessageEvent
  switch (update.type) {
    case 'text_delta':
    case 'thinking_delta':
    case 'toolcall_delta':
      return update.delta.length > 0
    case 'text_end':
    case 'thinking_end':
      return update.content.length > 0
    case 'toolcall_end':
    case 'done':
      return true
    default:
      return false
  }
}

/**
 * Pi AgentSessionEvent 到 audit 深模块的窄适配 seam。
 * 只转交阶段、ID、工具名、布尔结果与 retry 数值；不转交消息、参数、结果或错误文本以外的内容。
 */
export function recordPiAgentAuditEvent(
  recorder: PiRunAuditRecorder,
  event: AgentSessionEvent,
): Promise<void> {
  switch (event.type) {
    case 'turn_start':
      return recorder.record({ type: 'turn_start' })
    case 'message_update':
      return isAssistantPiMessage(event.message) && isEffectiveAssistantUpdate(event)
        ? recorder.record({ type: 'assistant_update' })
        : Promise.resolve()
    case 'message_end':
      return isAssistantPiMessage(event.message)
        ? recorder.record({ type: 'assistant_end' })
        : Promise.resolve()
    case 'tool_execution_start':
      return recorder.record({
        type: 'tool_execution_start',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      })
    case 'tool_execution_end':
      return recorder.record({
        type: 'tool_execution_end',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        outcome: event.isError ? 'error' : 'success',
      })
    case 'auto_retry_start':
      return recorder.record({
        type: 'retry_scheduled',
        attempt: event.attempt,
        delayMs: event.delayMs,
        errorMessage: event.errorMessage,
      })
    case 'auto_retry_attempt_start':
      return recorder.record({ type: 'retry_attempt_start', attempt: event.attempt })
    case 'auto_retry_end':
      return recorder.record({
        type: 'retry_end',
        attempt: event.attempt,
        outcome: event.outcome,
        errorMessage: event.finalError,
      })
    case 'agent_end':
      return recorder.record({ type: 'agent_end', willRetry: event.willRetry })
    default:
      return Promise.resolve()
  }
}

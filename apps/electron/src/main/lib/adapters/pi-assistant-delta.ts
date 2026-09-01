import type { AgentAssistantDelta, AgentToolCallDelta } from '@domi/shared'
import type { AssistantMessageEvent } from '@earendil-works/pi-ai'
import { displayToolName } from './pi-message-adapter'

function toolCallFromPartial(
  event: Extract<AssistantMessageEvent, { type: 'toolcall_start' | 'toolcall_delta' }>,
): AgentToolCallDelta | undefined {
  const block = event.partial.content[event.contentIndex]
  if (!block || block.type !== 'toolCall') return undefined
  return {
    id: block.id,
    name: displayToolName(block.name, block.arguments as Record<string, unknown>),
    ...(event.type === 'toolcall_start' ? { arguments: {} } : {}),
  }
}

/** 将 Pi 累计 message_update 中的小粒度事件转换为可跨 IPC 传输的增量。 */
export function serializePiAssistantDelta(event: AssistantMessageEvent): AgentAssistantDelta | undefined {
  switch (event.type) {
    case 'start':
      return { type: 'start' }
    case 'text_start':
      return { type: 'text_start', contentIndex: event.contentIndex }
    case 'text_delta':
      return { type: 'text_delta', contentIndex: event.contentIndex, delta: event.delta }
    case 'text_end':
      return { type: 'text_end', contentIndex: event.contentIndex, content: event.content }
    case 'thinking_start':
      return { type: 'thinking_start', contentIndex: event.contentIndex }
    case 'thinking_delta':
      return { type: 'thinking_delta', contentIndex: event.contentIndex, delta: event.delta }
    case 'thinking_end':
      return { type: 'thinking_end', contentIndex: event.contentIndex, content: event.content }
    case 'toolcall_start': {
      const toolCall = toolCallFromPartial(event)
      return { type: 'toolcall_start', contentIndex: event.contentIndex, ...(toolCall ? { toolCall } : {}) }
    }
    case 'toolcall_delta': {
      const toolCall = toolCallFromPartial(event)
      return {
        type: 'toolcall_delta',
        contentIndex: event.contentIndex,
        delta: event.delta,
        ...(toolCall ? { toolCall } : {}),
      }
    }
    case 'toolcall_end':
      return {
        type: 'toolcall_end',
        contentIndex: event.contentIndex,
        toolCall: {
          id: event.toolCall.id,
          name: displayToolName(event.toolCall.name, event.toolCall.arguments as Record<string, unknown>),
          arguments: event.toolCall.arguments as Record<string, unknown>,
        },
      }
    case 'done':
    case 'error':
      return undefined
  }
}

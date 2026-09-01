import type {
  AgentAssistantDelta,
  AgentAssistantDeltaPayload,
  SDKAssistantMessage,
  SDKContentBlock,
  SDKMessage,
} from '@domi/shared'

export function shouldApplyAgentAssistantDelta(
  currentRunStartedAt: number | undefined,
  payloadRunStartedAt: number | undefined,
): boolean {
  return currentRunStartedAt !== undefined && payloadRunStartedAt === currentRunStartedAt
}

export function createAssistantDeltaPreview(
  payload: AgentAssistantDeltaPayload,
  metadata: Partial<SDKAssistantMessage> = {},
): SDKAssistantMessage {
  return {
    type: 'assistant',
    message: { content: [] },
    parent_tool_use_id: null,
    session_id: payload.session_id,
    uuid: payload.uuid,
    _partial: true,
    _createdAt: payload.runStartedAt ?? Date.now(),
    ...(payload.runStartedAt !== undefined ? { _domiLiveRunStartedAt: payload.runStartedAt } : {}),
    ...metadata,
  } as SDKAssistantMessage
}

export function applyAssistantDeltasToPreview(
  message: SDKAssistantMessage,
  deltas: readonly AgentAssistantDelta[],
): SDKAssistantMessage {
  if (deltas.length === 0) return message
  const content = [...message.message.content] as SDKContentBlock[]

  for (const delta of deltas) {
    const index = 'contentIndex' in delta ? delta.contentIndex : undefined
    const ensureBlock = (fallback: SDKContentBlock): number => {
      if (index === undefined) {
        content.push(fallback)
        return content.length - 1
      }
      while (content.length <= index) content.push({ type: 'text', text: '' })
      return index
    }
    const existing = index === undefined ? undefined : content[index]

    switch (delta.type) {
      case 'text_start':
        content[ensureBlock({ type: 'text', text: '' })] = { type: 'text', text: '' }
        break
      case 'text_delta': {
        const blockIndex = ensureBlock({ type: 'text', text: '' })
        const text = existing?.type === 'text' && 'text' in existing && typeof existing.text === 'string'
          ? existing.text
          : ''
        content[blockIndex] = { type: 'text', text: text + delta.delta }
        break
      }
      case 'text_end':
        content[ensureBlock({ type: 'text', text: '' })] = { type: 'text', text: delta.content }
        break
      case 'thinking_start':
        content[ensureBlock({ type: 'thinking', thinking: '' })] = { type: 'thinking', thinking: '' }
        break
      case 'thinking_delta': {
        const blockIndex = ensureBlock({ type: 'thinking', thinking: '' })
        const thinking = existing?.type === 'thinking' && 'thinking' in existing && typeof existing.thinking === 'string'
          ? existing.thinking
          : ''
        content[blockIndex] = { type: 'thinking', thinking: thinking + delta.delta }
        break
      }
      case 'thinking_end':
        content[ensureBlock({ type: 'thinking', thinking: '' })] = { type: 'thinking', thinking: delta.content }
        break
      case 'toolcall_start':
      case 'toolcall_delta':
      case 'toolcall_end': {
        const toolCall = delta.toolCall
        if (!toolCall) break
        const blockIndex = ensureBlock({ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: {} })
        const previous = content[blockIndex]
        content[blockIndex] = {
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.arguments
            ?? (previous?.type === 'tool_use' && 'input' in previous && previous.input && typeof previous.input === 'object'
              ? previous.input as Record<string, unknown>
              : {}),
        }
        break
      }
      case 'start':
        break
    }
  }

  return { ...message, message: { ...message.message, content }, _partial: true } as SDKAssistantMessage
}

export function upsertAgentSDKMessage(
  messages: readonly SDKMessage[],
  incoming: SDKMessage,
): SDKMessage[] {
  const incomingRecord = incoming as Record<string, unknown>
  const incomingUuid = typeof incomingRecord.uuid === 'string' ? incomingRecord.uuid : undefined
  if (!incomingUuid) return [...messages, incoming]

  const existingIndex = messages.findIndex((message) => (message as Record<string, unknown>).uuid === incomingUuid)
  if (existingIndex < 0) return [...messages, incoming]

  const existing = messages[existingIndex] as Record<string, unknown>
  if (incomingRecord._partial !== true && existing._partial !== true) return messages as SDKMessage[]

  const next = [...messages]
  next[existingIndex] = incoming
  return next
}

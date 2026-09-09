import type { SDKMessage, SideChatSendInput } from '@domi/shared'
import type { SideChatDraft } from '@/atoms/side-chat-atoms'
import type { SideChatPendingImage } from './side-chat-images'

/** 未显式选模型时让 Main 从父/侧聊元数据解析，避免全局 UI 选择串入另一会话。 */
export function sideChatSendInput(parentSessionId: string, draft: SideChatDraft, images: readonly SideChatPendingImage[] = []): SideChatSendInput {
  return { parentSessionId, message: draft.text.trim(), ...(draft.model ?? {}), ...(draft.quotedText ? { quotedText: draft.quotedText } : {}),
    ...(images.length ? { images: images.map(({ filename, mediaType, data }) => ({ filename, mediaType, data })) } : {}),
  }
}

export interface SideChatTextMessage { id: string; role: 'user' | 'assistant'; text: string; modelId?: string }
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
/** 只呈现可见正文；thinking、工具结果和系统上下文不作为回答回传。 */
export function sideChatTextMessages(messages: SDKMessage[]): SideChatTextMessage[] {
  return messages.flatMap((message, index) => {
    if (message.type !== 'user' && message.type !== 'assistant') return []
    if (message.parent_tool_use_id || ('isSynthetic' in message && message.isSynthetic)) return []
    const body: unknown = message.message
    if (!isRecord(body) || !Array.isArray(body.content)) return []
    const text = body.content.flatMap((block: unknown) => isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n').trim()
    return text ? [{ id: typeof message.uuid === 'string' ? message.uuid : String(index), role: message.type, text, ...(typeof body.model === 'string' ? { modelId: body.model } : {}) }] : []
  })
}
export function sideChatHandoffPrompt(text: string): string {
  return `请判断以下侧聊建议是否适合当前任务，仅在符合原要求时采纳：\n\n${text.trim()}`
}

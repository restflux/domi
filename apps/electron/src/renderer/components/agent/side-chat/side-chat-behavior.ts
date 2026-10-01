import type { SideChatSendInput } from '@domi/shared'
import type { SideChatDraft } from '@/atoms/side-chat-atoms'
import type { SideChatPendingImage } from './side-chat-images'

/** 未显式选模型时让 Main 从父/侧聊元数据解析，避免全局 UI 选择串入另一会话。 */
export function sideChatSendInput(parentSessionId: string, childSessionId: string, draft: SideChatDraft, images: readonly SideChatPendingImage[] = []): SideChatSendInput {
  return { parentSessionId, childSessionId, message: draft.text.trim(), ...(draft.model ?? {}),
    ...(images.length ? { images: images.map(({ filename, mediaType, data }) => ({ filename, mediaType, data })) } : {}),
  }
}

/** 侧聊内回复交给主助手处理时的提示词包装。 */
export function sideChatHandoffPrompt(text: string): string {
  return `请判断以下侧聊建议是否适合当前任务，仅在符合原要求时采纳：\n\n${text.trim()}`
}

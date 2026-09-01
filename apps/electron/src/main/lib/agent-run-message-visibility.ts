import type { SDKAssistantMessage, SDKMessage, SDKSystemMessage } from '@domi/shared'
import { isPersistableSDKSystemMessage } from '@domi/shared'

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/** 判断消息是否需要进入本轮可见消息流；这不等同于任务已经产出可交付结果。 */
export function isVisibleRunMessage(message: SDKMessage): boolean {
  const msgRecord = message as Record<string, unknown>
  if (msgRecord.isReplay) return false

  if (message.type === 'assistant') {
    const assistantMsg = message as SDKAssistantMessage
    if (assistantMsg.error) return true
    const content = assistantMsg.message?.content
    if (!Array.isArray(content)) return false
    return content.some((block) => {
      if (block.type === 'text') return isNonEmptyString((block as { text?: unknown }).text)
      // thinking 只属于折叠执行过程，不能单独充当本轮面向用户的最终回复。
      if (block.type === 'thinking') return false
      if (block.type === 'tool_use') return true
      return Object.keys(block).length > 1
    })
  }

  if (message.type === 'user') {
    const content = (message as { message?: { content?: Array<{ type: string }> } }).message?.content
    return Array.isArray(content) && content.some((block) => block.type === 'tool_result')
  }

  if (message.type === 'system') {
    const systemMessage = message as SDKSystemMessage
    return isPersistableSDKSystemMessage(systemMessage)
      || systemMessage.subtype === 'task_started'
      || systemMessage.subtype === 'task_progress'
      || systemMessage.subtype === 'task_notification'
  }

  return false
}

/**
 * 判断消息是否构成当前任务的真实用户输出。
 *
 * 自动压缩、任务进度和其他 system 控制状态可以展示或持久化，但不能单独证明
 * Agent 已经响应了用户。显式 `/compact` 由 orchestrator 的控制命令语义单独放行。
 */
export function isUserFacingRunOutput(message: SDKMessage): boolean {
  const msgRecord = message as Record<string, unknown>
  if (msgRecord.isReplay) return false

  if (message.type === 'assistant') {
    const assistantMsg = message as SDKAssistantMessage
    // assistant.error 有自己的失败收束路径；重试中的内部错误不能掩盖后续空回复。
    if (assistantMsg.error) return false
    const content = assistantMsg.message?.content
    if (!Array.isArray(content)) return false
    return content.some((block) => {
      if (block.type === 'text') return isNonEmptyString((block as { text?: unknown }).text)
      if (block.type === 'tool_use') return true
      return false
    })
  }

  if (message.type === 'user') {
    const content = (message as { message?: { content?: Array<{ type: string }> } }).message?.content
    return Array.isArray(content) && content.some((block) => block.type === 'tool_result')
  }

  return false
}

export function shouldFailRunForEmptyResponse(options: {
  wasStoppedByUser: boolean
  explicitCompactRequest: boolean
  userFacingOutputCount: number
}): boolean {
  return !options.wasStoppedByUser
    && !options.explicitCompactRequest
    && options.userFacingOutputCount === 0
}

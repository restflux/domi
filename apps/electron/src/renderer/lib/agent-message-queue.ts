import type {
  AgentNextTurnAside,
  AgentQueueMessageKind,
  AgentSubmitOrEnqueueResult,
} from '@domi/shared'
import type { QuotedSelection } from '@/atoms/preview-atoms'

export type QueueDropPlacement = 'before' | 'after'

/** Renderer-only queue kind; `aside` is a local annotation sent with the next message. */
export type AgentQueuedMessageKind = AgentQueueMessageKind | 'aside'

export type AgentNativeQueuedMessage = AgentQueuedMessage & { kind: AgentQueueMessageKind }
export type AgentAsideQueuedMessage = AgentQueuedMessage & { kind: 'aside' }

export interface AgentQueuedAttachment {
  filename: string
  mediaType: string
  size: number
  targetPath: string
}

export interface AgentQueuedMessage {
  id: string
  text: string
  createdAt: number
  kind: AgentQueuedMessageKind
  /** native 由 Pi queue 承载；deferred 由 main 在当前 run 结束后启动。 */
  delivery?: 'native' | 'deferred'
  quotedSelection?: QuotedSelection
  fileReferenceBlock?: string
  attachments?: AgentQueuedAttachment[]
  additionalDirectories?: string[]
  /** 已绑定到这条 steering/follow-up 的附言；用于 native clear+replay 保持上下文。 */
  nextTurnAsides?: AgentNextTurnAside[]
}

export function createAgentQueuedMessage(
  text: string,
  id: string,
  createdAt: number,
  quotedSelection?: QuotedSelection | null,
  options?: {
    fileReferenceBlock?: string
    attachments?: AgentQueuedAttachment[]
    additionalDirectories?: string[]
    nextTurnAsides?: AgentNextTurnAside[]
    kind?: AgentQueuedMessageKind
  },
): AgentQueuedMessage {
  const message: AgentQueuedMessage = {
    id,
    text: text.trim(),
    createdAt,
    kind: options?.kind ?? 'steering',
  }
  if (quotedSelection) message.quotedSelection = quotedSelection
  if (options?.fileReferenceBlock) message.fileReferenceBlock = options.fileReferenceBlock
  if (options?.attachments && options.attachments.length > 0) message.attachments = options.attachments
  if (options?.additionalDirectories && options.additionalDirectories.length > 0) message.additionalDirectories = options.additionalDirectories
  if (options?.nextTurnAsides && options.nextTurnAsides.length > 0) message.nextTurnAsides = options.nextTurnAsides
  return message
}

function isNativeQueuedMessage(message: AgentQueuedMessage): message is AgentNativeQueuedMessage {
  return message.delivery !== 'deferred'
    && (message.kind === 'steering' || message.kind === 'followUp')
}

/** Extract the messages that can be sent to the SDK native queue. */
export function getNativeQueuedMessages(queue: readonly AgentQueuedMessage[]): AgentNativeQueuedMessage[] {
  return queue.filter(isNativeQueuedMessage)
}

/** 队列卡片展示所有尚未由 Pi 消费的原生消息。 */
export function getVisibleQueuedMessages(queue: readonly AgentQueuedMessage[]): AgentNativeQueuedMessage[] {
  return queue.filter((message): message is AgentNativeQueuedMessage => message.delivery !== 'deferred')
}

/** Extract renderer-only asides; these are not SDK queue records. */
export function getAsideQueuedMessages(queue: readonly AgentQueuedMessage[]): AgentAsideQueuedMessage[] {
  return queue.filter((message): message is AgentAsideQueuedMessage => message.kind === 'aside')
}

export function reconcileSubmittedQueuedMessage(
  queue: readonly AgentQueuedMessage[],
  message: AgentQueuedMessage,
  result: AgentSubmitOrEnqueueResult,
): AgentQueuedMessage[] {
  if (result.disposition === 'injected') return [...queue]
  if (result.queueState === 'started') return removeQueuedMessage(queue, message.id)
  const deferredMessage: AgentQueuedMessage = { ...message, delivery: 'deferred' }
  return queue.some((item) => item.id === message.id)
    ? queue.map((item) => item.id === message.id ? deferredMessage : item)
    : orderQueuedMessagesForDelivery([...queue, deferredMessage])
}

/** 只有运行中或后台等待态仍存在可修改的 Pi 原生队列。 */
export function hasActiveNativeMessageQueue(
  running: boolean,
  backgroundWaiting: boolean,
): boolean {
  return running || backgroundWaiting
}

export function orderQueuedMessagesForDelivery(queue: readonly AgentQueuedMessage[]): AgentQueuedMessage[] {
  return [
    ...queue.filter((item) => item.kind === 'steering'),
    ...queue.filter((item) => item.kind === 'followUp'),
    ...queue.filter((item) => item.kind === 'aside'),
  ]
}

export function resolveClearedQueuedMessages(
  latestQueue: readonly AgentQueuedMessage[],
  clearedRecords: readonly { uuid: string; kind: AgentQueueMessageKind; rawUserMessage: string }[],
  fallbackCreatedAt = Date.now(),
): AgentNativeQueuedMessage[] {
  const byId = new Map(latestQueue.map((message) => [message.id, message]))
  return clearedRecords.map((record) => {
    const existing = byId.get(record.uuid)
    return existing && isNativeQueuedMessage(existing)
      ? existing
      : createAgentQueuedMessage(record.rawUserMessage, record.uuid, fallbackCreatedAt, null, { kind: record.kind }) as AgentNativeQueuedMessage
  })
}

/** Restore failed asides once, then normalize to native → aside group order. */
export function restoreFailedAsideMessages(
  queue: readonly AgentQueuedMessage[],
  failedAsides: readonly AgentAsideQueuedMessage[],
): AgentQueuedMessage[] {
  const existingIds = new Set(queue.map((message) => message.id))
  const restored = [...queue]
  for (const message of failedAsides) {
    if (existingIds.has(message.id)) continue
    existingIds.add(message.id)
    restored.push(message)
  }
  return orderQueuedMessagesForDelivery(restored)
}

export function mergeRestoredQueuedMessagesIntoDraft(
  draft: string,
  messages: readonly AgentQueuedMessage[],
): string {
  const restoredText = messages.map((message) => message.text).filter(Boolean).join('\n\n')
  if (!restoredText) return draft
  return draft.trim().length > 0 ? `${draft.trimEnd()}\n\n${restoredText}` : restoredText
}

export function getMostRecentQueuedMessage(queue: readonly AgentQueuedMessage[]): AgentQueuedMessage | undefined {
  return queue.reduce<AgentQueuedMessage | undefined>((latest, item) => (
    !latest || item.createdAt >= latest.createdAt ? item : latest
  ), undefined)
}

export function changeQueuedMessageKind(
  queue: AgentQueuedMessage[],
  messageId: string,
  kind: AgentQueueMessageKind,
): AgentQueuedMessage[] {
  const message = queue.find((item) => item.id === messageId)
  if (!message || message.kind === 'aside' || message.kind === kind) return queue
  return orderQueuedMessagesForDelivery(
    queue.map((item) => item.id === messageId ? { ...item, kind } : item),
  )
}

export function removeQueuedMessage(
  queue: readonly AgentQueuedMessage[],
  messageId: string,
): AgentQueuedMessage[] {
  return queue.filter((item) => item.id !== messageId)
}

export function restoreQueuedMessageToFront(
  queue: AgentQueuedMessage[],
  message: AgentQueuedMessage,
): AgentQueuedMessage[] {
  if (queue.some((item) => item.id === message.id)) return queue
  return [message, ...queue]
}

export function moveQueuedMessage(
  queue: AgentQueuedMessage[],
  sourceId: string,
  targetId: string,
  placement: QueueDropPlacement,
): AgentQueuedMessage[] {
  if (sourceId === targetId) return queue

  const source = queue.find((item) => item.id === sourceId)
  if (!source) return queue

  const withoutSource = queue.filter((item) => item.id !== sourceId)
  const targetIndex = withoutSource.findIndex((item) => item.id === targetId)
  if (targetIndex === -1) return queue

  const insertIndex = placement === 'after' ? targetIndex + 1 : targetIndex
  return orderQueuedMessagesForDelivery([
    ...withoutSource.slice(0, insertIndex),
    source,
    ...withoutSource.slice(insertIndex),
  ])
}

export interface ParsedQueuedMessageMentions {
  cleanedText: string
  mentionedSkills: string[]
  mentionedMcpServers: string[]
  mentionedSessionIds: string[]
  mentionedTodoIds: string[]
  mentionedCalendarEventIds: string[]
}

export interface QueuedMessageSendPayload {
  rawText: string
  sdkText: string
  mentions: ParsedQueuedMessageMentions
}

/** 队列预览专用片段：保留原始消息用于发送，同时把引用协议渲染为可读芯片。 */
export type QueuedMessageReferenceType = 'file' | 'skill' | 'mcp' | 'session' | 'todo' | 'calendar_event'

export type QueuedMessageDisplayPart =
  | { type: 'text'; value: string }
  | {
      type: 'reference'
      referenceType: QueuedMessageReferenceType
      id: string
      label: string
    }

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 把纯文本队列消息转成与 RichTextInput 段落渲染一致的 HTML：
 * 双换行分段落，单换行转 <br>，并转义 HTML 特殊字符避免破坏结构。
 * 用于撤回时保留已有草稿的富文本节点（mention 等），同时让队列文本按正常段落显示。
 */
export function queuedTextToParagraphHtml(text: string): string {
  const normalized = text.trim()
  if (!normalized) return ''
  return normalized
    .split(/\n\n+/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('')
}


const REF_PATTERN = /\/skill:(?<skill>\S+)|#mcp:(?<mcp>\S+)|&session:(?<session>[A-Za-z0-9-]+)(?:(?:~|::)\S+)?|&todo:(?<todo>[A-Za-z0-9-]+)(?:(?:~|::)\S+)?|&calendar_event:(?<calendarEvent>[A-Za-z0-9-]+)(?:(?:~|::)\S+)?/g
const DISPLAY_REFERENCE_PATTERN = /@file:(?<file>\S+)|\/skill:(?<skill>\S+)|#mcp:(?<mcp>\S+)|&session:(?<session>[A-Za-z0-9-]+)(?:(?:~|::)(?<sessionLabel>\S+))?|&todo:(?<todo>[A-Za-z0-9-]+)(?:(?:~|::)(?<todoLabel>\S+))?|&calendar_event:(?<calendarEvent>[A-Za-z0-9-]+)(?:(?:~|::)(?<calendarEventLabel>\S+))?/g

function decodeReferenceLabel(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * 将排队消息中的文件、Skill、MCP、会话和规划协议转换为展示片段。
 * `item.text` 仍完整保留，发送时继续通过 parseQueuedMessageMentions 提取原始 ID。
 */
export function getQueuedMessageDisplayParts(text: string): QueuedMessageDisplayPart[] {
  const parts: QueuedMessageDisplayPart[] = []
  let lastIndex = 0

  for (const match of text.matchAll(DISPLAY_REFERENCE_PATTERN)) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) })
    }

    const groups = match.groups ?? {}
    let referenceType: QueuedMessageReferenceType
    let id: string
    let rawLabel: string | undefined

    if (groups.file) {
      referenceType = 'file'
      id = groups.file
    } else if (groups.skill) {
      referenceType = 'skill'
      id = groups.skill
    } else if (groups.mcp) {
      referenceType = 'mcp'
      id = groups.mcp
    } else if (groups.session) {
      referenceType = 'session'
      id = groups.session
      rawLabel = groups.sessionLabel
    } else if (groups.todo) {
      referenceType = 'todo'
      id = groups.todo
      rawLabel = groups.todoLabel
    } else if (groups.calendarEvent) {
      referenceType = 'calendar_event'
      id = groups.calendarEvent
      rawLabel = groups.calendarEventLabel
    } else {
      continue
    }

    const decodedId = decodeReferenceLabel(id)
    const label = rawLabel
      ? decodeReferenceLabel(rawLabel)
      : referenceType === 'file'
        ? (decodedId.split(/[\\/]/).pop() || decodedId)
        : referenceType === 'session'
          ? `会话 ${id.slice(0, 8)}`
          : referenceType === 'todo'
            ? `Todo ${id.slice(0, 8)}`
            : referenceType === 'calendar_event'
              ? `日程 ${id.slice(0, 8)}`
              : decodedId

    parts.push({ type: 'reference', referenceType, id, label })
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) })
  }

  return parts.length > 0 ? parts : [{ type: 'text', value: text }]
}

export function parseQueuedMessageMentions(text: string): ParsedQueuedMessageMentions {
  const mentionedSkills: string[] = []
  const mentionedMcpServers: string[] = []
  const mentionedSessionIds: string[] = []
  const mentionedTodoIds: string[] = []
  const mentionedCalendarEventIds: string[] = []

  for (const match of text.matchAll(REF_PATTERN)) {
    const { skill, mcp, session, todo, calendarEvent } = match.groups ?? {}
    if (skill) mentionedSkills.push(skill)
    else if (mcp) mentionedMcpServers.push(mcp)
    else if (session) mentionedSessionIds.push(session)
    else if (todo) mentionedTodoIds.push(todo)
    else if (calendarEvent) mentionedCalendarEventIds.push(calendarEvent)
  }

  return {
    cleanedText: text.replace(REF_PATTERN, '').trim(),
    mentionedSkills,
    mentionedMcpServers,
    mentionedSessionIds,
    mentionedTodoIds,
    mentionedCalendarEventIds,
  }
}

export function buildQueuedMessageSendPayload(
  message: AgentQueuedMessage,
  quotedSelectionBlock = '',
): QueuedMessageSendPayload {
  const text = message.text.trim()
  const mentions = parseQueuedMessageMentions(text)
  const contextBlocks = [
    message.fileReferenceBlock?.trim(),
    quotedSelectionBlock.trim(),
  ].filter((block): block is string => Boolean(block))
  const prefix = contextBlocks.length > 0
    ? `${contextBlocks.join('\n\n')}\n\n`
    : ''

  return {
    rawText: `${prefix}${text}`.trim(),
    sdkText: `${prefix}${mentions.cleanedText}`.trim(),
    mentions,
  }
}

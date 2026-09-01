import type { SDKMessage, SDKUserMessage } from '@domi/shared'

export interface RecoverablePiContentBlock {
  type?: string
  text?: string
}

export interface RecoverablePiSessionEntry {
  type: string
  id: string
  parentId: string | null
  timestamp?: string
  message?: {
    role?: string
    content?: string | RecoverablePiContentBlock[]
  }
}

function piContentText(content: string | RecoverablePiContentBlock[] | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

const LEADING_INJECTED_CONTEXT_PATTERN = /^\s*<(conversation_history|referenced_sessions|mentioned_tools|planning_reference_instructions|domi_next_turn_asides)>[\s\S]*?<\/\1>\s*/
const PI_INTERNAL_CONTINUATION_PATTERN = /^\s*<(proma_compaction_continuation|domi_compaction_continuation|domi_incomplete_turn_continuation)>[\s\S]*?<\/\1>\s*$/

/** 识别旧 runtime 曾错误持久化成 user message 的内部续跑协议。 */
export function isPiInternalContinuationText(rawText: string): boolean {
  return PI_INTERNAL_CONTINUATION_PATTERN.test(rawText)
}

/** 只移除 Domi 注入的运行时背景，保留用户正文、附件和引用协议。 */
export function stripPiInjectedUserContext(rawText: string): string {
  let text = rawText
    .replace(/^\*\*当前时间:[^\n]*\*\*\s*/gmu, '')
    .replace(/<workspace_state>[\s\S]*?<\/workspace_state>/g, '')
    .replace(/<working_directory>[\s\S]*?<\/working_directory>/g, '')
  let previous = ''
  while (text !== previous) {
    previous = text
    text = text.replace(LEADING_INJECTED_CONTEXT_PATTERN, '')
  }
  return text.trim()
}

function isHumanSDKUserMessage(message: SDKMessage): boolean {
  if (message.type !== 'user') return false
  const user = message as SDKUserMessage
  if (user.parent_tool_use_id || user.isSynthetic) return false
  const content = user.message?.content
  if (!Array.isArray(content) || content.some((block) => block.type === 'tool_result')) return false
  return content.some((block) => block.type === 'text' && 'text' in block && typeof block.text === 'string')
}

function assistantBinding(message: SDKMessage, bindings: Record<string, string>): string | undefined {
  if (message.type !== 'assistant') return undefined
  const uuid = (message as { uuid?: unknown }).uuid
  return typeof uuid === 'string' ? bindings[uuid] : undefined
}

function entriesBetween(
  byId: ReadonlyMap<string, RecoverablePiSessionEntry>,
  previousAssistantEntryId: string,
  currentAssistantEntryId: string,
): RecoverablePiSessionEntry[] {
  const reversed: RecoverablePiSessionEntry[] = []
  const visited = new Set<string>()
  let current = byId.get(currentAssistantEntryId)
  let parentId = current?.parentId ?? null
  while (parentId && parentId !== previousAssistantEntryId && !visited.has(parentId)) {
    visited.add(parentId)
    current = byId.get(parentId)
    if (!current) return []
    reversed.push(current)
    parentId = current.parentId
  }
  if (parentId !== previousAssistantEntryId) return []
  return reversed.reverse()
}

function createRecoveredUserMessage(entry: RecoverablePiSessionEntry, text: string): SDKMessage {
  const createdAt = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN
  return {
    type: 'user',
    uuid: `pi-recovered-user:${entry.id}`,
    message: { content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    ...(Number.isFinite(createdAt) ? { _createdAt: createdAt } : {}),
    _recoveredFromPiTranscript: true,
    _recoveredPiEntryId: entry.id,
  } as unknown as SDKMessage
}

function entriesAfterAncestor(
  byId: ReadonlyMap<string, RecoverablePiSessionEntry>,
  ancestorEntryId: string,
  activeLeafId: string | null,
): RecoverablePiSessionEntry[] {
  if (!activeLeafId || activeLeafId === ancestorEntryId) return []

  const reversed: RecoverablePiSessionEntry[] = []
  const visited = new Set<string>()
  let currentId: string | null = activeLeafId
  while (currentId && currentId !== ancestorEntryId && !visited.has(currentId)) {
    visited.add(currentId)
    const current = byId.get(currentId)
    if (!current) return []
    reversed.push(current)
    currentId = current.parentId
  }
  if (currentId !== ancestorEntryId) return []
  return reversed.reverse()
}

function recoverUserEntries(entries: readonly RecoverablePiSessionEntry[]): SDKMessage[] {
  return entries.flatMap((entry) => {
    if (entry.type !== 'message' || entry.message?.role !== 'user') return []
    const text = stripPiInjectedUserContext(piContentText(entry.message.content))
    if (!text || isPiInternalContinuationText(text)) return []
    return [createRecoveredUserMessage(entry, text)]
  })
}

/**
 * 旧版 queue_update 偶发漏记已送达 user turn。Pi transcript 仍是完整树，因此可在读取时
 * 只读补回缺失的人类 user entry，不改写历史 JSONL。除两个已绑定 assistant 之间的缺口外，
 * 还要补回活跃路径尾部正在执行、尚未产生 assistant binding 的最新用户消息。
 */
export function recoverMissingPiUserTurns(
  messages: readonly SDKMessage[],
  entries: readonly RecoverablePiSessionEntry[],
  bindings: Record<string, string> | undefined,
  activeLeafId: string | null = entries.at(-1)?.id ?? null,
): SDKMessage[] {
  if (!bindings || Object.keys(bindings).length === 0 || entries.length === 0) return [...messages]

  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const recovered: SDKMessage[] = []
  let previousAssistantEntryId: string | undefined
  let hasHumanUserBoundary = false

  for (const message of messages) {
    if (isHumanSDKUserMessage(message)) hasHumanUserBoundary = true

    const currentAssistantEntryId = assistantBinding(message, bindings)
    if (currentAssistantEntryId && previousAssistantEntryId && !hasHumanUserBoundary) {
      recovered.push(...recoverUserEntries(entriesBetween(byId, previousAssistantEntryId, currentAssistantEntryId)))
    }

    recovered.push(message)
    if (currentAssistantEntryId) {
      previousAssistantEntryId = currentAssistantEntryId
      hasHumanUserBoundary = false
    }
  }

  if (previousAssistantEntryId && !hasHumanUserBoundary) {
    recovered.push(...recoverUserEntries(entriesAfterAncestor(byId, previousAssistantEntryId, activeLeafId)))
  }

  return recovered
}

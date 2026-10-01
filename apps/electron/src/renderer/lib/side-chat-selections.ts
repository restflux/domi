/**
 * side-chat-selections — 侧聊对话选区引用（行为移植自 ZCode conversationSelectionReference）
 *
 * 主对话中划选的文本作为「引用」进入侧聊：按父会话隔离暂存、多引、去重、限流。
 * 序列化复用 Domi 既有的 <quoted_context> 合同（buildQuotedSelectionBlock），
 * 时间线由共享的 UserInputMessage 解析回引用 chip，不把原始标记展示给用户。
 * 与宿主的边界：这是渲染层展示合同，主进程仍按普通文本接收。
 */

import type { QuotedSelection } from '@/atoms/preview-atoms'
import { buildQuotedSelectionBlock } from './quoted-selection'

export const SIDE_CHAT_SELECTION_MAX_TEXT_LENGTH = 8_000
const SIDE_CHAT_SELECTION_MAX_COUNT = 8
const SIDE_CHAT_SELECTION_MAX_TOTAL_LENGTH = 16_000

export type SideChatSelectionLimitReason = 'single' | 'count' | 'total'

export interface SideChatSelectionAppendResult {
  ok: boolean
  reason?: SideChatSelectionLimitReason
  duplicate?: boolean
}

/** 引用条目即 QuotedSelection；侧聊入口复用主输入的来源元数据。 */
export type SideChatSelectionEntry = QuotedSelection & { id: string; capturedAt: number }

const selectionsByScope = new Map<string, SideChatSelectionEntry[]>()
const limitReasonByScope = new Map<string, SideChatSelectionLimitReason>()
const listeners = new Set<() => void>()

/** 侧聊引用按父会话隔离；面板是唯一消费者，不区分目标子会话。 */
export function sideChatSelectionScopeKey(parentSessionId: string): string {
  return `side-chat:${parentSessionId}`
}

function emitChange(): void {
  for (const listener of listeners) listener()
}

export function subscribeSideChatSelections(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getSideChatSelections(parentSessionId: string): readonly SideChatSelectionEntry[] {
  return selectionsByScope.get(sideChatSelectionScopeKey(parentSessionId)) ?? []
}

export function getSideChatSelectionLimitReason(parentSessionId: string): SideChatSelectionLimitReason | null {
  return limitReasonByScope.get(sideChatSelectionScopeKey(parentSessionId)) ?? null
}

export function clearSideChatSelectionLimitReason(parentSessionId: string): void {
  limitReasonByScope.delete(sideChatSelectionScopeKey(parentSessionId))
  emitChange()
}

function selectionDedupeKey(entry: SideChatSelectionEntry): string {
  return [entry.messageId ?? '', entry.messageRole ?? '', entry.sourceLabel ?? '', entry.text].join('\0')
}

function createEntry(selection: QuotedSelection): SideChatSelectionEntry {
  return { ...selection, id: createSelectionId(), capturedAt: Date.now() }
}

function createSelectionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `sel-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function appendSelection(
  current: readonly SideChatSelectionEntry[],
  entry: SideChatSelectionEntry,
): SideChatSelectionAppendResult & { references: readonly SideChatSelectionEntry[] } {
  if (entry.text.length > SIDE_CHAT_SELECTION_MAX_TEXT_LENGTH) {
    return { ok: false, reason: 'single', references: current }
  }
  const key = selectionDedupeKey(entry)
  if (current.some(item => selectionDedupeKey(item) === key)) {
    return { ok: true, duplicate: true, references: current }
  }
  if (current.length >= SIDE_CHAT_SELECTION_MAX_COUNT) {
    return { ok: false, reason: 'count', references: current }
  }
  const totalLength = current.reduce((sum, item) => sum + item.text.length, 0) + entry.text.length
  if (totalLength > SIDE_CHAT_SELECTION_MAX_TOTAL_LENGTH) {
    return { ok: false, reason: 'total', references: current }
  }
  return { ok: true, duplicate: false, references: [...current, entry] }
}

/** 划选入口的统一添加路径；超限时保留 scope 原状并记录原因供 UI 提示。 */
export function addSideChatSelection(parentSessionId: string, selection: QuotedSelection): SideChatSelectionAppendResult {
  const scope = sideChatSelectionScopeKey(parentSessionId)
  const current = selectionsByScope.get(scope) ?? []
  const result = appendSelection(current, createEntry(selection))
  if (result.ok) {
    selectionsByScope.set(scope, [...result.references])
    limitReasonByScope.delete(scope)
  } else {
    limitReasonByScope.set(scope, result.reason ?? 'single')
  }
  emitChange()
  return result
}

export function removeSideChatSelection(parentSessionId: string, id: string): void {
  const scope = sideChatSelectionScopeKey(parentSessionId)
  const current = selectionsByScope.get(scope) ?? []
  const next = current.filter(item => item.id !== id)
  if (next.length === current.length) return
  selectionsByScope.set(scope, next)
  limitReasonByScope.delete(scope)
  emitChange()
}

export function clearSideChatSelections(parentSessionId: string): void {
  const scope = sideChatSelectionScopeKey(parentSessionId)
  if (!selectionsByScope.has(scope) && !limitReasonByScope.has(scope)) return
  selectionsByScope.delete(scope)
  limitReasonByScope.delete(scope)
  emitChange()
}

/** 发送序列化：正文在前，引用块收尾；chip 解析由共享 UserInputMessage 完成。 */
export function buildPromptWithSideChatSelections(
  visibleContent: string,
  selections: readonly QuotedSelection[],
): string {
  if (selections.length === 0) return visibleContent
  const block = selections.map(selection => buildQuotedSelectionBlock(selection)).join('')
  return visibleContent ? `${visibleContent}\n\n${block}` : block.trimEnd()
}

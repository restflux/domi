import { existsSync, readFileSync, statSync } from 'node:fs'
import type { SDKMessage, SDKUserMessage, SessionTreeNode, SessionTreeResult } from '@domi/shared'
import { extractMeta, extractUserText, getGroupPreview, groupIntoTurns } from '@domi/session-core'
import { isAgentCompactCommand } from './agent-compact-command'
import {
  isPiInternalContinuationText,
  recoverMissingPiUserTurns,
  stripPiInjectedUserContext,
} from './agent-queued-turn-recovery'

interface PiContentBlock {
  type?: string
  text?: string
}

export interface PiSessionEntry {
  type: string
  id: string
  parentId: string | null
  timestamp?: string
  customType?: string
  display?: boolean
  message?: {
    role?: string
    content?: string | PiContentBlock[]
  }
  content?: string | PiContentBlock[]
}

interface PiSessionEntriesCacheEntry {
  size: number
  mtimeMs: number
  ctimeMs: number
  entries: PiSessionEntry[]
}

// AgentView 会在消息刷新后重新获取分支数，面板自身也会按需刷新。
// Pi JSONL 只追加，因此用文件指纹缓存解析结果，避免大会话在未变化时反复同步解析。
const piSessionEntriesCache = new Map<string, PiSessionEntriesCacheEntry>()
const MAX_PI_SESSION_CACHE_ENTRIES = 64

function contentText(content: string | PiContentBlock[] | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function summarizeText(text: string, fallback: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback
  return normalized.length > 60 ? `${normalized.slice(0, 60)}…` : normalized
}

/** 检测消息是否包含图片块，用于纯图片消息的摘要占位。 */
function hasImageBlock(entry: PiSessionEntry): boolean {
  const content = entry.message?.content
  return Array.isArray(content) && content.some((block) => block?.type === 'image')
}

const IMAGE_FILENAME_REGEX = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i

/**
 * 生成用户消息的树摘要。
 * Agent 模式下图片/文件会以 <attached_files> 文本引用块拼入消息，长路径会挤占摘要，
 * 这里剥离引用块并以 [图片] / [附件] 前缀标识，保留用户实际输入的正文。
 */
function summarizeUserText(entry: PiSessionEntry, rawText: string): string {
  const visibleText = stripPiInjectedUserContext(rawText)
  const attachmentMatch = visibleText.match(/<attached_files>\n?([\s\S]*?)\n?<\/attached_files>/)
  const attachmentNames = attachmentMatch
    ? attachmentMatch[1]!.split('\n')
        .map((line) => line.match(/^-\s+(.+?):\s+.+$/)?.[1]?.trim())
        .filter((name): name is string => !!name)
    : []
  const attachmentLabel = attachmentNames.length > 0
    ? (attachmentNames.every((name) => IMAGE_FILENAME_REGEX.test(name)) ? '[图片]' : '[附件]')
    : null
  const body = visibleText
    .replace(/<attached_files>[\s\S]*?<\/attached_files>/g, ' ')
    .replace(/<quoted_file>[\s\S]*?<\/quoted_file>/g, ' ')
    .replace(/<quoted_context>[\s\S]*?<\/quoted_context>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (body) return summarizeText(attachmentLabel ? `${attachmentLabel} ${body}` : body, '用户消息')
  return attachmentLabel ?? (hasImageBlock(entry) ? '[图片]' : '用户消息')
}

const PI_INTERNAL_CONTINUATION_CUSTOM_TYPES = new Set([
  'domi_auto_compaction_continuation',
  'domi_incomplete_turn_continuation',
])

function isPiInternalContinuationEntry(entry: PiSessionEntry): boolean {
  return entry.type === 'custom_message'
    && entry.display === false
    && typeof entry.customType === 'string'
    && PI_INTERNAL_CONTINUATION_CUSTOM_TYPES.has(entry.customType)
}

function visibleRole(entry: PiSessionEntry): SessionTreeNode['role'] | null {
  if (entry.type !== 'message') return null
  if (entry.message?.role === 'user') {
    return isPiInternalContinuationText(contentText(entry.message.content)) ? null : 'user'
  }
  if (entry.message?.role === 'assistant') return 'assistant'
  return null
}

function toolCount(entry: PiSessionEntry): number {
  if (entry.type !== 'message' || entry.message?.role !== 'assistant' || !Array.isArray(entry.message.content)) return 0
  return entry.message.content.filter((block) => {
    const type = block?.type?.toLowerCase()
    return type === 'toolcall' || type === 'tool_call' || type === 'tooluse' || type === 'tool_use'
  }).length
}

export function readPiSessionEntries(sessionFile: string): PiSessionEntry[] {
  if (!sessionFile || !existsSync(sessionFile)) {
    if (sessionFile) piSessionEntriesCache.delete(sessionFile)
    return []
  }
  const stat = statSync(sessionFile)
  const cached = piSessionEntriesCache.get(sessionFile)
  if (
    cached
    && cached.size === stat.size
    && cached.mtimeMs === stat.mtimeMs
    && cached.ctimeMs === stat.ctimeMs
  ) {
    return cached.entries
  }

  const entries: PiSessionEntry[] = []
  const lines = readFileSync(sessionFile, 'utf-8').split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as Partial<PiSessionEntry>
      if (value.type === 'session') continue
      if (typeof value.id !== 'string' || typeof value.type !== 'string') continue
      entries.push({
        ...value,
        type: value.type,
        id: value.id,
        parentId: typeof value.parentId === 'string' ? value.parentId : null,
      } as PiSessionEntry)
    } catch {
      // 与会话消息读取保持一致：单行损坏不应让整棵树不可用。
    }
  }
  piSessionEntriesCache.delete(sessionFile)
  piSessionEntriesCache.set(sessionFile, {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    entries,
  })
  if (piSessionEntriesCache.size > MAX_PI_SESSION_CACHE_ENTRIES) {
    const oldestSessionFile = piSessionEntriesCache.keys().next().value
    if (oldestSessionFile) piSessionEntriesCache.delete(oldestSessionFile)
  }
  return entries
}

export function resolveNavigationTarget(
  entries: PiSessionEntry[],
  entryId: string,
): { editorText?: string; activeLeafId: string | null } {
  const entry = entries.find((item) => item.id === entryId)
  if (!entry) throw new Error(`Pi session entry 不存在: ${entryId}`)

  if (entry.type === 'message' && entry.message?.role === 'user') {
    const editorText = stripPiInjectedUserContext(contentText(entry.message.content))
    return isPiInternalContinuationText(editorText)
      ? { activeLeafId: entry.parentId }
      : { editorText, activeLeafId: entry.parentId }
  }
  if (entry.type === 'custom_message') {
    return entry.display === false
      ? { activeLeafId: entry.parentId }
      : { editorText: contentText(entry.content), activeLeafId: entry.parentId }
  }
  return { activeLeafId: entry.id }
}

function getActivePathIds(entries: PiSessionEntry[], activeLeafId: string | null): Set<string> {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const path = new Set<string>()
  let currentId: string | null = activeLeafId
  while (currentId) {
    if (path.has(currentId)) break
    path.add(currentId)
    currentId = byId.get(currentId)?.parentId ?? null
  }
  return path
}

export function buildSessionTree(
  entries: PiSessionEntry[],
  activeLeafOverride?: string | null,
  rawUserTexts?: string[],
): SessionTreeResult {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const rawActiveLeafId = activeLeafOverride !== undefined
    ? activeLeafOverride
    : entries.at(-1)?.id ?? null
  const activePath = getActivePathIds(entries, rawActiveLeafId)
  const childrenByParent = new Map<string | null, PiSessionEntry[]>()
  for (const entry of entries) {
    const children = childrenByParent.get(entry.parentId) ?? []
    children.push(entry)
    childrenByParent.set(entry.parentId, children)
  }
  const hasAssistantBeforeNextUser = (entry: PiSessionEntry): boolean => {
    const stack = [...(childrenByParent.get(entry.id) ?? [])]
    const visited = new Set<string>()
    while (stack.length > 0) {
      const child = stack.pop()!
      if (visited.has(child.id)) continue
      visited.add(child.id)
      // 隐藏的内部 continuation 仍是 turn 边界；不能穿过它把压缩前后的两个
      // assistant 错折叠成同一个工具回合。
      if (
        (child.type === 'message' && child.message?.role === 'user')
        || isPiInternalContinuationEntry(child)
      ) continue
      const role = visibleRole(child)
      if (role === 'assistant') return true
      stack.push(...(childrenByParent.get(child.id) ?? []))
    }
    return false
  }
  const isVisibleEntry = (entry: PiSessionEntry): boolean => {
    const role = visibleRole(entry)
    return role === 'user' || (role === 'assistant' && !hasAssistantBeforeNextUser(entry))
  }
  const visibleIds = new Set(entries.filter(isVisibleEntry).map((entry) => entry.id))

  const nearestVisibleParent = (entry: PiSessionEntry): string | null => {
    let parentId = entry.parentId
    const visited = new Set<string>()
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId)
      if (visibleIds.has(parentId)) return parentId
      parentId = byId.get(parentId)?.parentId ?? null
    }
    return null
  }

  const branchMessageIndex = (entry: PiSessionEntry): number => {
    let index = -1
    let current: PiSessionEntry | undefined = entry
    const visited = new Set<string>()
    while (current && !visited.has(current.id)) {
      visited.add(current.id)
      if (visibleIds.has(current.id)) index += 1
      current = current.parentId ? byId.get(current.parentId) : undefined
    }
    return Math.max(0, index)
  }

  const aggregateToolCount = (entry: PiSessionEntry): number => {
    let count = toolCount(entry)
    let parentId = entry.parentId
    const visited = new Set<string>()
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId)
      const parent = byId.get(parentId)
      if (!parent || visibleIds.has(parent.id)) break
      count += toolCount(parent)
      parentId = parent.parentId
    }
    return count
  }

  let activeLeafId = rawActiveLeafId
  const activeVisited = new Set<string>()
  while (activeLeafId && !visibleIds.has(activeLeafId) && !activeVisited.has(activeLeafId)) {
    activeVisited.add(activeLeafId)
    activeLeafId = byId.get(activeLeafId)?.parentId ?? null
  }

  const nodes: SessionTreeNode[] = []
  let userOrdinal = 0
  for (const entry of entries) {
    const role = visibleRole(entry)
    if (!role || !visibleIds.has(entry.id)) continue
    const count = role === 'assistant' ? aggregateToolCount(entry) : 0
    const text = role === 'user'
      ? rawUserTexts?.[userOrdinal++] ?? contentText(entry.message?.content)
      : contentText(entry.message?.content)
    nodes.push({
      id: entry.id,
      parentId: nearestVisibleParent(entry),
      role,
      summary: role === 'user'
        ? summarizeUserText(entry, text)
        : summarizeText(text, count > 0 ? `Assistant 回复 · ${count} 个工具调用` : 'Assistant 回复'),
      timestamp: entry.timestamp,
      toolCount: count,
      branchMessageIndex: branchMessageIndex(entry),
      isOnActiveBranch: activePath.has(entry.id),
    })
  }

  const visibleParents = new Set(nodes.map((node) => node.parentId).filter((id): id is string => !!id))
  const branchCount = nodes.length === 0
    ? 0
    : nodes.reduce((count, node) => count + (visibleParents.has(node.id) ? 0 : 1), 0)

  return { nodes, activeLeafId, branchCount }
}

function historyTimestamp(createdAt: number | undefined): string | undefined {
  return typeof createdAt === 'number' && Number.isFinite(createdAt)
    ? new Date(createdAt).toISOString()
    : undefined
}

function historyToolCount(group: Extract<ReturnType<typeof groupIntoTurns>[number], { type: 'assistant-turn' }>): number {
  const ids = new Set<string>()
  let anonymousCount = 0
  for (const message of group.assistantMessages) {
    const content = message.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const type = block?.type?.toLowerCase()
      if (type !== 'tooluse' && type !== 'tool_use' && type !== 'toolcall' && type !== 'tool_call') continue
      const id = 'id' in block && typeof block.id === 'string' ? block.id : undefined
      if (id) ids.add(id)
      else anonymousCount += 1
    }
  }
  return ids.size + anonymousCount
}

/**
 * 当前 Pi artifact 只覆盖最近一次 runtime 片段时，把更早但仍在 renderer transcript 中的
 * user/assistant turn 作为线性历史前缀补回树中。历史节点可定位正文，但没有当前 artifact
 * 的 entry ID，因此明确标记为不可执行分支切换。
 */
export function prependHistoricalTranscript(
  tree: SessionTreeResult,
  messages: SDKMessage[],
): SessionTreeResult {
  const activePiUserCount = tree.nodes.filter((node) => node.role === 'user' && node.isOnActiveBranch).length
  const groups = groupIntoTurns(messages)
  const userGroupIndexes = groups.flatMap((group, index) => {
    if (group.type !== 'user') return []
    const text = extractUserText(group.message) ?? ''
    return isAgentCompactCommand(text) ? [] : [index]
  })

  // 正常情况下，持久化 user 会比 Pi entry 早几百毫秒写入。优先按首个 Pi user 的
  // 时间戳寻找最近的 transcript user，避免中间漏持久化一条消息时再次发生序号错位。
  const firstPiUserTime = tree.nodes
    .filter((node) => node.role === 'user')
    .map((node) => node.timestamp ? new Date(node.timestamp).getTime() : Number.NaN)
    .find((timestamp) => Number.isFinite(timestamp))
  let currentSegmentStart: number | undefined
  if (firstPiUserTime !== undefined) {
    const nearest = userGroupIndexes
      .map((index) => {
        const group = groups[index]
        const createdAt = group?.type === 'user' ? extractMeta(group.message).createdAt : undefined
        return { index, distance: createdAt === undefined ? Number.POSITIVE_INFINITY : Math.abs(createdAt - firstPiUserTime) }
      })
      .sort((a, b) => a.distance - b.distance)[0]
    if (nearest && nearest.distance <= 120_000) currentSegmentStart = nearest.index
  }

  if (currentSegmentStart === undefined) {
    const prefixUserCount = userGroupIndexes.length - activePiUserCount
    if (prefixUserCount <= 0) return tree
    currentSegmentStart = userGroupIndexes[prefixUserCount]
  }
  if (currentSegmentStart === undefined || currentSegmentStart <= 0) return tree

  const historyNodes: SessionTreeNode[] = []
  let parentId: string | null = null
  for (let groupIndex = 0; groupIndex < currentSegmentStart; groupIndex += 1) {
    const group = groups[groupIndex]!
    if (group.type === 'system') continue
    if (group.type === 'user') {
      const text = extractUserText(group.message) ?? ''
      if (isAgentCompactCommand(text) || isPiInternalContinuationText(text)) continue
      const id = `history:user:${groupIndex}`
      const syntheticEntry: PiSessionEntry = {
        type: 'message',
        id,
        parentId,
        message: { role: 'user', content: group.message.message?.content as PiContentBlock[] | undefined },
      }
      historyNodes.push({
        id,
        parentId,
        role: 'user',
        summary: summarizeUserText(syntheticEntry, text),
        timestamp: historyTimestamp(extractMeta(group.message).createdAt),
        toolCount: 0,
        branchMessageIndex: historyNodes.length,
        isOnActiveBranch: true,
        canNavigate: false,
      })
      parentId = id
      continue
    }

    const count = historyToolCount(group)
    const id = `history:assistant:${groupIndex}`
    historyNodes.push({
      id,
      parentId,
      role: 'assistant',
      summary: summarizeText(
        getGroupPreview(group),
        count > 0 ? `Assistant 回复 · ${count} 个工具调用` : 'Assistant 回复',
      ),
      timestamp: historyTimestamp(group.createdAt),
      toolCount: count,
      branchMessageIndex: historyNodes.length,
      isOnActiveBranch: true,
      canNavigate: false,
    })
    parentId = id
  }

  if (historyNodes.length === 0) return tree
  const offset = historyNodes.length
  const currentNodes = tree.nodes.map((node) => ({
    ...node,
    parentId: node.parentId ?? parentId,
    branchMessageIndex: node.branchMessageIndex + offset,
    canNavigate: true,
  }))
  return {
    nodes: [...historyNodes, ...currentNodes],
    activeLeafId: tree.activeLeafId ?? parentId,
    branchCount: tree.branchCount || 1,
  }
}

export function loadSessionTree(
  sessionFile: string,
  activeLeafOverride?: string | null,
  rawUserTexts?: string[],
): SessionTreeResult {
  return buildSessionTree(readPiSessionEntries(sessionFile), activeLeafOverride, rawUserTexts)
}

/**
 * Domi 的 renderer transcript 是线性的；Pi JSONL 是 append-only 树。
 * 多分支会话只保留当前活跃路径对应的 turn，避免切分支后残留旧分支消息。
 */
export function filterMessagesToActivePiBranch(
  messages: SDKMessage[],
  entries: PiSessionEntry[],
  bindings: Record<string, string> | undefined,
  activeLeafOverride?: string | null,
): SDKMessage[] {
  const visibleMessages = messages.filter((message) => {
    if (message.type !== 'user') return true
    return !isPiInternalContinuationText(extractUserText(message as SDKUserMessage) ?? '')
  })
  if (!bindings || Object.keys(bindings).length === 0) return visibleMessages
  const tree = buildSessionTree(entries, activeLeafOverride)
  const naturalLastEntryId = entries.at(-1)?.id ?? null
  const rawActiveLeafId = activeLeafOverride !== undefined
    ? activeLeafOverride
    : naturalLastEntryId
  const recoveredMessages = recoverMissingPiUserTurns(visibleMessages, entries, bindings, rawActiveLeafId)
  // 「从此继续 / 编辑重发」会把活跃叶移到历史中间：即使仍是单分支，
  // 活跃点之后的消息也属于“未来”，必须一并截掉，否则切换后仍显示旧内容。
  const isTruncatedHistory = activeLeafOverride !== undefined && activeLeafOverride !== naturalLastEntryId
  if (tree.branchCount <= 1 && !isTruncatedHistory) return recoveredMessages

  const activePath = getActivePathIds(entries, rawActiveLeafId)
  const currentEntryIds = new Set(entries.map((entry) => entry.id))
  const allowedAssistantUuids = new Set(
    Object.entries(bindings)
      .filter(([, entryId]) => activePath.has(entryId))
      .map(([uuid]) => uuid),
  )
  // 多分支时未绑定的 chunk 无法判定归属，沿用既有策略丢弃；
  // 单分支截断时保留未绑定 chunk（如错误提示），避免误伤共享历史。
  const keepUnboundChunks = tree.branchCount <= 1

  const prefix: SDKMessage[] = []
  const chunks: SDKMessage[][] = []
  let current: SDKMessage[] | null = null
  for (const message of recoveredMessages) {
    if (message.type === 'user') {
      current = [message]
      chunks.push(current)
    } else if (current) {
      current.push(message)
    } else {
      prefix.push(message)
    }
  }

  const filtered = chunks.flatMap((chunk) => {
    const assistantUuid = chunk
      .filter((message) => message.type === 'assistant')
      .map((message) => (message as { uuid?: string }).uuid)
      .find((uuid): uuid is string => typeof uuid === 'string' && uuid in bindings)
    if (!assistantUuid) {
      const recoveredEntryId = (chunk[0] as SDKMessage & { _recoveredPiEntryId?: unknown } | undefined)?._recoveredPiEntryId
      if (typeof recoveredEntryId === 'string' && activePath.has(recoveredEntryId)) return chunk
      return keepUnboundChunks ? chunk : []
    }
    const mappedEntryId = bindings[assistantUuid]
    // 当前 artifact 之前的 transcript 属于所有当前分支共享的线性历史，不能因 entry ID
    // 不在新 artifact 中就丢掉；否则 runtime 重启后正文数量也会随分支切换变少。
    if (mappedEntryId && !currentEntryIds.has(mappedEntryId)) return chunk
    return allowedAssistantUuids.has(assistantUuid) ? chunk : []
  })
  // 原始线性 transcript 的最后一个 binding 可能属于非活跃分支。过滤后再恢复一次，
  // 可从活跃路径最后一个已绑定 assistant 补出尚未绑定 assistant 的尾部 user turn。
  return recoverMissingPiUserTurns([...prefix, ...filtered], entries, bindings, rawActiveLeafId)
}

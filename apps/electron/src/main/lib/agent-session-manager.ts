/**
 * Agent 会话管理器
 *
 * 负责 Agent 会话的 CRUD 操作和消息持久化。
 * - 会话索引：~/.domi/agent-sessions.json（轻量元数据）
 * - 消息存储：~/.domi/agent-sessions/{id}.jsonl（JSONL 格式，逐行追加）
 *
 * 照搬 conversation-manager.ts 的模式。
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, createReadStream, createWriteStream, lstatSync, realpathSync, statSync, type WriteStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { writeJsonFileAtomic, writeTextFileAtomic, readJsonFileSafe } from './safe-file'
import { randomUUID } from 'node:crypto'
import { rmSyncWithRetry, renameWithRetry } from './fs-retry'
import { deleteAgentFileCheckpoints } from './agent-file-checkpoint-production.ts'
import { join, resolve, dirname, isAbsolute, relative, sep } from 'node:path'
import {
  getAgentSessionsIndexPath,
  getAgentSessionsDir,
  getAgentSessionMessagesPath,
  getAgentSessionWorkspacePath,
  getAgentWorkspacePath,
  getSdkConfigDir,
} from './config-paths'
import {
  getAgentWorkspace,
  getProjectFilesPath,
  getWorkspaceAutoMemoryDir,
  listAgentWorkspaces,
} from './agent-workspace-manager'
import { resolvePiThinkingLevel } from './agent-thinking-level'
import { getSettings } from './settings-service'

// 在模块加载时一次性设置 SDK 配置目录，避免在 forkSession 等异步调用中临时修改/恢复
// process.env 导致的并发安全问题（异步操作的 await 间隙其他代码可能读到错误值）
if (!process.env.CLAUDE_CONFIG_DIR) {
  process.env.CLAUDE_CONFIG_DIR = getSdkConfigDir()
}
import type {
  AgentSessionMeta,
  AgentMessage,
  SDKMessage,
  AgentWorkspace,
  ForkSessionInput,
  ForkSessionTargetChoice,
  AgentMessageSearchResult,
  AgentSessionReferenceSearchInput,
  AgentSessionReferenceSearchResult,
  AgentCwdMode,
} from '@domi/shared'
import {
  isAgentWorkflow,
  isExecutionPolicyMode,
  migratePermissionMode,
  normalizeAgentExecutionSettings,
} from '@domi/shared'
import { getConversationMessages } from './conversation-manager'
// 旧格式 → SDKMessage 的转换逻辑下沉到 @domi/session-core 作为唯一真源，避免主进程与渲染层各存一份。
import { convertLegacyMessage } from '@domi/session-core'
import { clearNanoBananaAgentHistory } from './chat-tools/nano-banana-mcp'
import { assertEnabledModelForChannel } from './agent-model-selection'
import { copyForkWorkspaceFiles, copyRequiredForkSessionContext } from './agent-fork-workspace-copy'
import { filterMessagesToActivePiBranch, readPiSessionEntries } from './session-tree-service'
import type { PiSessionRewindStateSnapshot } from './agent-rewind-undo-types.ts'

/**
 * 会话索引文件格式
 */
interface AgentSessionsIndex {
  /** 配置版本号 */
  version: number
  /** 会话元数据列表 */
  sessions: AgentSessionMeta[]
  /** 是否已将旧版默认关闭的 OpenAI 推理会话升级为默认开启。 */
  openAIThinkingDefaultEnabledMigrationCompleted?: boolean
}

/** 当前索引版本；v2 表示会话已完成 Pi-only runtime 迁移。 */
const INDEX_VERSION = 2

/**
 * 会话引用最大返回数。
 *
 * 无搜索词时只返回索引中的轻量元数据，200 条可以显著扩大可选范围，
 * 同时避免极端会话数量下向渲染进程传输过大列表。
 */
const MAX_SESSION_REFERENCE_LIMIT = 200

/**
 * 会话引用的正文搜索是输入框补全路径，必须有独立 I/O 预算。
 * 标题检索仍覆盖全部会话；仅正文 JSONL 检索优先服务最近会话。
 */
const MAX_SESSION_REFERENCE_BODY_SCANS = 50
const MAX_SESSION_REFERENCE_BODY_BYTES_PER_FILE = 256 * 1024

interface JsonlParseError {
  lineNumber: number
  message: string
}

/**
 * 逐行解析 JSONL，调用方按业务场景决定容错或严格失败。
 */
function parseJsonlLines<T>(lines: string[]): { records: T[]; errors: JsonlParseError[] } {
  const records: T[] = []
  const errors: JsonlParseError[] = []
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]!) as T)
    } catch (err) {
      errors.push({
        lineNumber: i + 1,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { records, errors }
}

/**
 * 展示/检索类读取：跳过损坏行，保留其它可读消息。
 */
function parseJsonlLenient<T>(lines: string[], context: string): T[] {
  const { records, errors } = parseJsonlLines<T>(lines)
  for (const error of errors) {
    console.warn(`[Agent 会话] ${context} — JSONL 第 ${error.lineNumber} 行解析失败，已跳过:`, error.message)
  }
  return records
}

/**
 * 回退/文件恢复类读取：任何损坏行都可能破坏消息顺序或快照完整性，必须停止。
 */
function parseJsonlStrict<T>(lines: string[], context: string): T[] {
  const { records, errors } = parseJsonlLines<T>(lines)
  if (errors.length > 0) {
    const first = errors[0]!
    throw new Error(`${context} 失败：JSONL 第 ${first.lineNumber} 行解析失败: ${first.message}`)
  }
  return records
}

function normalizePersistedSDKMessage(parsed: unknown): SDKMessage {
  // 旧格式检测：AgentMessage 有 `role` 字段，SDKMessage 有 `type` 字段
  if (parsed && typeof parsed === 'object' && 'role' in parsed && !('type' in parsed)) {
    return convertLegacyMessage(parsed as AgentMessage)
  }
  return parsed as SDKMessage
}

function hasInterruptedPiOnlyMigrationMarkers(session: AgentSessionMeta): boolean {
  // Pi-only 中间版本曾先删除 agentRuntime、写入 typed Execution Controls，随后才升级索引版本。
  // 只有两个 Pi 专属字段都合法时才允许恢复；普通旧索引缺字段仍按 Claude 语义 fail closed。
  return isExecutionPolicyMode(session.executionPolicy)
    && isAgentWorkflow(session.workflow)
}

function migrateAgentExecutionSettings(index: AgentSessionsIndex): boolean {
  let changed = false
  const requiresExplicitRuntimeMigration = !Number.isInteger(index.version) || index.version < INDEX_VERSION
  for (const session of index.sessions) {
    const legacySession = session as AgentSessionMeta & { agentRuntime?: unknown }
    const legacyRuntime = legacySession.agentRuntime
    const canRecoverInterruptedPiMigration = legacyRuntime === undefined
      && hasInterruptedPiOnlyMigrationMarkers(session)
    if (requiresExplicitRuntimeMigration && legacyRuntime !== 'pi' && !canRecoverInterruptedPiMigration) {
      const label = legacyRuntime === undefined ? '缺失（旧版默认 Claude）' : String(legacyRuntime)
      throw new Error(`不支持的旧 Agent runtime: ${label}。请使用仍支持该 runtime 的旧版 Domi 导出兼容数据。`)
    }
    if (legacyRuntime !== undefined) {
      if (legacyRuntime !== 'pi') {
        throw new Error(`不支持的旧 Agent runtime: ${String(legacyRuntime)}。请使用仍支持该 runtime 的旧版 Domi 导出兼容数据。`)
      }
      delete legacySession.agentRuntime
      changed = true
    }
    const normalized = normalizeAgentExecutionSettings({
      executionPolicy: session.executionPolicy,
      workflow: session.workflow,
      piToolProfile: session.piToolProfile,
      permissionMode: session.permissionMode,
    })
    if (session.executionPolicy !== normalized.executionPolicy) {
      session.executionPolicy = normalized.executionPolicy
      changed = true
    }
    if (session.workflow !== normalized.workflow) {
      session.workflow = normalized.workflow
      changed = true
    }
    if (session.piToolProfile !== undefined) {
      delete session.piToolProfile
      changed = true
    }
  }
  if (requiresExplicitRuntimeMigration) {
    index.version = INDEX_VERSION
    changed = true
  }
  return changed
}

/**
 * 在此版本前，所有新建 OpenAI Agent 会话都会写入 off，无法与用户主动关闭区分。
 * 因此仅执行一次历史升级；之后用户手动关闭会保留 off。
 */
function migrateLegacyOpenAIThinkingDefault(index: AgentSessionsIndex): boolean {
  if (index.openAIThinkingDefaultEnabledMigrationCompleted) return false

  for (const session of index.sessions) {
    if (session.openAIThinkingLevel === 'off') {
      session.openAIThinkingLevel = 'high'
    }
  }
  index.openAIThinkingDefaultEnabledMigrationCompleted = true
  return true
}

interface AgentSessionsIndexCacheEntry {
  path: string
  mtimeMs: number
  ctimeMs: number
  size: number
  value: AgentSessionsIndex
}

let agentSessionsIndexCache: AgentSessionsIndexCacheEntry | null = null

/**
 * 读取会话索引文件。缓存只在 mtime、ctime 与 size 同时一致时命中；调用方始终获得副本，
 * 避免尚未持久化的对象修改污染缓存。
 */
function readIndex(): AgentSessionsIndex {
  const indexPath = getAgentSessionsIndexPath()
  const signatureBeforeRead = readIndexSignature(indexPath)
  if (signatureBeforeRead
    && agentSessionsIndexCache?.path === indexPath
    && agentSessionsIndexCache.mtimeMs === signatureBeforeRead.mtimeMs
    && agentSessionsIndexCache.ctimeMs === signatureBeforeRead.ctimeMs
    && agentSessionsIndexCache.size === signatureBeforeRead.size) {
    return structuredClone(agentSessionsIndexCache.value)
  }

  const data = readJsonFileSafe<AgentSessionsIndex>(indexPath)
  if (data) {
    const executionSettingsMigrated = migrateAgentExecutionSettings(data)
    const thinkingDefaultMigrated = migrateLegacyOpenAIThinkingDefault(data)
    if (executionSettingsMigrated || thinkingDefaultMigrated) {
      writeIndex(data)
      if (executionSettingsMigrated) {
        console.log('[Agent 会话] 已规范化历史 Execution Policy 与 Workflow')
      }
      if (thinkingDefaultMigrated) {
        console.log('[Agent 会话] 已将历史 OpenAI 会话的思考深度默认值升级为高')
      }
    } else {
      const signatureAfterRead = readIndexSignature(indexPath)
      if (signatureBeforeRead
        && signatureAfterRead
        && signatureBeforeRead.mtimeMs === signatureAfterRead.mtimeMs
        && signatureBeforeRead.ctimeMs === signatureAfterRead.ctimeMs
        && signatureBeforeRead.size === signatureAfterRead.size) {
        agentSessionsIndexCache = {
          path: indexPath,
          ...signatureAfterRead,
          value: structuredClone(data),
        }
      } else {
        agentSessionsIndexCache = null
      }
    }
    return data
  }
  agentSessionsIndexCache = null
  return {
    version: INDEX_VERSION,
    sessions: [],
    openAIThinkingDefaultEnabledMigrationCompleted: true,
  }
}

/**
 * 写入会话索引文件，并在原子替换完成后更新缓存签名。
 */
function writeIndex(index: AgentSessionsIndex): void {
  const indexPath = getAgentSessionsIndexPath()

  try {
    writeJsonFileAtomic(indexPath, index)
    const signature = readIndexSignature(indexPath)
    agentSessionsIndexCache = signature
      ? { path: indexPath, ...signature, value: structuredClone(index) }
      : null
  } catch (error) {
    agentSessionsIndexCache = null
    console.error('[Agent 会话] 写入索引文件失败:', error)
    throw new Error('写入 Agent 会话索引失败')
  }
}

function readIndexSignature(path: string): { mtimeMs: number; ctimeMs: number; size: number } | null {
  try {
    const stats = statSync(path)
    return { mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, size: stats.size }
  } catch {
    return null
  }
}

/**
 * 获取所有会话（按 updatedAt 降序）
 */
export function listAgentSessions(): AgentSessionMeta[] {
  const index = readIndex()
  return index.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 获取单个会话的元数据
 */
export function getAgentSessionMeta(id: string): AgentSessionMeta | undefined {
  const index = readIndex()
  return index.sessions.find((s) => s.id === id)
}

/** 缺少标记的存量会话必须保持升级前的私有 workbench cwd。 */
export function getAgentCwdMode(meta?: Pick<AgentSessionMeta, 'agentCwdMode'>): AgentCwdMode {
  return meta?.agentCwdMode ?? 'session'
}

/** Agent 运行 cwd 与 Domi 会话 sidecar 工作台目录解析。 */
export function resolveAgentCwd(
  workspace: Pick<AgentWorkspace, 'slug'> | undefined,
  sessionId: string,
  agentCwdMode?: AgentCwdMode,
): string | undefined {
  if (!workspace) return undefined
  return getAgentCwdMode({ agentCwdMode }) === 'project'
    ? getProjectFilesPath(workspace.slug)
    : getAgentSessionWorkspacePath(workspace.slug, sessionId)
}

export function resolveAgentWorkbenchDir(
  workspace: Pick<AgentWorkspace, 'slug' | 'projectRootPath'> | undefined,
  sessionId: string,
): string | undefined {
  if (!workspace) return undefined
  return getAgentSessionWorkspacePath(workspace.slug, sessionId)
}

/**
 * 创建新会话
 */
export function createAgentSession(
  title?: string,
  channelId?: string,
  workspaceId?: string,
  modelId?: string,
  agentCwdMode?: AgentCwdMode,
): AgentSessionMeta {
  const index = readIndex()
  const now = Date.now()

  const settings = getSettings()
  const defaultThinkingLevel = settings.defaultOpenAIThinkingLevel
    ?? resolvePiThinkingLevel(settings, undefined, 'openai-codex')
  const meta: AgentSessionMeta = {
    id: randomUUID(),
    title: title || '新 Agent 会话',
    channelId,
    modelId,
    workspaceId,
    agentCwdMode: workspaceId ? agentCwdMode ?? 'project' : undefined,
    sessionTarget: { kind: 'unselected' },
    ...normalizeAgentExecutionSettings({
      executionPolicy: settings.agentExecutionPolicy,
      workflow: settings.agentWorkflow,
    }),
    // 新会话继承已持久化的全局思考偏好，之后仍可按会话单独调整。
    reasoningLevel: defaultThinkingLevel,
    createdAt: now,
    updatedAt: now,
  }

  index.sessions.push(meta)
  writeIndex(index)

  // 确保消息目录存在
  getAgentSessionsDir()

  // 若有工作区，创建 session 级别子文件夹和 Domi 工作台目录。
  if (workspaceId) {
    const ws = getAgentWorkspace(workspaceId)
    if (ws) {
      const sessionDir = getAgentSessionWorkspacePath(ws.slug, meta.id)


      // .context 是 Domi 的会话工作台，本地项目同样需要。
      const contextDir = join(sessionDir, '.context')
      if (!existsSync(contextDir)) mkdirSync(contextDir, { recursive: true })
    }
  }

  console.log(`[Agent 会话] 已创建会话: ${meta.title} (${meta.id})`)
  return meta
}

/**
 * 读取会话的所有消息
 */
export function getAgentSessionMessages(id: string): AgentMessage[] {
  const filePath = getAgentSessionMessagesPath(id)

  if (!existsSync(filePath)) {
    return []
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim())
    return parseJsonlLenient<AgentMessage>(lines, `读取会话消息 (${id})`)
  } catch (error) {
    console.error(`[Agent 会话] 读取消息失败 (${id}):`, error)
    return []
  }
}

/**
 * 追加一条消息到会话的 JSONL 文件
 */
export function appendAgentMessage(id: string, message: AgentMessage): void {
  const filePath = getAgentSessionMessagesPath(id)

  try {
    const line = JSON.stringify(message) + '\n'
    appendFileSync(filePath, line, 'utf-8')

    // 追加消息时更新 updatedAt，若已归档则自动恢复活跃
    const index = readIndex()
    const idx = index.sessions.findIndex((s) => s.id === id)
    if (idx !== -1) {
      const session = index.sessions[idx]!
      session.updatedAt = Date.now()
      if (session.archived) session.archived = false
      writeIndex(index)
    }
  } catch (error) {
    console.error(`[Agent 会话] 追加消息失败 (${id}):`, error)
    throw new Error('追加 Agent 消息失败')
  }
}

/** 单条 SDKMessage 序列化后最大长度（UTF-16 code units，超出则截断内容） */
const MAX_SDK_MESSAGE_LENGTH = 256 * 1024 // ~256K chars
/** 截断后保留的预览文本长度 */
const TRUNCATED_PREVIEW_LENGTH = 2000

/**
 * 追加 SDKMessage 到会话的 JSONL 文件（Phase 4 新持久化格式）
 *
 * 每条 SDKMessage 单独一行 JSON。读取时通过 `type` 字段区分新旧格式。
 * 超过 256K chars 的消息会被自动截断以防止存储膨胀。
 */
export function appendSDKMessages(id: string, messages: SDKMessage[]): void {
  if (messages.length === 0) return

  const filePath = getAgentSessionMessagesPath(id)

  try {
    const batch = messages.map((message) => serializeSDKMessageForStorage(message)).join('\n')
    appendFileSync(filePath, `${batch}\n`, 'utf-8')
  } catch (error) {
    console.error(`[Agent 会话] 追加 SDKMessage 失败 (${id}):`, error)
    throw new Error('追加 SDKMessage 失败')
  }
}

/**
 * 截断超大 SDKMessage 的内容，保留元数据结构。
 * 处理三类膨胀源：超长 text block、超大 tool_result、内嵌 base64 图片。
 */
function sanitizeOversizedMessage(msg: SDKMessage, originalLength: number): SDKMessage {
  const truncationNote = `\n[内容已截断: 原始 ${(originalLength / 1024).toFixed(0)}K chars 超出存储限制]`
  const truncationThreshold = MAX_SDK_MESSAGE_LENGTH / 2

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clone: any = JSON.parse(JSON.stringify(msg))
  const content = clone.message?.content
  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const block = content[i]
      if (!block || typeof block !== 'object') continue

      // 截断超长 text block
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > truncationThreshold) {
        block.text = block.text.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
      }

      // 截断超大 tool_result
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string' && block.content.length > truncationThreshold) {
          block.content = block.content.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
        }
        // 剥离 base64 图片数据
        if (Array.isArray(block.content)) {
          block.content = block.content.map((item: Record<string, unknown>) => {
            if (item?.type === 'image' && (item.source as Record<string, unknown>)?.data) {
              const dataLen = String((item.source as Record<string, unknown>).data).length
              return { type: 'image', _truncated: true, _originalLength: dataLen }
            }
            return item
          })
        }
      }
    }
  }

  // 截断 error.message
  if (clone.error && typeof clone.error === 'object' && typeof clone.error.message === 'string' && clone.error.message.length > truncationThreshold) {
    clone.error.message = clone.error.message.slice(0, TRUNCATED_PREVIEW_LENGTH) + truncationNote
  }

  return clone as SDKMessage
}

/**
 * 读取会话的所有 SDKMessage（兼容旧 AgentMessage 格式）
 *
 * 旧格式（有 `role` 字段）会被转换为近似的 SDKMessage。
 * 新格式（有 `type` 字段）直接返回。
 */
export function getAgentSessionSDKMessagesRaw(id: string): SDKMessage[] {
  const filePath = getAgentSessionMessagesPath(id)
  if (!existsSync(filePath)) return []
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter((line) => line.trim())
    return parseJsonlLenient<unknown>(lines, `读取 SDKMessage (${id})`).map(normalizePersistedSDKMessage)
  } catch (error) {
    console.error(`[Agent 会话] 读取 SDKMessage 失败 (${id}):`, error)
    return []
  }
}

export function getAgentSessionSDKMessages(id: string): SDKMessage[] {
  const messages = getAgentSessionSDKMessagesRaw(id)
  const meta = getAgentSessionMeta(id)
  if (!meta?.piSessionFile) return messages
  return filterMessagesToActivePiBranch(
    messages,
    readPiSessionEntries(meta.piSessionFile),
    meta.piEntryBindings,
    meta.piTreeActiveLeafId,
  )
}

/**
 * convertLegacyMessage 已迁移至 @domi/session-core（本文件从该包 import 使用）。
 */

/**
 * 更新会话元数据
 */
export function updateAgentSessionMeta(
  id: string,
  updates: Partial<Pick<AgentSessionMeta, 'title' | 'channelId' | 'modelId' | 'sdkSessionId' | 'piSessionFile' | 'piEntryBindings' | 'piTreeActiveLeafId' | 'sessionTarget' | 'codexFastMode' | 'visionRelayAttachedDirectories' | 'reasoningLevel' | 'openAIThinkingLevel' | 'modelPresentationPreset' | 'workspaceId' | 'pinned' | 'starred' | 'needsFollowUp' | 'archived' | 'attachedDirectories' | 'attachedFiles' | 'forkSourceDir' | 'forkSourceSdkSessionId' | 'resumeAtMessageUuid' | 'stoppedByUser' | 'workActivityRun' | 'workActivityTasks' | 'workActivityViewedAt' | 'workActivityAcknowledgedOutcomeAt' | 'workActivityRemovedOutcomeAt' | 'executionPolicy' | 'workflow' | 'permissionMode' | 'completedButUnconfirmed' | 'sourceAutomationId' | 'automationGraduated' | 'handoffId' | 'handoffOriginSessionId' | 'handoffMode' | 'handoffDegradedReason' | 'handoffStartedAt' | 'recoveryHandoffId' | 'recoveryOriginSessionId' | 'recoveryHandoffStartedAt' | 'parentSessionId' | 'rootSessionId' | 'sourceDelegationId' | 'delegationRole' | 'delegationStatus' | 'delegationCheckoutReleasedAt' | 'delegationDepth' | 'delegationGoal'>>,
): AgentSessionMeta {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === id)

  if (idx === -1) {
    throw new Error(`Agent 会话不存在: ${id}`)
  }

  const existing = index.sessions[idx]!
  const updateKeys = Object.keys(updates)
  // 星标、待继续与 Work Activity 展示状态只是人工标记，不应改变会话的新鲜度或归档状态。
  const isManualMarkerOnly = updateKeys.every((key) => (
    key === 'starred'
    || key === 'needsFollowUp'
    || key === 'workActivityViewedAt'
    || key === 'workActivityAcknowledgedOutcomeAt'
    || key === 'workActivityRemovedOutcomeAt'
  ))
  // 非手动归档操作时，若会话已归档则自动恢复为活跃（仅更新 stoppedByUser 或人工标记不触发解归档）
  const isStoppedByUserOnly = updateKeys.every((key) => key === 'stoppedByUser')
  const autoUnarchive = existing.archived && !('archived' in updates) && !isStoppedByUserOnly && !isManualMarkerOnly
  const updated: AgentSessionMeta = {
    ...existing,
    ...updates,
    ...(autoUnarchive ? { archived: false } : {}),
    updatedAt: isManualMarkerOnly ? existing.updatedAt : Date.now(),
  }

  index.sessions[idx] = updated
  writeIndex(index)

  console.log(`[Agent 会话] 已更新会话: ${updated.title} (${updated.id})`)
  return updated
}

type ReleasePiSessionLifecycle = (
  sessionId: string,
  intent: 'delete' | 'move',
) => Promise<void>

let releasePiSessionLifecycleForTesting: ReleasePiSessionLifecycle | undefined

/** 仅供测试替换跨模块生命周期 seam，避免加载 Electron production adapters。 */
export function setReleasePiSessionLifecycleForTesting(
  release: ReleasePiSessionLifecycle | undefined,
): void {
  releasePiSessionLifecycleForTesting = release
}

async function releasePiSessionLifecycle(
  session: AgentSessionMeta,
  intent: 'delete' | 'move',
): Promise<void> {
  if (releasePiSessionLifecycleForTesting) {
    await releasePiSessionLifecycleForTesting(session.id, intent)
    return
  }
  const { getSessionCheckoutModule } = await import('./session-checkout/production.ts')
  await getSessionCheckoutModule().releaseSession(session.id, intent)
}

/** 在项目级操作产生任何副作用前，预检其所有 Pi 会话的 Checkout 生命周期。 */
export async function assertAgentWorkspaceSessionLifecycle(
  workspaceId: string,
  intent: 'delete' | 'move',
): Promise<void> {
  const sessions = readIndex().sessions.filter((session) => (
    session.workspaceId === workspaceId
  ))
  if (releasePiSessionLifecycleForTesting) {
    for (const session of sessions) {
      await releasePiSessionLifecycleForTesting(session.id, intent)
    }
    return
  }
  const { getSessionCheckoutModule } = await import('./session-checkout/production.ts')
  const checkout = getSessionCheckoutModule()
  for (const session of sessions) {
    await checkout.assertReleaseSession(session.id, intent)
  }
}

/**
 * 删除会话。Session Checkout 检查必须先完成，失败时不改索引或 sidecar。
 */
export async function deleteAgentSession(id: string): Promise<void> {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === id)

  if (idx === -1) {
    console.warn(`[Agent 会话] 会话不存在，跳过删除: ${id}`)
    return
  }

  const candidate = index.sessions[idx]!
  await releasePiSessionLifecycle(candidate, 'delete')

  const removed = index.sessions.splice(idx, 1)[0]!
  writeIndex(index)

  // 删除消息文件
  const filePath = getAgentSessionMessagesPath(id)
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath)
    } catch (error) {
      console.warn(`[Agent 会话] 删除消息文件失败 (${id}):`, error)
    }
  }
  try {
    deleteAgentFileCheckpoints(id)
  } catch (error) {
    console.warn(`[Agent 会话] 删除文件检查点失败 (${id}):`, error)
  }

  // 清理 session 工作目录
  if (removed.workspaceId) {
    const ws = getAgentWorkspace(removed.workspaceId)
    if (ws) {
      try {
        const sessionDir = getAgentSessionWorkspacePath(ws.slug, id)
        if (existsSync(sessionDir)) {
          rmSyncWithRetry(sessionDir, { recursive: true, force: true })
          console.log(`[Agent 会话] 已清理 session 工作目录: ${sessionDir}`)
        }
      } catch (error) {
        console.warn(`[Agent 会话] 清理 session 工作目录失败 (${id}):`, error)
      }
    }
  }

  console.log(`[Agent 会话] 已删除会话: ${removed.title} (${removed.id})`)

  // 清理 Nano Banana 生图历史
  clearNanoBananaAgentHistory(id)

  // 清理旧版 Claude SDK 兼容残留；当前 Pi 文件检查点不读取这些 artifact。
  const sdkSessionIds = [removed.sdkSessionId, removed.forkSourceSdkSessionId].filter(Boolean) as string[]
  if (sdkSessionIds.length > 0) {
    const sdkConfigDir = getSdkConfigDir()

    const fileHistoryDir = join(sdkConfigDir, 'file-history')
    for (const sid of sdkSessionIds) {
      const histDir = join(fileHistoryDir, sid)
      if (existsSync(histDir)) {
        try {
          rmSyncWithRetry(histDir, { recursive: true, force: true })
          console.log(`[Agent 会话] 已清理 file-history: ${sid}`)
        } catch (e) {
          console.warn(`[Agent 会话] 清理 file-history 失败 (${sid}):`, e)
        }
      }
    }

    const projectsDir = join(sdkConfigDir, 'projects')
    if (existsSync(projectsDir)) {
      try {
        for (const hashDir of readdirSync(projectsDir)) {
          const projPath = join(projectsDir, hashDir)
          for (const sid of sdkSessionIds) {
            const sessionFile = join(projPath, `${sid}.jsonl`)
            if (existsSync(sessionFile)) {
              try {
                unlinkSync(sessionFile)
                console.log(`[Agent 会话] 已清理 SDK session 文件: ${sessionFile}`)
              } catch (e) {
                console.warn('[Agent 会话] 清理 SDK session 文件失败:', e)
              }
            }
          }
          try {
            if (readdirSync(projPath).length === 0) rmSyncWithRetry(projPath, { recursive: true })
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
  }
}

/**
 * 收集会话及其全部委派子会话。
 */
function collectSessionTreeIds(sessions: AgentSessionMeta[], sessionId: string): Set<string> {
  const ids = new Set<string>([sessionId])
  let changed = true

  while (changed) {
    changed = false
    for (const session of sessions) {
      if (ids.has(session.id)) continue
      // 仅收集协作委派子会话。parent/root 负责维护树结构，sourceDelegationId 负责限定来源。
      if (!session.sourceDelegationId) continue
      if (session.parentSessionId && ids.has(session.parentSessionId)) {
        ids.add(session.id)
        changed = true
        continue
      }
      if (session.rootSessionId === sessionId) {
        ids.add(session.id)
        changed = true
      }
    }
  }

  return ids
}

function moveSessionWorkspaceDir(session: AgentSessionMeta, targetWorkspaceSlug: string): void {
  if (!session.workspaceId) return

  const sourceWs = getAgentWorkspace(session.workspaceId)
  if (!sourceWs || sourceWs.slug === targetWorkspaceSlug) return

  const srcDir = join(getAgentWorkspacePath(sourceWs.slug), session.id)
  if (!existsSync(srcDir)) return

  const destDir = join(getAgentWorkspacePath(targetWorkspaceSlug), session.id)
  // 清理已存在的目标目录，防止 renameSync 抛出 ENOTEMPTY/EEXIST。
  if (existsSync(destDir)) {
    try {
      const contents = readdirSync(destDir)
      rmSyncWithRetry(destDir, { recursive: true, force: true })
      const reason = contents.length === 0 ? '空目标目录' : '非空目标目录（以源目录为准）'
      console.log(`[Agent 会话] 已清理${reason}: ${destDir}`)
    } catch (cleanupError) {
      console.warn('[Agent 会话] 清理目标目录失败，跳过目录迁移:', cleanupError)
      throw cleanupError
    }
  }

  // renameWithRetry：优先 renameSync（原子），跨设备或句柄占用时自动降级 cpSync + rmSyncWithRetry。
  renameWithRetry(srcDir, destDir)
  console.log(`[Agent 会话] 已移动工作目录: ${srcDir} → ${destDir}`)
}

/**
 * 迁移 Agent 会话到另一个工作区
 *
 * 操作步骤：
 * 1. 验证会话和目标工作区存在
 * 2. 收集目标会话及其委派子会话
 * 3. 移动会话工作目录到目标工作区
 * 4. 更新元数据（workspaceId + 清空 sdkSessionId）
 * 5. JSONL 消息文件保持原位（全局目录）
 */
export async function moveSessionToWorkspace(sessionId: string, targetWorkspaceId: string): Promise<AgentSessionMeta> {
  const index = readIndex()
  const idx = index.sessions.findIndex((s) => s.id === sessionId)
  if (idx === -1) {
    throw new Error(`Agent 会话不存在: ${sessionId}`)
  }

  const session = index.sessions[idx]!

  const targetWs = getAgentWorkspace(targetWorkspaceId)
  if (!targetWs) {
    throw new Error(`目标项目不存在: ${targetWorkspaceId}`)
  }

  const sessionTreeIds = collectSessionTreeIds(index.sessions, sessionId)
  const sessionsToMove = index.sessions.filter((item) => sessionTreeIds.has(item.id) && item.workspaceId !== targetWorkspaceId)
  if (sessionsToMove.length === 0) return session

  // 所有 Pi 会话先完成 fail-closed preflight，避免任一 binding 拒绝后 metadata 已部分移动。
  for (const current of sessionsToMove) {
    await releasePiSessionLifecycle(current, 'move')
  }

  const now = Date.now()
  let updatedRoot = session
  let movedCount = 0

  for (let i = 0; i < index.sessions.length; i++) {
    const current = index.sessions[i]!
    if (!sessionTreeIds.has(current.id) || current.workspaceId === targetWorkspaceId) continue

    moveSessionWorkspaceDir(current, targetWs.slug)
    // 确保目标工作区下有 session 目录。
    getAgentSessionWorkspacePath(targetWs.slug, current.id)

    const updated: AgentSessionMeta = {
      ...current,
      workspaceId: targetWorkspaceId,
      sdkSessionId: undefined, // SDK 上下文与工作区 cwd 绑定，必须清空
      updatedAt: now,
    }
    index.sessions[i] = updated
    writeIndex(index)
    movedCount++
    if (current.id === sessionId) {
      updatedRoot = updated
    }
  }

  console.log(`[Agent 会话] 已迁移会话及子会话到工作区: ${updatedRoot.title}（${movedCount} 个）→ ${targetWs.name}`)
  return updatedRoot
}

/**
 * 迁移 Chat 对话记录到 Agent 会话
 *
 * 读取 Chat 对话的消息，转换为 AgentMessage 格式，
 * 追加到目标 Agent 会话的 JSONL 文件中。
 *
 * 仅迁移 user 和 assistant 角色的消息文本内容，
 * 工具活动、推理、附件等 Chat 特有字段不迁移。
 */
export function migrateChatToAgentSession(conversationId: string, agentSessionId: string): void {
  const chatMessages = getConversationMessages(conversationId)

  if (chatMessages.length === 0) {
    console.log(`[Agent 会话] Chat 对话无消息，跳过迁移 (${conversationId})`)
    return
  }

  let count = 0
  for (const cm of chatMessages) {
    // 仅迁移 user 和 assistant 消息
    if (cm.role !== 'user' && cm.role !== 'assistant') continue
    if (!cm.content.trim()) continue

    const agentMsg: AgentMessage = {
      id: randomUUID(),
      role: cm.role,
      content: cm.content,
      createdAt: cm.createdAt,
      model: cm.role === 'assistant' ? cm.model : undefined,
    }

    appendAgentMessage(agentSessionId, agentMsg)
    count++
  }

  console.log(`[Agent 会话] 已迁移 ${count} 条消息到 Agent 会话 (${conversationId} → ${agentSessionId})`)
}

function assertForkSessionTargetChoice(value: unknown): asserts value is ForkSessionTargetChoice | undefined {
  if (value === undefined) return
  if (!value || typeof value !== 'object' || !('kind' in value)) {
    throw new Error('无效的 Fork Session Target')
  }
  if (value.kind === 'inherit' || value.kind === 'isolated-copy') return
  if (value.kind === 'isolated' && 'confirmDirty' in value && typeof value.confirmDirty === 'boolean') return
  throw new Error('无效的 Fork Session Target')
}

/**
 * 分叉 Agent 会话（SDK 原生 fork）
 *
 * 直接调用 SDK 的 forkSession() 独立函数完成 JSONL 复制和 UUID 重映射，
 * 新会话立即获得 sdkSessionId，无需延迟到首次发消息。
 *
 * forkSourceDir 记录源会话的工作目录，仅作为元数据参考保留。
 * SDK session JSONL 已在 fork 创建时复制到新会话的 project-hash 目录下，
 * orchestrator 无需在运行时切换 cwd。
 *
 * process.env.CLAUDE_CONFIG_DIR 已在模块加载时设置，无需在此处临时修改。
 *
 * @returns 新创建的会话元数据
 */
export type PiForkUnavailableReason =
  | 'sdk_session_missing'
  | 'entry_mapping_missing'
  | 'session_artifact_missing'
  | 'session_artifact_unreadable'
  | 'safe_fork_point_unavailable'
  | 'branch_creation_failed'
  | 'fork_artifact_invalid'

/** 仅表示 Pi 历史继承能力不可用；调用方可在保持 Target 安全门禁的前提下降级为全新会话。 */
export class PiForkUnavailableError extends Error {
  readonly code = 'pi_fork_unavailable'

  constructor(
    readonly reason: PiForkUnavailableReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'PiForkUnavailableError'
  }
}

export function isPiForkUnavailableError(error: unknown): error is PiForkUnavailableError {
  return error instanceof PiForkUnavailableError
}

export interface HostPiForkPoint {
  /** 可信 Pi entry；仅主进程内部 handoff 使用，不接受 renderer 输入。 */
  piEntryId: string
  /** UI JSONL 必须复制到对应 tool_result，保持工具调用闭合。 */
  uiUpToMessageUuid: string
  /** 与最终 checkout binding lock 内 Git snapshot 比较。 */
  expectedCurrentOid: string
  /** 只能源自主进程真实 AskUser 流程。 */
  dirtyConfirmed: boolean
  /** 工具内 Local handoff 必须闭合到 toolResult；宿主持久化的通用 session handoff 可从已验证 assistant 安全派生。 */
  expectedEntryRole?: 'toolResult' | 'assistant'
}

export async function forkAgentSession(input: ForkSessionInput, hostPiForkPoint?: HostPiForkPoint): Promise<AgentSessionMeta> {
  const { sessionId, upToMessageUuid } = input
  assertForkSessionTargetChoice(input.target)

  // 1. 获取源会话元数据
  const sourceMeta = getAgentSessionMeta(sessionId)
  if (!sourceMeta) {
    throw new Error(`源 Agent 会话不存在: ${sessionId}`)
  }

  if (!sourceMeta.sdkSessionId) {
    throw new PiForkUnavailableError('sdk_session_missing', '该会话没有 SDK session，无法继承完整历史')
  }

  return forkPiAgentSession(sourceMeta, input, hostPiForkPoint)
}

/**
 * Pi 的 session 是 append-only tree。分叉必须由 SessionManager 导出目标 branch，
 * 不能只复制 Domi 的展示 JSONL，否则下一轮 resume 仍会看到被截断的上下文。
 */
async function forkPiAgentSession(
  sourceMeta: AgentSessionMeta,
  input: ForkSessionInput,
  hostPiForkPoint?: HostPiForkPoint,
): Promise<AgentSessionMeta> {
  const targetUuid = input.upToMessageUuid
  if (!targetUuid) throw new Error('Pi 分叉需要指定一条已完成的 assistant 消息')
  const entryId = hostPiForkPoint?.piEntryId ?? sourceMeta.piEntryBindings?.[targetUuid]
  if (!entryId) {
    throw new PiForkUnavailableError('entry_mapping_missing', '该 Pi 历史消息尚无 entry ID 映射，无法继承完整历史')
  }
  if (!sourceMeta.piSessionFile || !existsSync(sourceMeta.piSessionFile)) {
    throw new PiForkUnavailableError('session_artifact_missing', '未找到 Pi session artifact，无法继承完整历史')
  }

  const forkModelId = input.modelId !== undefined
    ? assertEnabledModelForChannel({ channelId: sourceMeta.channelId, modelId: input.modelId, purpose: '分叉 Pi Agent 会话' })
    : sourceMeta.modelId
  const workspace = sourceMeta.workspaceId ? getAgentWorkspace(sourceMeta.workspaceId) : undefined
  const sourceCwdMode = getAgentCwdMode(sourceMeta)
  const sourceWorkbenchDir = resolveAgentWorkbenchDir(workspace, sourceMeta.id)
  const {
    bindProductionAgentSessionTargetForLaunch,
    bindProductionVerifiedIsolatedTarget,
    resolvePiForkTargetChoice,
    resolveProductionAgentSessionTarget,
  } = await import('./agent-session-target.ts')
  const sourceTarget = await resolveProductionAgentSessionTarget({
    sessionId: sourceMeta.id,
    workspace,
    agentCwdMode: sourceCwdMode,
  })
  const sourceDir = sourceTarget.cwd
  const { getSessionCheckoutModule } = await import('./session-checkout/production.ts')
  const checkout = getSessionCheckoutModule()
  const sourceTargetView = await checkout.inspect(sourceMeta.id)
  const forkTargetChoice = hostPiForkPoint
    ? { kind: 'isolated' as const }
    : resolvePiForkTargetChoice(
        sourceMeta.id,
        input.target,
        sourceTargetView,
      )
  if (hostPiForkPoint && forkTargetChoice.kind !== 'isolated') {
    throw new Error('可信 Pi handoff fork point 仅允许创建 Isolated Target')
  }
  const forkTitle = forkTargetChoice.kind === 'isolated-copy'
    ? `${sourceMeta.title} (worktree copy)`
    : input.target?.kind === 'isolated'
      ? `${sourceMeta.title} (worktree)`
      : `${sourceMeta.title} (fork)`
  const newMeta = createAgentSession(forkTitle, sourceMeta.channelId, sourceMeta.workspaceId, forkModelId, sourceCwdMode)
  const destWorkbenchDir = resolveAgentWorkbenchDir(workspace, newMeta.id)
  const sessionDir = join(getSdkConfigDir(), 'sessions')
  let branchFile: string | undefined
  let piSessionFile: string | undefined

  try {
    updateAgentSessionMeta(newMeta.id, {
      executionPolicy: sourceMeta.executionPolicy,
      workflow: sourceMeta.workflow,
      permissionMode: sourceMeta.permissionMode,
      parentSessionId: sourceMeta.id,
      rootSessionId: sourceMeta.rootSessionId ?? sourceMeta.id,
    })
    if (hostPiForkPoint) {
      await bindProductionVerifiedIsolatedTarget(newMeta.id, {
        expectedCurrentOid: hostPiForkPoint.expectedCurrentOid,
        dirtyConfirmed: hostPiForkPoint.dirtyConfirmed,
      })
    } else if (forkTargetChoice.kind === 'isolated-copy') {
      await checkout.cloneIsolatedTarget(
        forkTargetChoice.parentSessionId,
        newMeta.id,
        forkTargetChoice.expectedSourceRevision,
      )
    } else {
      await bindProductionAgentSessionTargetForLaunch({
        sessionId: newMeta.id,
        choice: forkTargetChoice,
      })
    }
    const destTarget = await resolveProductionAgentSessionTarget({
      sessionId: newMeta.id,
      workspace,
      agentCwdMode: newMeta.agentCwdMode,
    })
    const destDir = destTarget.cwd
    let sdk: typeof import('@earendil-works/pi-coding-agent')
    try {
      sdk = await import('@earendil-works/pi-coding-agent')
    } catch (error) {
      throw new PiForkUnavailableError('branch_creation_failed', 'Pi SessionManager 当前不可用，不能继承完整历史', { cause: error })
    }
    let sourceManager: ReturnType<typeof sdk.SessionManager.open>
    try {
      sourceManager = sdk.SessionManager.open(sourceMeta.piSessionFile, sessionDir, sourceDir)
    } catch (error) {
      throw new PiForkUnavailableError('session_artifact_unreadable', 'Pi session artifact 无法读取，不能继承完整历史', { cause: error })
    }
    let forkEntry: ReturnType<typeof sourceManager.getEntry>
    try {
      forkEntry = sourceManager.getEntry(entryId)
    } catch (error) {
      throw new PiForkUnavailableError('session_artifact_unreadable', 'Pi session entry 无法读取，不能继承完整历史', { cause: error })
    }
    const expectedEntryRole = hostPiForkPoint?.expectedEntryRole ?? 'toolResult'
    if (!forkEntry || (hostPiForkPoint && (forkEntry.type !== 'message' || forkEntry.message.role !== expectedEntryRole))) {
      throw new PiForkUnavailableError('safe_fork_point_unavailable', `Pi handoff 的 ${expectedEntryRole} entry 无效，不能继承完整历史`)
    }
    try {
      branchFile = sourceManager.createBranchedSession(entryId)
    } catch (error) {
      throw new PiForkUnavailableError('branch_creation_failed', 'Pi 无法创建 branched session，不能继承完整历史', { cause: error })
    }
    if (!branchFile || !existsSync(branchFile)) {
      throw new PiForkUnavailableError('branch_creation_failed', 'Pi 未能生成 branched session artifact，不能继承完整历史')
    }
    let forkedManager: ReturnType<typeof sdk.SessionManager.forkFrom>
    try {
      forkedManager = sdk.SessionManager.forkFrom(branchFile, destDir ?? sourceDir ?? process.cwd(), sessionDir)
    } catch (error) {
      throw new PiForkUnavailableError('fork_artifact_invalid', 'Pi branched session artifact 无法恢复，不能继承完整历史', { cause: error })
    }
    try {
      piSessionFile = forkedManager.getSessionFile()
    } catch (error) {
      throw new PiForkUnavailableError('fork_artifact_invalid', 'Pi 分叉 artifact 无法读取，不能继承完整历史', { cause: error })
    }
    if (!piSessionFile || !existsSync(piSessionFile)) {
      throw new PiForkUnavailableError('fork_artifact_invalid', 'Pi 分叉 artifact 校验失败，不能继承完整历史')
    }

    updateAgentSessionMeta(newMeta.id, {
      sdkSessionId: forkedManager.getSessionId(),
      piSessionFile,
      piEntryBindings: { ...(sourceMeta.piEntryBindings ?? {}) },
      forkSourceDir: sourceDir,
    })
    newMeta.sdkSessionId = forkedManager.getSessionId()
    newMeta.piSessionFile = piSessionFile
    newMeta.piEntryBindings = { ...(sourceMeta.piEntryBindings ?? {}) }

    if (sourceWorkbenchDir && destWorkbenchDir) {
      copyRequiredForkSessionContext(sourceWorkbenchDir, destWorkbenchDir)
      const copyResult = copyForkWorkspaceFiles(sourceWorkbenchDir, destWorkbenchDir, { skipSessionContext: true })
      if (copyResult.failedCount > 0) {
        console.warn(`[Agent 会话] Pi fork 非关键工作台文件有 ${copyResult.failedCount} 个条目复制失败`)
      }
    }
    await copyForkStoredSDKMessages({
      sourceSessionId: sourceMeta.id,
      destSessionId: newMeta.id,
      upToMessageUuid: hostPiForkPoint?.uiUpToMessageUuid ?? targetUuid,
      sourceDir,
      destDir,
    })
    return getAgentSessionMeta(newMeta.id) ?? newMeta
  } catch (error) {
    try {
      await rollbackUnpublishedPiForkSession(newMeta.id)
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Fork 失败且自动回滚未完成；已保留会话 ${newMeta.id} 供恢复，请勿重复创建`,
      )
    }
    removeFailedPiForkArtifacts({
      artifacts: [branchFile, piSessionFile],
      sessionDir,
      sourceSessionFile: sourceMeta.piSessionFile,
    })
    throw error
  }
}

/**
 * 回滚尚未向 renderer 发布的 Pi fork。
 * 新 Isolated checkout 在此阶段没有 Agent 运行；先精确 Discard owner checkout，再走普通删除释放 binding。
 */
export async function rollbackUnpublishedPiForkSession(sessionId: string): Promise<void> {
  const { getSessionCheckoutModule } = await import('./session-checkout/production.ts')
  const checkout = getSessionCheckoutModule()
  let target: Awaited<ReturnType<typeof checkout.inspect>> | undefined
  try {
    target = await checkout.inspect(sessionId)
  } catch {
    // bind 前失败时没有 Session Target，普通删除仍可安全清理索引与工作台。
  }

  if (target?.checkout.kind === 'isolated' && target.ownership === 'owner') {
    const result = await checkout.operate({
      action: 'discard',
      sessionId,
      expectedRevision: target.revision,
      confirmDirty: true,
    })
    if (result.status !== 'discarded') {
      const detail = 'message' in result ? result.message : result.status
      throw new Error(`回滚 managed checkout 失败：${detail}`)
    }
  }
  await deleteAgentSession(sessionId)
  if (getAgentSessionMeta(sessionId)) throw new Error('回滚后会话记录仍然存在')
}

function removeFailedPiForkArtifacts(input: {
  artifacts: Array<string | undefined>
  sessionDir: string
  sourceSessionFile: string
}): void {
  const root = resolve(input.sessionDir)
  const source = resolve(input.sourceSessionFile)
  const normalizeForComparison = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value

  for (const artifact of new Set(input.artifacts.filter((value): value is string => Boolean(value)))) {
    const candidate = resolve(artifact)
    const relativePath = relative(root, candidate)
    const insideSessionDir = relativePath !== '..'
      && !relativePath.startsWith(`..${sep}`)
      && !isAbsolute(relativePath)
    if (!insideSessionDir || normalizeForComparison(candidate) === normalizeForComparison(source)) continue
    try {
      if (existsSync(candidate)) unlinkSync(candidate)
    } catch (cleanupError) {
      console.warn(`[Agent 会话] 清理失败 Pi fork artifact 失败 (${candidate}):`, cleanupError)
    }
  }
}

export interface PreparedPiAgentSessionRewind {
  sourceState: PiSessionRewindStateSnapshot
  rewoundState: PiSessionRewindStateSnapshot
  commit(): void
  rollback(): void
}

export interface PreparedPiAgentSessionRestore {
  commit(): void
  rollback(): void
  finalize(): void
}

function piSessionState(meta: AgentSessionMeta): PiSessionRewindStateSnapshot {
  if (!meta.piSessionFile) throw new Error('未找到 Pi session artifact')
  return {
    sdkSessionId: meta.sdkSessionId,
    piSessionFile: meta.piSessionFile,
    piEntryBindings: meta.piEntryBindings,
    piTreeActiveLeafId: meta.piTreeActiveLeafId,
  }
}

function assertSafePiSessionArtifact(filePath: string, label: string): void {
  const sessionRoot = resolve(join(getSdkConfigDir(), 'sessions'))
  const candidate = resolve(filePath)
  const relativePath = relative(sessionRoot, candidate)
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${label}已越过 Pi session 目录`)
  }
  try {
    const rootMetadata = lstatSync(sessionRoot)
    const candidateMetadata = lstatSync(candidate)
    if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory() || candidateMetadata.isSymbolicLink() || !candidateMetadata.isFile()) {
      throw new Error('unsafe artifact type')
    }
    const realRoot = realpathSync.native(sessionRoot)
    const realCandidate = realpathSync.native(candidate)
    const realRelative = relative(realRoot, realCandidate)
    if (realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
      throw new Error('artifact escaped through link')
    }
  } catch (error) {
    throw new Error(`${label}不安全或不可用：${error instanceof Error ? error.message : String(error)}`)
  }
}

function piStatesEqual(left: PiSessionRewindStateSnapshot, right: PiSessionRewindStateSnapshot): boolean {
  const normalizePath = (value: string): string => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
  return left.sdkSessionId === right.sdkSessionId
    && normalizePath(left.piSessionFile) === normalizePath(right.piSessionFile)
    && left.piTreeActiveLeafId === right.piTreeActiveLeafId
    && JSON.stringify(left.piEntryBindings ?? {}) === JSON.stringify(right.piEntryBindings ?? {})
}

/** 创建 Pi branch artifact，但在 commit 前不改变当前会话 metadata。 */
export async function preparePiAgentSessionRewind(
  sessionId: string,
  assistantMessageUuid: string,
): Promise<PreparedPiAgentSessionRewind> {
  const meta = getAgentSessionMeta(sessionId)
  if (!meta) throw new Error('Agent 会话不存在')
  const entryId = meta.piEntryBindings?.[assistantMessageUuid]
  if (!entryId) throw new Error('该 Pi 历史消息尚无 entry ID 映射，无法安全回退')
  if (!meta.piSessionFile || !existsSync(meta.piSessionFile)) throw new Error('未找到 Pi session artifact，无法安全回退')
  const workspace = meta.workspaceId ? getAgentWorkspace(meta.workspaceId) : undefined
  const { resolveProductionAgentSessionTarget } = await import('./agent-session-target.ts')
  const target = await resolveProductionAgentSessionTarget({
    sessionId: meta.id,
    workspace,
    agentCwdMode: meta.agentCwdMode,
  })
  const cwd = target.cwd
  const sdk = await import('@earendil-works/pi-coding-agent')
  const sessionDir = join(getSdkConfigDir(), 'sessions')
  const manager = sdk.SessionManager.open(meta.piSessionFile, sessionDir, cwd)
  const branchFile = manager.createBranchedSession(entryId)
  if (!branchFile || !existsSync(branchFile)) throw new Error('Pi 未能生成回退 session artifact')
  const rewindManager = sdk.SessionManager.open(branchFile, sessionDir, cwd)
  const retainedBindings = Object.fromEntries(
    Object.entries(meta.piEntryBindings ?? {}).filter(([, mappedEntryId]) => Boolean(rewindManager.getEntry(mappedEntryId))),
  )
  const sourceState = piSessionState(meta)
  const rewoundState: PiSessionRewindStateSnapshot = {
    sdkSessionId: rewindManager.getSessionId(),
    piSessionFile: branchFile,
    piEntryBindings: retainedBindings,
    piTreeActiveLeafId: meta.piTreeActiveLeafId,
  }
  let committed = false
  return {
    sourceState,
    rewoundState,
    commit() {
      if (committed) return
      updateAgentSessionMeta(sessionId, rewoundState)
      committed = true
    },
    rollback() {
      if (committed) {
        updateAgentSessionMeta(sessionId, sourceState)
        committed = false
      }
      removeFailedPiForkArtifacts({
        artifacts: [branchFile],
        sessionDir,
        sourceSessionFile: meta.piSessionFile!,
      })
    },
  }
}

export function preparePiAgentSessionRestore(
  sessionId: string,
  sourceState: PiSessionRewindStateSnapshot,
  rewoundState: PiSessionRewindStateSnapshot,
): PreparedPiAgentSessionRestore {
  const meta = getAgentSessionMeta(sessionId)
  if (!meta) throw new Error('Agent 会话不存在')
  const current = piSessionState(meta)
  if (!piStatesEqual(current, rewoundState)) throw new Error('当前 Pi session 已变化，无法撤销回退')
  assertSafePiSessionArtifact(sourceState.piSessionFile, '回退前 Pi session artifact')
  assertSafePiSessionArtifact(rewoundState.piSessionFile, '当前回退 Pi session artifact')
  const sessionDir = join(getSdkConfigDir(), 'sessions')
  let committed = false
  return {
    commit() {
      if (committed) return
      updateAgentSessionMeta(sessionId, sourceState)
      committed = true
    },
    rollback() {
      if (!committed) return
      updateAgentSessionMeta(sessionId, rewoundState)
      committed = false
    },
    finalize() {
      if (!committed) return
      removeFailedPiForkArtifacts({
        artifacts: [rewoundState.piSessionFile],
        sessionDir,
        sourceSessionFile: sourceState.piSessionFile,
      })
    },
  }
}

export function preparePiAgentSessionRecovery(
  sessionId: string,
  targetState: PiSessionRewindStateSnapshot,
  sourceState: PiSessionRewindStateSnapshot,
  rewoundState: PiSessionRewindStateSnapshot,
): PreparedPiAgentSessionRestore {
  const meta = getAgentSessionMeta(sessionId)
  if (!meta) throw new Error('Agent 会话不存在')
  const current = piSessionState(meta)
  if (!piStatesEqual(current, sourceState) && !piStatesEqual(current, rewoundState)) {
    throw new Error('当前 Pi session 不属于待恢复回退事务')
  }
  assertSafePiSessionArtifact(targetState.piSessionFile, '目标 Pi session artifact')
  assertSafePiSessionArtifact(current.piSessionFile, '当前 Pi session artifact')
  let committed = false
  return {
    commit() {
      if (committed) return
      if (!piStatesEqual(current, targetState)) updateAgentSessionMeta(sessionId, targetState)
      committed = true
    },
    rollback() {
      if (!committed) return
      if (!piStatesEqual(current, targetState)) updateAgentSessionMeta(sessionId, current)
      committed = false
    },
    finalize() { /* recovery never deletes either durable branch artifact */ },
  }
}

/** 兼容旧调用：立即提交已准备的 Pi branch。 */
export async function rewindPiAgentSession(sessionId: string, assistantMessageUuid: string): Promise<void> {
  const prepared = await preparePiAgentSessionRewind(sessionId, assistantMessageUuid)
  prepared.commit()
}

interface ForkStoredMessageRef {
  uuid: string
  sessionId?: string
}

interface ForkTargetResolution {
  effectiveUpToMessageUuid: string
  effectiveSdkSessionId?: string
  usedSidechainFallback: boolean
}

async function resolveForkTargetFromStoredMessages(
  sessionId: string,
  upToMessageUuid: string,
): Promise<ForkTargetResolution> {
  const filePath = getAgentSessionMessagesPath(sessionId)
  if (!existsSync(filePath)) {
    throw new Error('未在会话历史中找到指定的消息，可能消息已被清理或截断')
  }

  let lastMainlineAssistant: ForkStoredMessageRef | undefined
  let target: (ForkStoredMessageRef & {
    isSidechain: boolean
    fallbackMainline?: ForkStoredMessageRef
  }) | undefined

  for await (const msg of readStoredSDKMessages(filePath)) {
    const uuid = getStoredMessageUuid(msg)
    const isMainlineAssistant = msg.type === 'assistant'
      && !!uuid
      && !((msg as { parent_tool_use_id?: string | null }).parent_tool_use_id)

    if (uuid === upToMessageUuid) {
      target = {
        uuid,
        sessionId: (msg as { session_id?: string }).session_id,
        isSidechain: msg.type === 'assistant'
          && Boolean((msg as { parent_tool_use_id?: string | null }).parent_tool_use_id),
        fallbackMainline: lastMainlineAssistant,
      }
    }

    if (isMainlineAssistant) {
      lastMainlineAssistant = {
        uuid,
        sessionId: (msg as { session_id?: string }).session_id,
      }
    }
  }

  if (!target) {
    throw new Error('未在会话历史中找到指定的消息，可能消息已被清理或截断')
  }

  if (target.isSidechain) {
    if (!target.fallbackMainline) {
      throw new Error('选中的是子代理执行过程中的消息，且向前找不到可分叉的主对话消息')
    }
    return {
      effectiveUpToMessageUuid: target.fallbackMainline.uuid,
      effectiveSdkSessionId: target.fallbackMainline.sessionId,
      usedSidechainFallback: true,
    }
  }

  return {
    effectiveUpToMessageUuid: target.uuid,
    effectiveSdkSessionId: target.sessionId,
    usedSidechainFallback: false,
  }
}

interface CopyForkStoredSDKMessagesInput {
  sourceSessionId: string
  destSessionId: string
  upToMessageUuid?: string
  sourceDir?: string
  destDir?: string
}

async function copyForkStoredSDKMessages({
  sourceSessionId,
  destSessionId,
  upToMessageUuid,
  sourceDir,
  destDir,
}: CopyForkStoredSDKMessagesInput): Promise<number> {
  const sourcePath = getAgentSessionMessagesPath(sourceSessionId)
  if (!existsSync(sourcePath)) return 0

  const destPath = getAgentSessionMessagesPath(destSessionId)
  const out = createWriteStream(destPath, { flags: 'a', encoding: 'utf-8' })
  let copiedCount = 0

  try {
    for await (const msg of readStoredSDKMessages(sourcePath)) {
      await writeJsonlLine(out, serializeSDKMessageForStorage(msg, sourceDir, destDir))
      copiedCount += 1

      if (upToMessageUuid && getStoredMessageUuid(msg) === upToMessageUuid) {
        break
      }
    }
    await endWriteStream(out)
  } catch (err) {
    out.destroy()
    throw err
  }

  return copiedCount
}

async function* readStoredSDKMessages(filePath: string): AsyncGenerator<SDKMessage> {
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if ('role' in parsed && !('type' in parsed)) {
        yield convertLegacyMessage(parsed as AgentMessage)
      } else {
        yield parsed as SDKMessage
      }
    } catch (err) {
      console.warn(`[Agent 会话] 跳过无法解析的 SDKMessage 行 (${filePath}):`, err)
    }
  }
}

function getStoredMessageUuid(msg: SDKMessage): string | undefined {
  return 'uuid' in msg ? (msg as { uuid?: string }).uuid : undefined
}

function serializeSDKMessageForStorage(
  msg: SDKMessage,
  sourceDir?: string,
  destDir?: string,
): string {
  let serialized = JSON.stringify(msg)
  if (sourceDir && destDir) {
    serialized = rewriteSourceToDest(serialized, sourceDir, destDir)
  }
  if (serialized.length <= MAX_SDK_MESSAGE_LENGTH) return serialized

  let sanitized = JSON.stringify(sanitizeOversizedMessage(msg, serialized.length))
  if (sourceDir && destDir) {
    sanitized = rewriteSourceToDest(sanitized, sourceDir, destDir)
  }
  if (sanitized.length > MAX_SDK_MESSAGE_LENGTH) {
    console.warn(`[Agent 会话] 消息截断后仍超限 (${(sanitized.length / 1024).toFixed(0)}K chars)`)
  }
  return sanitized
}

async function copyTextFileWithPathRewrite(
  sourcePath: string,
  destPath: string,
  sourceDir: string,
  destDir: string,
): Promise<number> {
  const rl = createInterface({
    input: createReadStream(sourcePath),
    crlfDelay: Infinity,
  })
  const out = createWriteStream(destPath, { flags: 'w', encoding: 'utf-8' })
  let lineCount = 0

  try {
    for await (const line of rl) {
      await writeJsonlLine(out, rewriteSourceToDest(line, sourceDir, destDir))
      lineCount += 1
    }
    await endWriteStream(out)
  } catch (err) {
    out.destroy()
    throw err
  }

  return lineCount
}

async function writeJsonlLine(stream: WriteStream, line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(line + '\n', (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

async function endWriteStream(stream: WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once('error', reject)
    stream.end(resolve)
  })
}

/**
 * 将一段字符串中所有出现的 sourceDir 替换为 destDir。
 *
 * 用于 fork 会话时把历史中嵌入的源会话绝对路径迁移到新会话目录。
 * 处理 JSON 字符串中可能出现的两种编码形式：
 * 1. 原始路径（如 /Users/a/b）
 * 2. JSON 字符串编码后的形式（路径中的 `/` JSON 标准下不会转义，所以通常与 1 一致；
 *    但保留对反斜杠的处理以兼容 Windows 路径）
 *
 * sourceDir 和 destDir 都会规范化去除末尾斜杠，避免不同形式导致漏替换。
 */
function rewriteSourceToDest(content: string, sourceDir: string, destDir: string): string {
  const normalizedSource = sourceDir.replace(/[\\/]+$/, '')
  const normalizedDest = destDir.replace(/[\\/]+$/, '')
  if (!normalizedSource || normalizedSource === normalizedDest) return content
  let rewritten = content.split(normalizedSource).join(normalizedDest)
  // Windows 路径在 JSON 中会被转义为双反斜杠，单独处理一次
  if (normalizedSource.includes('\\')) {
    const sourceEscaped = normalizedSource.replace(/\\/g, '\\\\')
    const destEscaped = normalizedDest.replace(/\\/g, '\\\\')
    rewritten = rewritten.split(sourceEscaped).join(destEscaped)
  }
  return rewritten
}

export interface PreparedSDKMessageTruncation {
  kept: SDKMessage[]
  originalContent: string
  rewoundContent: string
  commit(): void
  rollback(): void
}

export interface PreparedSDKMessageRestore {
  commit(): void
  rollback(): void
}

/** 严格解析并准备 transcript 截断；commit 前不改原文件，rollback 可恢复已提交内容。 */
export function prepareSDKMessageTruncation(
  id: string,
  upToUuidInclusive: string,
): PreparedSDKMessageTruncation {
  const filePath = getAgentSessionMessagesPath(id)
  if (!existsSync(filePath)) {
    throw new Error(`[Agent 会话] 截断失败: 会话消息文件不存在, sessionId=${id}`)
  }

  const raw = readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n').filter((line) => line.trim())
  const messages = parseJsonlStrict<unknown>(lines, `截断读取 SDKMessage (${id})`).map(normalizePersistedSDKMessage)
  const cutIndex = messages.findIndex(
    (m) => 'uuid' in m && (m as { uuid?: string }).uuid === upToUuidInclusive,
  )
  if (cutIndex < 0) {
    throw new Error(`[Agent 会话] 截断失败: 未找到 uuid=${upToUuidInclusive}, sessionId=${id}`)
  }
  const kept = messages.slice(0, cutIndex + 1)
  const content = kept.map((m) => JSON.stringify(m)).join('\n') + (kept.length > 0 ? '\n' : '')
  let committed = false
  return {
    kept,
    originalContent: raw,
    rewoundContent: content,
    commit() {
      if (committed) return
      writeTextFileAtomic(filePath, content)
      committed = true
      console.log(`[Agent 会话] 消息已截断: sessionId=${id}, 保留 ${kept.length}/${messages.length} 条`)
    },
    rollback() {
      if (!committed) return
      writeTextFileAtomic(filePath, raw)
      committed = false
    },
  }
}

export function prepareSDKMessageRestore(id: string, restoredContent: string): PreparedSDKMessageRestore {
  const filePath = getAgentSessionMessagesPath(id)
  if (!existsSync(filePath)) throw new Error(`[Agent 会话] 恢复失败: 会话消息文件不存在, sessionId=${id}`)
  const restoredLines = restoredContent.split('\n').filter((line) => line.trim())
  parseJsonlStrict<unknown>(restoredLines, `恢复读取 SDKMessage (${id})`).map(normalizePersistedSDKMessage)
  const currentContent = readFileSync(filePath, 'utf8')
  let committed = false
  return {
    commit() {
      if (committed) return
      writeTextFileAtomic(filePath, restoredContent)
      committed = true
    },
    rollback() {
      if (!committed) return
      writeTextFileAtomic(filePath, currentContent)
      committed = false
    },
  }
}

export function truncateSDKMessages(id: string, upToUuidInclusive: string): SDKMessage[] {
  const prepared = prepareSDKMessageTruncation(id, upToUuidInclusive)
  prepared.commit()
  return prepared.kept
}

/**
 * 删除指定 UUID 的持久化错误消息。
 *
 * 仅删除 assistant error，避免调用方误删普通回复；找不到时保持幂等。
 */
export function removeSDKErrorMessage(id: string, errorUuid: string): boolean {
  const filePath = getAgentSessionMessagesPath(id)
  if (!existsSync(filePath)) return false

  const raw = readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n').filter((line) => line.trim())
  const messages = parseJsonlStrict<unknown>(lines, `删除错误消息 (${id})`).map(normalizePersistedSDKMessage)
  const targetIndex = messages.findIndex((message) =>
    message.type === 'assistant'
      && (message as { uuid?: string }).uuid === errorUuid
      && Boolean((message as { error?: unknown }).error),
  )
  if (targetIndex < 0) return false

  const kept = messages.filter((_, index) => index !== targetIndex)
  const content = kept.map((message) => JSON.stringify(message)).join('\n') + (kept.length > 0 ? '\n' : '')
  writeTextFileAtomic(filePath, content)
  console.log(`[Agent 会话] 已删除重试前错误: sessionId=${id}, uuid=${errorUuid}`)
  return true
}

/**
 * 自动归档超过指定天数未更新的 Agent 会话
 *
 * 置顶会话不会被归档。
 *
 * @param daysThreshold 天数阈值
 * @returns 本次归档的会话数量
 */
export function autoArchiveAgentSessions(daysThreshold: number): number {
  const index = readIndex()
  const threshold = Date.now() - daysThreshold * 86_400_000
  let count = 0

  for (const session of index.sessions) {
    if (!session.pinned && !session.archived && session.updatedAt < threshold) {
      session.archived = true
      count++
    }
  }

  if (count > 0) {
    writeIndex(index)
    console.log(`[Agent 会话] 自动归档 ${count} 个会话（阈值: ${daysThreshold} 天）`)
  }

  return count
}

/**
 * 启动时收敛遗留的委派子会话状态
 *
 * 委派子会话的运行态只在主进程内存中维护，应用退出后无法续跑。
 * 若上次退出时仍有 delegationStatus 为 'running' 的子会话，本次启动需要
 * 把它们标记为 'interrupted'，避免状态永久卡在 running、父会话也无法收敛。
 *
 * @returns 被标记为中断的子会话数量
 */
export function markRunningDelegationsAsInterrupted(): number {
  const index = readIndex()
  let count = 0

  for (const session of index.sessions) {
    if (session.sourceDelegationId && session.delegationStatus === 'running') {
      session.delegationStatus = 'interrupted'
      session.updatedAt = Date.now()
      count++
    }
  }

  if (count > 0) {
    writeIndex(index)
    console.log(`[Agent 会话] 启动收敛 ${count} 个遗留的运行中委派子会话为 interrupted`)
  }

  return count
}

/**
 * 清理所有会话中不存在的附加目录和附加文件
 * @returns 清理的条目总数
 */
export function cleanupStaleAttachedPaths(): number {
  const index = readIndex()
  let count = 0

  for (const session of index.sessions) {
    let changed = false

    if (session.attachedDirectories?.length) {
      const valid = session.attachedDirectories.filter((d) => existsSync(d))
      if (valid.length < session.attachedDirectories.length) {
        count += session.attachedDirectories.length - valid.length
        session.attachedDirectories = valid.length > 0 ? valid : undefined
        changed = true
      }
    }

    if (session.attachedFiles?.length) {
      const valid = session.attachedFiles.filter((f) => existsSync(f))
      if (valid.length < session.attachedFiles.length) {
        count += session.attachedFiles.length - valid.length
        session.attachedFiles = valid.length > 0 ? valid : undefined
        changed = true
      }
    }

    if (changed) {
      session.updatedAt = Date.now()
    }
  }

  if (count > 0) {
    writeIndex(index)
    console.log(`[Agent 会话] 清理了 ${count} 个不存在的附加路径`)
  }

  return count
}

/**
 *
 * 按行流式读取每个会话的 JSONL 文件，命中即早退。兼容旧 AgentMessage 和新 SDKMessage 格式。
 * 每个会话最多返回 1 条匹配，总计达到 maxResults 即停止扫描后续会话。
 *
 * @param query 搜索关键词
 * @returns 匹配结果列表
 */
export async function searchAgentSessionMessages(query: string): Promise<AgentMessageSearchResult[]> {
  if (!query || query.length < 2) return []

  const index = readIndex()
  const results: AgentMessageSearchResult[] = []
  const queryLower = query.toLowerCase()
  const maxResults = 30

  for (const session of index.sessions) {
    if (results.length >= maxResults) break

    const filePath = getAgentSessionMessagesPath(session.id)
    if (!existsSync(filePath)) continue

    const hit = await findFirstMatchInAgentJsonl(filePath, queryLower, query.length)
    if (hit) {
      results.push({
        sessionId: session.id,
        sessionTitle: session.title,
        messageId: hit.messageId,
        role: hit.role,
        snippet: hit.snippet,
        matchStart: hit.matchStart,
        matchLength: query.length,
        archived: session.archived,
      })
    }
  }

  return results
}

/**
 * 在单个 Agent 会话 JSONL 中按行流式查找第一条匹配。
 *
 * Agent 消息存在两种历史格式（旧 AgentMessage 与新 SDKMessage），都要兼容。
 */
async function findFirstMatchInAgentJsonl(
  filePath: string,
  queryLower: string,
  queryLength: number,
  maxBytes?: number,
): Promise<{ messageId: string; role: AgentMessageSearchResult['role']; snippet: string; matchStart: number } | null> {
  const stream = createReadStream(filePath, {
    encoding: 'utf-8',
    ...(maxBytes ? { end: maxBytes - 1 } : {}),
  })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      let parsed: {
        role?: string
        id?: string
        uuid?: string
        content?: unknown
        message?: { role?: string; id?: string; content?: Array<{ type: string; text?: string }> }
      }
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }

      const rawRole = parsed.role ?? parsed.message?.role ?? 'assistant'
      // 收窄到 AgentMessageSearchResult.role 允许的联合类型；不在白名单的退化为 assistant
      const role: AgentMessageSearchResult['role'] =
        rawRole === 'user' || rawRole === 'assistant' || rawRole === 'tool' || rawRole === 'status'
          ? rawRole
          : 'assistant'
      const messageId = parsed.id ?? parsed.uuid ?? parsed.message?.id ?? ''

      let textContent = ''
      if (typeof parsed.content === 'string') {
        textContent = parsed.content
      } else if (Array.isArray(parsed.message?.content)) {
        textContent = parsed.message.content
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text!)
          .join('\n')
      }
      if (!textContent) continue

      const contentLower = textContent.toLowerCase()
      const matchIndex = contentLower.indexOf(queryLower)
      if (matchIndex === -1) continue

      const snippetStart = Math.max(0, matchIndex - 40)
      const snippetEnd = Math.min(textContent.length, matchIndex + queryLength + 40)
      const snippet = (snippetStart > 0 ? '...' : '') +
        textContent.slice(snippetStart, snippetEnd) +
        (snippetEnd < textContent.length ? '...' : '')
      const matchStart = matchIndex - snippetStart + (snippetStart > 0 ? 3 : 0)

      return { messageId, role, snippet, matchStart }
    }
    return null
  } finally {
    rl.close()
    stream.destroy()
  }
}

async function findSessionMessageSnippet(
  sessionId: string,
  query: string,
  maxBytes?: number,
): Promise<string | undefined> {
  if (!query || query.length < 2) return undefined

  const filePath = getAgentSessionMessagesPath(sessionId)
  if (!existsSync(filePath)) return undefined

  try {
    const hit = await findFirstMatchInAgentJsonl(filePath, query.toLowerCase(), query.length, maxBytes)
    return hit?.snippet
  } catch {
    return undefined
  }
}

function createSessionReferenceSearchResult(
  session: AgentSessionMeta,
  workspacesById: ReadonlyMap<string, { name: string; slug: string }>,
  fields: Pick<AgentSessionReferenceSearchResult, 'matchSource' | 'snippet'>,
): AgentSessionReferenceSearchResult {
  const workspace = session.workspaceId ? workspacesById.get(session.workspaceId) : undefined

  return {
    sessionId: session.id,
    title: session.title,
    ...(workspace ? {
      workspaceName: workspace.name,
      workspaceSlug: workspace.slug,
    } : {}),
    updatedAt: session.updatedAt,
    ...fields,
  }
}

/**
 * 搜索可引用的 Agent 会话。
 *
 * 指定工作区时仅返回该工作区；省略工作区时跨工作区搜索。两种模式都排除已归档和当前会话；无关键词时返回最近更新的会话。
 */
export async function searchAgentSessionReferences(input: AgentSessionReferenceSearchInput): Promise<AgentSessionReferenceSearchResult[]> {
  const workspaceId = input?.workspaceId?.trim()

  const query = (input?.query ?? '').trim()
  const queryLower = query.toLowerCase()
  const requestedLimit = Number.isFinite(input?.limit) ? input.limit! : 20
  const limit = Math.min(Math.max(requestedLimit, 1), MAX_SESSION_REFERENCE_LIMIT)
  const workspacesById = new Map(
    listAgentWorkspaces().map((workspace) => [workspace.id, workspace]),
  )

  const candidates = listAgentSessions()
    .filter((session) => !workspaceId || session.workspaceId === workspaceId)
    .filter((session) => !session.archived)
    .filter((session) => session.id !== input?.excludeSessionId)

  const results: AgentSessionReferenceSearchResult[] = []
  let bodyScanCount = 0

  for (const session of candidates) {
    if (results.length >= limit) break

    if (!queryLower) {
      results.push(createSessionReferenceSearchResult(session, workspacesById, {
        matchSource: 'recent',
      }))
      continue
    }

    if (session.title.toLowerCase().includes(queryLower)) {
      results.push(createSessionReferenceSearchResult(session, workspacesById, {
        matchSource: 'title',
      }))
      continue
    }

    // 即使正文预算耗尽，仍继续遍历，确保较旧但标题命中的会话不会漏掉。
    if (bodyScanCount >= MAX_SESSION_REFERENCE_BODY_SCANS) continue
    bodyScanCount += 1

    const snippet = await findSessionMessageSnippet(
      session.id,
      query,
      MAX_SESSION_REFERENCE_BODY_BYTES_PER_FILE,
    )
    if (snippet) {
      results.push(createSessionReferenceSearchResult(session, workspacesById, {
        snippet,
        matchSource: 'message',
      }))
    }
  }

  return results
}

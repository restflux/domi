import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AgentSessionMeta,
  AgentWorkflow,
  ExecutionPolicyMode,
  DomiPermissionMode,
  SDKMessage,
  WorktreeValidationItem,
} from '@domi/shared'
import {
  createAgentSession,
  forkAgentSession,
  getAgentCwdMode,
  getAgentSessionMeta,
  getAgentSessionSDKMessagesRaw,
  listAgentSessions,
  resolveAgentWorkbenchDir,
  rollbackUnpublishedPiForkSession,
  updateAgentSessionMeta,
  isPiForkUnavailableError,
  type HostPiForkPoint,
  type PiForkUnavailableReason,
} from './agent-session-manager.ts'
import { getAgentWorkspace } from './agent-workspace-manager.ts'
import {
  bindProductionAgentSessionTargetForLaunch,
  bindProductionVerifiedIsolatedTarget,
} from './agent-session-target.ts'
import { runRegisteredHeadlessAgent } from './agent-headless-runner-registry.ts'
import { isAgentSessionActive } from './agent-service.ts'
import { getSessionCheckoutModule } from './session-checkout/production.ts'
import { SessionCheckoutError, type SessionHandoffSnapshot, type WorktreeRecoveryHandoffSnapshot } from './session-checkout/index.ts'

export type { SessionHandoffSnapshot, WorktreeRecoveryHandoffSnapshot } from './session-checkout/index.ts'

export type AgentSessionHandoffTargetKind = 'local' | 'isolated'
export type AgentSessionHandoffMode = 'fork' | 'degraded'
export type AgentSessionHandoffDegradedReason = PiForkUnavailableReason

export type AgentSessionHandoffForkPoint =
  | { status: 'available'; assistantMessageUuid: string; piEntryId: string }
  | { status: 'unavailable'; reason: AgentSessionHandoffDegradedReason }

export interface PrepareAgentSessionHandoffInput {
  originSessionId: string
  expectedRevision: number
  targetKind: AgentSessionHandoffTargetKind
  confirmedIgnoreDirtyLocal: boolean
}

export interface PrepareAgentWorktreeRecoveryHandoffInput {
  originSessionId: string
  expectedRevision: number
  confirmedIgnoreDirtyLocal: boolean
}

export interface PreparedAgentSessionHandoff {
  child: AgentSessionMeta
  handoffId: string
  reused: boolean
  mode: AgentSessionHandoffMode
  degradedReason?: AgentSessionHandoffDegradedReason
  activationToken: string
  launch(): void
}

export type PreparedAgentWorktreeRecoveryHandoff = PreparedAgentSessionHandoff

export interface AgentSessionHandoffDependencies {
  getSession(sessionId: string): AgentSessionMeta | undefined
  getExistingHandoffSession(handoffId: string): AgentSessionMeta | undefined
  isSessionActive(sessionId: string): boolean
  captureSnapshot(sessionId: string, expectedRevision: number): Promise<SessionHandoffSnapshot>
  findForkPoint(session: AgentSessionMeta): AgentSessionHandoffForkPoint
  exportFallbackContext(session: AgentSessionMeta): string
  writeHandoff(session: AgentSessionMeta, handoffId: string, markdown: string): Promise<{ sourcePath: string; relativePath: string }>
  forkSession(input: {
    sessionId: string
    upToMessageUuid: string
    modelId?: string
    target: { kind: 'inherit' } | { kind: 'isolated'; confirmDirty: boolean }
  }, hostPiForkPoint?: HostPiForkPoint): Promise<AgentSessionMeta>
  createFallbackSession(source: AgentSessionMeta): AgentSessionMeta
  bindFallbackSession(
    child: AgentSessionMeta,
    targetKind: AgentSessionHandoffTargetKind,
    snapshot: SessionHandoffSnapshot,
  ): Promise<AgentSessionMeta>
  updateSession(sessionId: string, updates: Partial<AgentSessionMeta>): AgentSessionMeta
  resolveChildHandoffPath(child: AgentSessionMeta, relativePath: string): string
  ensureChildHandoff?(sourcePath: string, childPath: string): Promise<void>
  rollbackFork(sessionId: string): Promise<void>
  runChild(
    input: Parameters<typeof runRegisteredHeadlessAgent>[0],
    callbacks: Parameters<typeof runRegisteredHeadlessAgent>[1],
  ): Promise<void>
  createActivationToken(): string
}

export type AgentWorktreeRecoveryHandoffDependencies = AgentSessionHandoffDependencies

function compactLine(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() || '未记录'
}

function markdownList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- \`${item}\``).join('\n') : '- 无'
}

function validationList(tests: WorktreeValidationItem[]): string {
  return tests.length > 0
    ? tests.map((test) => `- **${test.status}** \`${test.command}\`${test.summary ? ` — ${test.summary}` : ''}`).join('\n')
    : '- 未记录验证命令'
}

const FALLBACK_CONTEXT_MAX_CHARS = 36_000
const FALLBACK_CONTEXT_MAX_MESSAGES = 24
const FALLBACK_CONTEXT_MAX_MESSAGE_CHARS = 3_000

function redactHostPaths(value: string): string {
  return value
    .replace(/\b[A-Za-z]:[\\/][^\s<>"'`]+/g, '[host-path]')
    .replace(/\/(?:Users|home)\/[^\s<>"'`]+/g, '[host-path]')
}

function messageText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const envelope = message as { type?: unknown; message?: { content?: unknown }; content?: unknown }
  const content = Array.isArray(envelope.message?.content)
    ? envelope.message.content
    : Array.isArray(envelope.content) ? envelope.content : []
  const text = content
    .filter((block): block is { type: 'text'; text: string } => (
      Boolean(block) && typeof block === 'object'
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ))
    .map((block) => block.text)
    .join('\n')
    .trim()
  return redactHostPaths(text)
}

/** fork artifact 不可用时，从宿主持久化 sidecar 导出有界、纯文本、可审计的上下文。 */
export function exportBoundedSessionContext(messages: SDKMessage[]): string {
  const entries = messages.flatMap((message, index) => {
    const role = message?.type === 'user' ? '用户' : message?.type === 'assistant' ? 'Agent' : undefined
    if (!role) return []
    const text = messageText(message)
    if (!text) return []
    return [{ index, role, text: text.slice(0, FALLBACK_CONTEXT_MAX_MESSAGE_CHARS) }]
  })
  const firstUser = entries.find((entry) => entry.role === '用户')
  const header = '## 降级会话上下文（有界导出）\n\n'
  const budget = FALLBACK_CONTEXT_MAX_CHARS - header.length - 1
  const selectedRecent: typeof entries = []
  let used = firstUser ? `### ${firstUser.role}\n\n${firstUser.text}`.length + 2 : 0
  for (let index = entries.length - 1; index >= 0 && selectedRecent.length < FALLBACK_CONTEXT_MAX_MESSAGES; index -= 1) {
    const entry = entries[index]!
    if (firstUser && entry.index === firstUser.index) continue
    const renderedLength = `### ${entry.role}\n\n${entry.text}`.length + 2
    if (used + renderedLength > budget && selectedRecent.length > 0) continue
    selectedRecent.push(entry)
    used += Math.min(renderedLength, Math.max(0, budget - used))
    if (used >= budget) break
  }
  selectedRecent.reverse()
  const selected = firstUser ? [firstUser, ...selectedRecent] : selectedRecent
  const body = selected.map((entry) => `### ${entry.role}\n\n${entry.text}`).join('\n\n')
  return `${header}${body.slice(0, budget)}\n`
}

interface SessionHandoffMarkdownOptions {
  mode?: AgentSessionHandoffMode
  degradedReason?: AgentSessionHandoffDegradedReason
  fallbackContext?: string
}

/** 宿主持有的 durable handoff；优先继承完整历史，能力故障时显式携带有界上下文。 */
export function buildSessionHandoffMarkdown(
  snapshot: SessionHandoffSnapshot,
  handoffId: string,
  targetKind: AgentSessionHandoffTargetKind,
  options: SessionHandoffMarkdownOptions = {},
): string {
  const mode = options.mode ?? 'fork'
  const worktreeEvidence = snapshot.originTargetKind === 'isolated'
    ? `## 稳定 Git 恢复证据

- Configured base: \`${snapshot.configuredBaseOid ?? '未记录'}\`
- Effective base: \`${snapshot.effectiveBaseOid ?? '未记录'}\`
- Origin isolated HEAD: \`${snapshot.isolatedHeadOid ?? '未记录'}\`
- Retained task snapshot: \`${snapshot.isolatedSnapshotOid ?? '未记录'}\`
${snapshot.previewWorkingTreeOid ? `- Retained Preview working tree: \`${snapshot.previewWorkingTreeOid}\`\n` : ''}
这些 OID 由 Domi internal refs 保留。旧 Worktree 与已有 Preview receipt 在新交付成功前继续保留；不要访问或修改旧 checkout 路径。`
    : `## Local 来源说明

来源会话直接使用 Local Checkout。Domi 不复制 Local 文件；${mode === 'fork' ? '新会话通过可信 Pi fork 继承完整对话上下文。' : 'Pi fork 不可用，新会话只使用本文档中的有界上下文导出。'}${targetKind === 'isolated' ? '新的 managed Worktree 只从点击时的最新 Local HEAD 创建。' : '新会话继续使用同一个 Local Checkout。'}`

  const contextRule = mode === 'fork'
    ? '先阅读已 fork 的完整对话和本文档，再继续未完成任务；不要重复已经完成的工作。'
    : '这是降级交接，未继承完整 Pi 历史。先阅读本文档中的有界上下文并核对当前状态；不确定的信息不得臆测。'

  const targetRules = targetKind === 'local'
    ? `1. 当前新会话继续使用来源 Local Checkout；不要创建或切换 Worktree。
2. 交接时来源会话已确认空闲。不要并行启动两个 Agent 写同一个 Local。
3. ${contextRule}
4. 保持现有 Local staged、unstaged、untracked 与 Commit 不变，只执行任务要求的后续动作。`
    : `1. 当前 Session Target 已是基于最新 Local HEAD \`${snapshot.localHeadOid}\` 创建的 fresh managed Worktree；只在当前 Worktree 中工作，**不要修改 Local**。
2. ${snapshot.originTargetKind === 'isolated' ? `先比较当前树、最新 Local HEAD 和 \`${snapshot.isolatedSnapshotOid ?? 'retained task snapshot'}\`，只恢复仍缺失的任务增量。不要盲目 cherry-pick。` : `Local dirty 内容没有复制到这里；根据${mode === 'fork' ? '已 fork 的对话上下文' : 'handoff 中的有界上下文'}继续任务，不要猜测或复制未确认的 Local 脏状态。`}
3. ${contextRule}
4. 不要 reset、rebase、force checkout 或改写 Local 历史；真实冲突只在当前 Worktree 内解决。
5. 完成代码修改和验证后调用 \`ReadyForReview\`；不要直接调用 \`ApplyWorktree\` 或 \`FinishWorktree\`，不要删除旧恢复证据。`

  const degradedNotice = mode === 'degraded'
    ? `> **降级交接：未继承完整 Pi 历史**\n>\n> 稳定原因：\`${options.degradedReason ?? 'safe_fork_point_unavailable'}\`。新 Agent 只能依赖下方有界上下文和 Git 证据，必须先核对现状。\n\n${options.fallbackContext?.trim() || '## 降级会话上下文（有界导出）\n\n未读取到可用的持久化文本消息。'}\n\n`
    : ''

  return `# Durable Agent Session Handoff

${degradedNotice}- Handoff mode: **${mode === 'fork' ? '完整 Pi 历史 fork' : '降级上下文交接'}**
- Handoff ID: \`${handoffId}\`
- Origin session: \`${snapshot.originSessionId}\`
- Origin Session Target owner: \`${snapshot.originTargetOwnerSessionId}\`
- Origin target: **${snapshot.originTargetKind === 'isolated' ? 'managed Worktree' : 'Local'}**
- Destination target: **${targetKind === 'isolated' ? 'new managed Worktree' : 'current Local'}**
- Origin checkout: \`${snapshot.originCheckoutId}\` @ revision \`${snapshot.originRevision}\`
- Latest Local ref: \`${snapshot.localHeadRef ?? 'detached'}\`
- Latest Local HEAD: \`${snapshot.localHeadOid}\`
- Local state at handoff: ${snapshot.localDirty ? 'dirty' : 'clean'}
${snapshot.reviewId ? `- Review / Preview: \`${snapshot.reviewId}\` / \`${snapshot.previewId ?? 'none'}\`\n` : ''}${snapshot.detachedReason ? `- Recovery reason: \`${snapshot.detachedReason}\` while \`${snapshot.attemptedAction}\`\n` : ''}
## 原始任务与当前状态

${snapshot.detailsMarkdown?.trim() || snapshot.summary}

任务摘要：${compactLine(snapshot.summary)}

- 已完成事项、关键决定与未完成事项：${mode === 'fork' ? '以已 fork 的来源会话历史及上方验收详情为准。' : '以本文档的有界导出、上方验收详情和当前文件/Git 状态为准。'}
- 新 Agent 必须先核对现状，只继续未完成部分，不要把 handoff 当成待盲目套用的 patch。

${worktreeEvidence}

## 已知相关文件

${markdownList(snapshot.changedFiles)}

## 已有验证

- 状态：**${snapshot.validationStatus}**
- 摘要：${compactLine(snapshot.validationSummary)}

${validationList(snapshot.tests)}

## 继续执行规则

${targetRules}
`
}

export function buildWorktreeRecoveryHandoffMarkdown(snapshot: WorktreeRecoveryHandoffSnapshot, handoffId: string): string {
  return buildSessionHandoffMarkdown(snapshot, handoffId, 'isolated')
}

export function buildSessionHandoffId(snapshot: SessionHandoffSnapshot, targetKind: AgentSessionHandoffTargetKind, forkEntryId = ''): string {
  return createHash('sha256')
    .update([
      snapshot.originSessionId,
      snapshot.originTargetOwnerSessionId,
      snapshot.originCheckoutId,
      String(snapshot.originRevision),
      targetKind,
      forkEntryId,
      snapshot.localHeadOid,
      snapshot.isolatedSnapshotOid ?? 'no-isolated-snapshot',
    ].join('\0'))
    .digest('hex')
    .slice(0, 24)
}

export function buildWorktreeRecoveryHandoffId(snapshot: WorktreeRecoveryHandoffSnapshot): string {
  return buildSessionHandoffId(snapshot, 'isolated')
}

export function buildSessionHandoffContinuationPrompt(
  handoffPath: string,
  originSessionId: string,
  targetKind: AgentSessionHandoffTargetKind,
  mode: AgentSessionHandoffMode = 'fork',
): string {
  return `<domi_session_handoff>
Domi 已从会话 ${originSessionId} 创建 durable handoff，并派生了新的 Agent 会话。
${mode === 'degraded' ? '\n重要：这是降级交接，未继承完整 Pi 历史。不得假装拥有原会话的全部上下文。\n' : ''}
读取并执行：${handoffPath}

- 当前 Session Target 是${targetKind === 'isolated' ? '新的 managed Worktree' : '来源会话使用的 Local Checkout'}。
- ${mode === 'fork' ? '先阅读 fork 后的完整对话与 handoff' : '先阅读 handoff 中的有界上下文并核对当前文件/Git 状态'}，只继续未完成事项，不要重复已完成工作。
- 严格遵守文档中的 Local、Git、验证与交付边界。
</domi_session_handoff>`
}

export function buildWorktreeRecoveryContinuationPrompt(handoffPath: string, originSessionId: string): string {
  return buildSessionHandoffContinuationPrompt(handoffPath, originSessionId, 'isolated')
}

function getStoredMessageUuid(message: unknown): string | undefined {
  if (!message || typeof message !== 'object' || !('uuid' in message)) return undefined
  const uuid = (message as { uuid?: unknown }).uuid
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : undefined
}

const TERMINATING_ASSISTANT_TOOL_NAMES = new Set([
  'ReadyForReview', 'FinishWorktree', 'ApplyWorktree', 'RequestNextWorktreeIteration', 'RequestWorktreePreviewRevision',
])

function containsTerminatingToolUse(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const envelope = message as { content?: unknown; message?: { content?: unknown } }
  const content = Array.isArray(envelope.message?.content)
    ? envelope.message.content
    : Array.isArray(envelope.content) ? envelope.content : []
  return content.some((block) => {
    if (!block || typeof block !== 'object') return false
    const candidate = block as { type?: unknown; name?: unknown }
    return candidate.type === 'tool_use' && typeof candidate.name === 'string' && TERMINATING_ASSISTANT_TOOL_NAMES.has(candidate.name)
  })
}

function findLatestForkableAssistant(session: AgentSessionMeta): AgentSessionHandoffForkPoint {
  if (!session.sdkSessionId) return { status: 'unavailable', reason: 'sdk_session_missing' }
  if (!session.piSessionFile || !existsSync(session.piSessionFile)) {
    return { status: 'unavailable', reason: 'session_artifact_missing' }
  }
  const bindings = session.piEntryBindings ?? {}
  const messages = getAgentSessionSDKMessagesRaw(session.id)
  let sawUnboundAssistant = false
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.type !== 'assistant' || containsTerminatingToolUse(message)) continue
    const assistantMessageUuid = getStoredMessageUuid(message)
    if (!assistantMessageUuid) continue
    const piEntryId = bindings[assistantMessageUuid]
    if (piEntryId) return { status: 'available', assistantMessageUuid, piEntryId }
    sawUnboundAssistant = true
  }
  return {
    status: 'unavailable',
    reason: sawUnboundAssistant ? 'entry_mapping_missing' : 'safe_fork_point_unavailable',
  }
}

async function writeDefaultHandoff(
  session: AgentSessionMeta,
  handoffId: string,
  markdown: string,
): Promise<{ sourcePath: string; relativePath: string }> {
  const workspace = session.workspaceId ? getAgentWorkspace(session.workspaceId) : undefined
  const workbench = resolveAgentWorkbenchDir(workspace, session.id)
  if (!workbench) throw new Error('无法解析来源会话工作台，不能持久化 session handoff')
  const relativePath = `.context/handoff--session--${handoffId}.md`
  const sourcePath = join(workbench, relativePath)
  await mkdir(dirname(sourcePath), { recursive: true })
  await writeFile(sourcePath, markdown, 'utf8')
  return { sourcePath, relativePath }
}

function resolveDefaultChildHandoffPath(child: AgentSessionMeta, relativePath: string): string {
  const workspace = child.workspaceId ? getAgentWorkspace(child.workspaceId) : undefined
  const workbench = resolveAgentWorkbenchDir(workspace, child.id)
  if (!workbench) throw new Error('无法解析 handoff 子会话工作台')
  return join(workbench, relativePath)
}

const defaultDependencies: AgentSessionHandoffDependencies = {
  getSession: getAgentSessionMeta,
  getExistingHandoffSession: (handoffId) => listAgentSessions().find((session) => session.handoffId === handoffId && !session.archived),
  isSessionActive: isAgentSessionActive,
  captureSnapshot: (sessionId, expectedRevision) => getSessionCheckoutModule().captureSessionHandoff(sessionId, expectedRevision),
  findForkPoint: findLatestForkableAssistant,
  exportFallbackContext: (session) => exportBoundedSessionContext(getAgentSessionSDKMessagesRaw(session.id)),
  writeHandoff: writeDefaultHandoff,
  forkSession: forkAgentSession,
  createFallbackSession: (source) => createAgentSession(
    `${source.title} · 降级接力`,
    source.channelId,
    source.workspaceId,
    source.modelId,
    getAgentCwdMode(source),
  ),
  bindFallbackSession: async (child, targetKind, snapshot) => {
    if (targetKind === 'isolated') {
      await bindProductionVerifiedIsolatedTarget(child.id, {
        expectedCurrentOid: snapshot.localHeadOid,
        dirtyConfirmed: snapshot.localDirty,
      })
    } else {
      await bindProductionAgentSessionTargetForLaunch({
        sessionId: child.id,
        choice: { kind: 'inherit', parentSessionId: snapshot.originSessionId },
      })
    }
    return getAgentSessionMeta(child.id) ?? child
  },
  updateSession: updateAgentSessionMeta,
  resolveChildHandoffPath: resolveDefaultChildHandoffPath,
  ensureChildHandoff: async (sourcePath, childPath) => {
    if (existsSync(childPath)) return
    await mkdir(dirname(childPath), { recursive: true })
    await copyFile(sourcePath, childPath)
  },
  rollbackFork: rollbackUnpublishedPiForkSession,
  runChild: runRegisteredHeadlessAgent,
  createActivationToken: randomUUID,
}

function launchPreparedChild(input: {
  dependencies: AgentSessionHandoffDependencies
  child: AgentSessionMeta
  source: AgentSessionMeta
  handoffPath: string
  targetKind: AgentSessionHandoffTargetKind
  mode: AgentSessionHandoffMode
  activationToken: string
  rollbackOnRejectedLaunch: boolean
}): void {
  const { dependencies, child, source, handoffPath, targetKind, mode, activationToken } = input
  dependencies.updateSession(child.id, { handoffStartedAt: Date.now() })
  const executionPolicy: ExecutionPolicyMode = child.executionPolicy ?? source.executionPolicy ?? 'controlled'
  const workflow: AgentWorkflow = child.workflow ?? source.workflow ?? 'direct'
  const permissionMode: DomiPermissionMode = child.permissionMode ?? source.permissionMode ?? 'bypassPermissions'
  void dependencies.runChild({
    sessionId: child.id,
    userMessage: buildSessionHandoffContinuationPrompt(handoffPath, source.id, targetKind, mode),
    channelId: child.channelId ?? source.channelId!,
    modelId: child.modelId ?? source.modelId,
    workspaceId: child.workspaceId ?? source.workspaceId,
    executionPolicyOverride: executionPolicy,
    workflowOverride: workflow,
    permissionModeOverride: permissionMode,
    triggeredBy: 'user',
    startedAt: Date.now(),
  }, {
    source: 'worktree_handoff',
    originSessionId: source.id,
    activationToken,
    onError: (error) => console.error(`[Session Handoff] 子会话运行失败 (${child.id}):`, error),
    onComplete: () => undefined,
    onTitleUpdated: () => undefined,
  }).catch(async (error) => {
    console.error(`[Session Handoff] 无法启动子会话 (${child.id}):`, error)
    if (!input.rollbackOnRejectedLaunch) return
    try {
      await dependencies.rollbackFork(child.id)
    } catch (rollbackError) {
      console.error(`[Session Handoff] 启动失败后的自动回滚未完成 (${child.id}):`, rollbackError)
    }
  })
}

export async function prepareAgentSessionHandoff(
  input: PrepareAgentSessionHandoffInput,
  dependencies: AgentSessionHandoffDependencies = defaultDependencies,
): Promise<PreparedAgentSessionHandoff> {
  const source = dependencies.getSession(input.originSessionId)
  if (!source) throw new SessionCheckoutError('operation_not_allowed', '来源 Agent 会话不存在')
  if (!source.channelId) throw new SessionCheckoutError('operation_not_allowed', '来源 Agent 会话没有可用渠道')
  if (dependencies.isSessionActive(source.id)) {
    throw new SessionCheckoutError('operation_not_allowed', '当前 Agent 仍在运行；请先停止或等待完成后再交接，避免两个会话同时写同一目标')
  }

  const snapshot = await dependencies.captureSnapshot(input.originSessionId, input.expectedRevision)
  if (snapshot.originSessionId !== source.id) {
    throw new SessionCheckoutError('stale_target', 'Session handoff 来源身份已变化，请刷新后重试')
  }
  if (snapshot.originTargetKind === 'isolated' && input.targetKind === 'local') {
    throw new SessionCheckoutError('operation_not_allowed', 'Worktree 会话不能直接交接到 Local，以免绕过 Preview 验收')
  }
  if (snapshot.localDirty && input.targetKind === 'isolated' && !input.confirmedIgnoreDirtyLocal) {
    throw new SessionCheckoutError('dirty_confirmation_required', 'Local 存在未提交状态；需要明确确认新 Worktree 不复制这些修改')
  }

  const forkPoint = dependencies.findForkPoint(source)
  const handoffId = buildSessionHandoffId(
    snapshot,
    input.targetKind,
    forkPoint.status === 'available'
      ? forkPoint.piEntryId
      : `degraded:${forkPoint.reason}:${source.updatedAt}`,
  )
  const existing = dependencies.getExistingHandoffSession(handoffId)
  let mode: AgentSessionHandoffMode = existing?.handoffMode
    ?? (forkPoint.status === 'available' ? 'fork' : 'degraded')
  let degradedReason: AgentSessionHandoffDegradedReason | undefined = existing?.handoffDegradedReason
    ?? (forkPoint.status === 'unavailable' ? forkPoint.reason : undefined)

  const persistHandoff = async () => {
    const fallbackContext = mode === 'degraded' ? dependencies.exportFallbackContext(source) : undefined
    return dependencies.writeHandoff(source, handoffId, buildSessionHandoffMarkdown(
      snapshot,
      handoffId,
      input.targetKind,
      { mode, ...(degradedReason ? { degradedReason } : {}), ...(fallbackContext ? { fallbackContext } : {}) },
    ))
  }

  let handoff = await persistHandoff()
  if (existing) {
    const childHandoffPath = dependencies.resolveChildHandoffPath(existing, handoff.relativePath)
    await dependencies.ensureChildHandoff?.(handoff.sourcePath, childHandoffPath)
    const activationToken = dependencies.createActivationToken()
    let launched = false
    return {
      child: existing,
      handoffId,
      reused: true,
      mode,
      ...(degradedReason ? { degradedReason } : {}),
      activationToken,
      launch() {
        if (launched || existing.handoffStartedAt) return
        launched = true
        launchPreparedChild({
          dependencies, child: existing, source, handoffPath: childHandoffPath,
          targetKind: input.targetKind, mode, activationToken, rollbackOnRejectedLaunch: false,
        })
      },
    }
  }

  let child: AgentSessionMeta | undefined
  try {
    if (forkPoint.status === 'available') {
      const useFreshWorktree = input.targetKind === 'isolated'
      try {
        child = await dependencies.forkSession({
          sessionId: source.id,
          upToMessageUuid: forkPoint.assistantMessageUuid,
          modelId: source.modelId,
          target: useFreshWorktree
            ? { kind: 'isolated', confirmDirty: snapshot.localDirty }
            : { kind: 'inherit' },
        }, useFreshWorktree ? {
          piEntryId: forkPoint.piEntryId,
          uiUpToMessageUuid: forkPoint.assistantMessageUuid,
          expectedCurrentOid: snapshot.localHeadOid,
          dirtyConfirmed: snapshot.localDirty,
          expectedEntryRole: 'assistant',
        } : undefined)
      } catch (error) {
        if (!isPiForkUnavailableError(error)) throw error
        mode = 'degraded'
        degradedReason = error.reason
        handoff = await persistHandoff()
      }
    }

    if (!child) {
      child = dependencies.createFallbackSession(source)
      child = await dependencies.bindFallbackSession(child, input.targetKind, snapshot)
    }

    child = dependencies.updateSession(child.id, {
      title: mode === 'degraded' ? `${source.title} · 降级接力` : `${source.title} · 会话接力`,
      handoffId,
      handoffOriginSessionId: source.id,
      handoffMode: mode,
      ...(degradedReason ? { handoffDegradedReason: degradedReason } : {}),
      executionPolicy: source.executionPolicy,
      workflow: source.workflow,
      permissionMode: source.permissionMode,
      parentSessionId: source.id,
      rootSessionId: source.rootSessionId ?? source.id,
    })
    const childHandoffPath = dependencies.resolveChildHandoffPath(child, handoff.relativePath)
    await dependencies.ensureChildHandoff?.(handoff.sourcePath, childHandoffPath)
    const activationToken = dependencies.createActivationToken()
    let launched = false
    return {
      child,
      handoffId,
      reused: false,
      mode,
      ...(degradedReason ? { degradedReason } : {}),
      activationToken,
      launch() {
        if (launched) return
        launched = true
        launchPreparedChild({
          dependencies, child: child!, source, handoffPath: childHandoffPath,
          targetKind: input.targetKind, mode, activationToken, rollbackOnRejectedLaunch: true,
        })
      },
    }
  } catch (error) {
    if (child) await dependencies.rollbackFork(child.id)
    throw error
  }
}

/** 兼容旧 Preview recovery 入口，统一路由到通用 session handoff。 */
export async function prepareAgentWorktreeRecoveryHandoff(
  input: PrepareAgentWorktreeRecoveryHandoffInput,
  dependencies: AgentSessionHandoffDependencies = defaultDependencies,
): Promise<PreparedAgentWorktreeRecoveryHandoff> {
  return prepareAgentSessionHandoff({ ...input, targetKind: 'isolated' }, dependencies)
}

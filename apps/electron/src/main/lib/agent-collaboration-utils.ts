/**
 * Agent 协作会话纯工具函数
 *
 * 不依赖 Electron 和磁盘服务，便于单元测试。
 */

import {
  DOMI_DEFAULT_PERMISSION_MODE,
  normalizeAgentExecutionSettings,
  type AgentDelegationRole,
  type AgentDelegationStatus,
  type AgentSessionMeta,
  type AgentWorkflow,
  type ExecutionPolicyMode,
  type DomiPermissionMode,
} from '@domi/shared'

const PERMISSION_RANK: Record<DomiPermissionMode, number> = {
  plan: 0,
  bypassPermissions: 1,
}

export const MAX_RUNNING_DELEGATIONS_PER_PARENT = 50
export const DEFAULT_DELEGATION_LIST_LIMIT = 20
export const MAX_DELEGATION_LIST_LIMIT = 50
export const DEFAULT_REVIEW_MAX_RUNTIME_SECONDS = 15 * 60
export const MIN_DELEGATION_RUNTIME_SECONDS = 60
export const MAX_DELEGATION_RUNTIME_SECONDS = 2 * 60 * 60

/** 仅顶层、具备工作区且由用户启用的会话可获得协作派生工具。 */
export function shouldExposeCollaborationTools(input: {
  enabled: boolean
  workspaceId?: string
  triggeredBy?: string
  delegationDepth?: number
}): boolean {
  return input.enabled &&
    !!input.workspaceId &&
    input.triggeredBy !== 'delegation' &&
    (input.delegationDepth ?? 0) === 0
}

export interface DelegationListSource {
  delegationId: string
  childSessionId: string
  title: string
  role?: AgentDelegationRole
  modelId?: string
  status: AgentDelegationStatus
  startedAt: number
  completedAt?: number
  pendingBlockedEvents?: readonly unknown[]
}

export interface DelegationListItem {
  delegationId: string
  childSessionId: string
  title: string
  role?: AgentDelegationRole
  modelId?: string
  status: AgentDelegationStatus
  startedAt: number
  completedAt?: number
  durationMs: number
  pendingBlockedEventCount: number
}

export interface DelegationListPayload {
  totalMatched: number
  returnedCount: number
  runningCount: number
  truncated: boolean
  delegations: DelegationListItem[]
}

export function buildDelegationListPayload(
  items: readonly DelegationListSource[],
  options: { includeCompleted?: boolean; limit?: number },
  now = Date.now(),
): DelegationListPayload {
  const requestedLimit = Number.isFinite(options.limit)
    ? Math.floor(options.limit!)
    : DEFAULT_DELEGATION_LIST_LIMIT
  const limit = Math.min(
    MAX_DELEGATION_LIST_LIMIT,
    Math.max(1, requestedLimit),
  )
  const matched = items
    .filter((item) => options.includeCompleted === true || item.status === 'running')
    .sort((a, b) => b.startedAt - a.startedAt)
  const delegations = matched.slice(0, limit).map((item) => {
    const endedAt = item.completedAt ?? now
    return {
      delegationId: item.delegationId,
      childSessionId: item.childSessionId,
      title: item.title,
      role: item.role,
      modelId: item.modelId,
      status: item.status,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      durationMs: Math.max(0, endedAt - item.startedAt),
      pendingBlockedEventCount: item.pendingBlockedEvents?.length ?? 0,
    }
  })

  return {
    totalMatched: matched.length,
    returnedCount: delegations.length,
    runningCount: matched.filter((item) => item.status === 'running').length,
    truncated: delegations.length < matched.length,
    delegations,
  }
}

export function resolveDelegationMaxRuntimeSeconds(
  role: AgentDelegationRole,
  requestedSeconds?: number,
): number | undefined {
  if (requestedSeconds !== undefined && Number.isFinite(requestedSeconds)) {
    return Math.min(
      MAX_DELEGATION_RUNTIME_SECONDS,
      Math.max(MIN_DELEGATION_RUNTIME_SECONDS, Math.floor(requestedSeconds)),
    )
  }
  return role === 'review' ? DEFAULT_REVIEW_MAX_RUNTIME_SECONDS : undefined
}

export interface DelegationRuntimeTimer {
  deadlineAt: number
  cancel: () => void
}

export function createDelegationRuntimeTimer(
  timeoutMs: number,
  onTimeout: () => void,
  options: { unref?: boolean } = {},
): DelegationRuntimeTimer {
  let active = true
  const normalizedTimeoutMs = Math.max(0, Math.floor(timeoutMs))
  const deadlineAt = Date.now() + normalizedTimeoutMs
  const timer = setTimeout(() => {
    if (!active) return
    active = false
    onTimeout()
  }, normalizedTimeoutMs)
  if (options.unref) {
    ;(timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
  }

  return {
    deadlineAt,
    cancel: () => {
      if (!active) return
      active = false
      clearTimeout(timer)
    },
  }
}

/**
 * 为具有副作用的工具调用提供进程内幂等保护。
 *
 * Pi runtime 在流恢复或上游重放时可能再次执行同一个 toolCallId；以父会话和
 * toolCallId 作为键可复用第一次的结果，避免重复创建子会话。缓存有界，防止长
 * 会话中的工具调用 ID 无限累积。
 */
export function createToolCallIdempotencyCache<T>(maxEntries = 512): {
  getOrCreate: (parentSessionId: string, toolCallId: string | undefined, create: () => T) => T
} {
  const entries = new Map<string, T>()

  return {
    getOrCreate(parentSessionId, toolCallId, create) {
      const normalizedCallId = toolCallId?.trim()
      // 缺少稳定调用 ID 时无法安全去重，保持原有执行语义。
      if (!normalizedCallId) return create()

      const key = `${parentSessionId}:${normalizedCallId}`
      if (entries.has(key)) return entries.get(key)!

      const result = create()
      entries.set(key, result)
      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value
        if (!oldestKey) break
        entries.delete(oldestKey)
      }
      return result
    },
  }
}

export interface RecoveredDelegationState {
  delegationId: string
  parentSessionId: string
  childSessionId: string
  title: string
  role: AgentDelegationRole
  goal: string
  executionPolicy?: ExecutionPolicyMode
  workflow?: AgentWorkflow
  permissionMode?: DomiPermissionMode
  status: AgentDelegationStatus
  startedAt: number
  completedAt?: number
}

export function resolveDelegationPermissionMode(
  parentMode: DomiPermissionMode | undefined,
  requestedMode: DomiPermissionMode | undefined,
): DomiPermissionMode {
  const parent = parentMode ?? DOMI_DEFAULT_PERMISSION_MODE
  const requested = requestedMode ?? parent
  return PERMISSION_RANK[requested] <= PERMISSION_RANK[parent] ? requested : parent
}

export interface DelegationExecutionControls {
  executionPolicy?: ExecutionPolicyMode
  workflow?: AgentWorkflow
  permissionMode?: DomiPermissionMode
}

export function resolveDelegationExecutionControls(input: {
  parentExecutionPolicy?: ExecutionPolicyMode
  parentPermissionMode?: DomiPermissionMode
  requestedPermissionMode?: DomiPermissionMode
}): DelegationExecutionControls {
  const parent = normalizeAgentExecutionSettings({
    executionPolicy: input.parentExecutionPolicy,
    permissionMode: input.parentPermissionMode,
  })
  return { executionPolicy: parent.executionPolicy, workflow: 'direct' }
}

export function buildDelegationRunControlOverrides(
  controls: DelegationExecutionControls,
): {
  executionPolicyOverride?: ExecutionPolicyMode
  workflowOverride?: AgentWorkflow
} {
  const normalized = normalizeAgentExecutionSettings(controls)
  return {
    executionPolicyOverride: normalized.executionPolicy,
    workflowOverride: 'direct',
  }
}

export function buildRecoveredDelegationState(input: {
  parentSessionId: string
  delegationId: string
  session: AgentSessionMeta
  fallbackPermissionMode?: DomiPermissionMode
}): RecoveredDelegationState {
  const persistedStatus = input.session.delegationStatus
  // 从持久化记录恢复但不在 live Map 中，说明当前进程并没有这个委派在跑。
  // 若磁盘里还残留 running（例如应用重启/崩溃后），应视为 interrupted，
  // 否则 continue_delegation 会把它误判为“仍在运行”而拒绝恢复。
  const status = persistedStatus === 'running'
    ? 'interrupted'
    : (persistedStatus ?? 'interrupted')
  return {
    delegationId: input.delegationId,
    parentSessionId: input.parentSessionId,
    childSessionId: input.session.id,
    title: input.session.title,
    role: input.session.delegationRole ?? 'custom',
    goal: input.session.delegationGoal ?? '',
    executionPolicy: input.session.executionPolicy,
    workflow: input.session.workflow,
    permissionMode: input.session.permissionMode ?? input.fallbackPermissionMode,
    status,
    startedAt: input.session.createdAt,
    completedAt: persistedStatus ? input.session.updatedAt : undefined,
  }
}

export function buildDelegationPrompt(input: {
  parentSessionId: string
  delegationId: string
  role: AgentDelegationRole
  task: string
  expectedOutput?: string
}): string {
  const expectedOutput = input.expectedOutput?.trim()
  return `你是 Domi 协作子 Agent。你由父 Agent 会话 ${input.parentSessionId} 委派创建，委派 ID 为 ${input.delegationId}。

## 工作边界

- 只处理下面的子任务，不要扩展到父任务的其他部分。
- 不要创建新的协作子会话。
- 如需修改文件，保持改动最小，并在最终回复说明文件路径和验证结果。
- 如果信息不足，直接列出缺口，不要编造。

## 子任务角色

${input.role}

## 子任务

${input.task.trim()}

## 输出要求

${expectedOutput || '最终回复请包含：关键发现、已执行操作、验证结果、剩余风险或建议。'}`
}

export function buildDelegationTaskWithSharedContext(input: {
  sharedContext?: string
  task: string
}): string {
  const sharedContext = input.sharedContext?.trim()
  const task = input.task.trim()
  if (!sharedContext) return task

  return `共享背景：
${sharedContext}

子任务：
${task}`
}

import { randomUUID } from 'node:crypto'
import type {
  AgentSessionMeta,
  AgentWorkflow,
  ExecutionPolicyMode,
  DomiPermissionMode,
  SessionTargetView,
} from '@domi/shared'
import {
  forkAgentSession,
  getAgentSessionMeta,
  rollbackUnpublishedPiForkSession,
  type HostPiForkPoint,
} from './agent-session-manager'
import { getSessionCheckoutModule } from './session-checkout/production'
import { SessionCheckoutError } from './session-checkout'
import { runRegisteredHeadlessAgent } from './agent-headless-runner-registry'

export interface AgentWorktreeHandoffRequest {
  parentSessionId: string
  assistantMessageUuid: string
  toolResultMessageUuid: string
  piToolResultEntryId: string
  task: string
  targetRevision: number
  targetCurrentOid: string
  dirtyConfirmed: boolean
  channelId: string
  modelId?: string
  workspaceId?: string
  executionPolicy: ExecutionPolicyMode
  workflow: AgentWorkflow
  permissionMode: DomiPermissionMode
}

export interface AgentWorktreeHandoffValidationInput {
  parentSessionId: string
}

export interface PreparedAgentWorktreeHandoff {
  child: AgentSessionMeta
  activationToken: string
  launch(): void
  rollback(): Promise<void>
}

export interface AgentWorktreeHandoffDependencies {
  getSession(sessionId: string): AgentSessionMeta | undefined
  inspectTarget(sessionId: string): Promise<SessionTargetView>
  forkSession(input: {
    sessionId: string
    upToMessageUuid: string
    modelId?: string
    target: { kind: 'isolated'; confirmDirty: boolean }
  }, hostPiForkPoint?: HostPiForkPoint): Promise<AgentSessionMeta>
  rollbackFork(sessionId: string): Promise<void>
  runChild(
    input: Parameters<typeof runRegisteredHeadlessAgent>[0],
    callbacks: Parameters<typeof runRegisteredHeadlessAgent>[1],
  ): Promise<void>
}

export function canOfferAgentWorktreeHandoff(input: {
  targetKind?: 'local' | 'isolated'
  triggeredBy?: 'user' | 'automation' | 'delegation' | 'bridge' | 'channel'
  sourceDelegationId?: string
}): boolean {
  return input.targetKind === 'local'
    && (input.triggeredBy ?? 'user') === 'user'
    && !input.sourceDelegationId
}

const defaultDependencies: AgentWorktreeHandoffDependencies = {
  getSession: getAgentSessionMeta,
  inspectTarget: (sessionId) => getSessionCheckoutModule().inspect(sessionId),
  forkSession: forkAgentSession,
  rollbackFork: rollbackUnpublishedPiForkSession,
  runChild: runRegisteredHeadlessAgent,
}

export async function validateAgentWorktreeHandoff(
  input: AgentWorktreeHandoffValidationInput,
  dependencies: AgentWorktreeHandoffDependencies = defaultDependencies,
): Promise<SessionTargetView> {
  const parent = dependencies.getSession(input.parentSessionId)
  if (!parent) {
    throw new SessionCheckoutError('operation_not_allowed', 'ForkToWorktree 需要有效的 Agent 会话')
  }
  const target = await dependencies.inspectTarget(input.parentSessionId)
  if (target.checkout.kind !== 'local') {
    throw new SessionCheckoutError('operation_not_allowed', '当前会话已经位于 Domi managed Worktree，无需再次 Fork')
  }
  return target
}

export function buildWorktreeHandoffContinuationPrompt(task: string, parentSessionId: string): string {
  return `<domi_worktree_handoff>
Domi 已将你从 Local 会话 ${parentSessionId} 安全派生到新的 managed Worktree 会话。

- 当前 cwd 与 Session Target 已是新的 Isolated Checkout；直接在这里继续，不要再创建或切换 worktree。
- 父 Local 会话及其中未提交的修改保持原状，没有复制到这里。
- 先核验当前仓库与已迁移的会话上下文，避免重复已完成工作，然后立即继续下面的任务。

继续任务：
${task}
</domi_worktree_handoff>`
}

export async function prepareAgentWorktreeHandoff(
  input: AgentWorktreeHandoffRequest,
  dependencies: AgentWorktreeHandoffDependencies = defaultDependencies,
): Promise<PreparedAgentWorktreeHandoff> {
  const target = await validateAgentWorktreeHandoff(input, dependencies)
  if (target.revision !== input.targetRevision) {
    throw new SessionCheckoutError('stale_target', 'Session Target 在确认后已变化，请重新发起 Worktree handoff')
  }

  // 用户确认期间，另一个会话可能刚好把 Local 修改提交到新的 HEAD。
  // 若最终状态已经 clean，可安全地以新 HEAD 刷新证明继续；若仍 dirty，则保守拒绝，
  // 避免把针对旧 HEAD 的确认套用到新的脏工作区状态。
  const headChanged = target.current.oid !== input.targetCurrentOid
  if (headChanged && target.dirty) {
    throw new SessionCheckoutError('stale_target', 'Local HEAD 在确认后变化且仍有未提交修改，请重新发起 Worktree handoff')
  }
  if (target.dirty && !input.dirtyConfirmed) {
    throw new SessionCheckoutError(
      'dirty_confirmation_required',
      'Local Checkout 存在未提交修改，但本次 handoff 没有可信用户确认',
    )
  }

  const expectedCurrentOid = headChanged ? target.current.oid : input.targetCurrentOid
  const dirtyConfirmed = target.dirty && input.dirtyConfirmed
  const child = await dependencies.forkSession({
    sessionId: input.parentSessionId,
    upToMessageUuid: input.assistantMessageUuid,
    modelId: input.modelId,
    target: { kind: 'isolated', confirmDirty: dirtyConfirmed },
  }, {
    piEntryId: input.piToolResultEntryId,
    uiUpToMessageUuid: input.toolResultMessageUuid,
    expectedCurrentOid,
    dirtyConfirmed,
  })
  const prompt = buildWorktreeHandoffContinuationPrompt(input.task, input.parentSessionId)
  const activationToken = randomUUID()

  return {
    child,
    activationToken,
    async rollback() {
      await dependencies.rollbackFork(child.id)
    },
    launch() {
      void dependencies.runChild({
        sessionId: child.id,
        userMessage: prompt,
        channelId: input.channelId,
        modelId: input.modelId,
        workspaceId: input.workspaceId,
        executionPolicyOverride: input.executionPolicy,
        workflowOverride: input.workflow,
        permissionModeOverride: input.permissionMode,
        triggeredBy: 'user',
        startedAt: Date.now(),
      }, {
        source: 'worktree_handoff',
        originSessionId: input.parentSessionId,
        activationToken,
        onError: (error) => console.error(`[Agent Worktree Handoff] 子会话运行失败 (${child.id}):`, error),
        onComplete: () => undefined,
        onTitleUpdated: () => undefined,
      }).catch((error) => {
        console.error(`[Agent Worktree Handoff] 无法启动子会话 (${child.id}):`, error)
      })
    },
  }
}

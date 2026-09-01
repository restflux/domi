import {
  projectWorkActivity,
  type AgentSessionMeta,
  type WorkActivityPendingActionFact,
  type WorkActivityProjection,
  type WorkActivitySessionFact,
  type WorkActivityStopResult,
} from '@domi/shared'
import { askUserService } from './agent-ask-user-service.ts'
import { stopDelegationForHost } from './agent-collaboration-tools.ts'
import { exitPlanService } from './agent-exit-plan-service.ts'
import { permissionService } from './agent-permission-service.ts'
import { getAutomation } from './automation-manager.ts'
import {
  isRegisteredAgentActive,
  stopRegisteredAgent,
} from './agent-headless-runner-registry.ts'
import { getAgentSessionMeta, listAgentSessions, updateAgentSessionMeta } from './agent-session-manager.ts'
import { getAgentWorkspace } from './agent-workspace-manager.ts'
import { getSessionCheckoutModule } from './session-checkout/production.ts'
import {
  projectSessionTargetPendingActions,
  resolveWorkActivityHostMetadata,
} from './work-activity-host-facts.ts'
import { broadcastWorkActivityChanged } from './work-activity-events.ts'

function getRootSessionId(session: AgentSessionMeta): string {
  return session.rootSessionId ?? session.id
}

function rootMembers(rootSessionId: string): AgentSessionMeta[] {
  return listAgentSessions().filter((session) => (
    session.id === rootSessionId
    || session.rootSessionId === rootSessionId
  ))
}

function requestTime(request: { createdAt?: number }, fallback: number): number {
  return request.createdAt ?? fallback
}

function pendingActionsBySession(sessions: AgentSessionMeta[]): Map<string, WorkActivityPendingActionFact[]> {
  const result = new Map<string, WorkActivityPendingActionFact[]>()
  const append = (sessionId: string, action: WorkActivityPendingActionFact): void => {
    const actions = result.get(sessionId) ?? []
    actions.push(action)
    result.set(sessionId, actions)
  }

  try {
    for (const request of askUserService.getPendingRequests()) {
      append(request.sessionId, {
        kind: 'ask_user',
        summary: request.questions[0]?.header?.trim() || request.questions[0]?.question?.trim() || '等待回答',
        occurredAt: requestTime(request, sessions.find((session) => session.id === request.sessionId)?.updatedAt ?? Date.now()),
      })
    }
  } catch (error) {
    console.warn('[Work Activity] 读取待回答请求失败', error)
  }
  try {
    for (const request of permissionService.getPendingRequests()) {
      append(request.sessionId, {
        kind: 'permission',
        summary: request.description?.trim() || '等待权限确认',
        occurredAt: requestTime(request, sessions.find((session) => session.id === request.sessionId)?.updatedAt ?? Date.now()),
      })
    }
  } catch (error) {
    console.warn('[Work Activity] 读取待确认权限失败', error)
  }
  try {
    for (const request of exitPlanService.getPendingRequests()) {
      append(request.sessionId, {
        kind: 'plan_approval',
        summary: '等待计划审批',
        occurredAt: requestTime(request, sessions.find((session) => session.id === request.sessionId)?.updatedAt ?? Date.now()),
      })
    }
  } catch (error) {
    console.warn('[Work Activity] 读取待审批计划失败', error)
  }
  return result
}

function readRootDeliveries(sessions: AgentSessionMeta[]) {
  const rootSessionIds = sessions
    .filter((session) => getRootSessionId(session) === session.id && session.sessionTarget?.kind === 'isolated')
    .map((session) => session.id)
  return getSessionCheckoutModule().readSessionDeliveries(rootSessionIds)
}

export async function getWorkActivityProjection(now: number = Date.now()): Promise<WorkActivityProjection> {
  const sessions = listAgentSessions()
  const pending = pendingActionsBySession(sessions)
  const deliveries = readRootDeliveries(sessions)
  const facts: WorkActivitySessionFact[] = sessions.map((session) => {
    const metadata = resolveWorkActivityHostMetadata(session, {
      getWorkspaceName: (workspaceId) => getAgentWorkspace(workspaceId)?.name,
      getAutomationName: (automationId) => getAutomation(automationId)?.name,
      warn: (message, error) => console.warn(message, error),
    })
    const targetActions = getRootSessionId(session) === session.id
      ? projectSessionTargetPendingActions(deliveries.get(session.id))
      : []
    let active = false
    try {
      active = isRegisteredAgentActive(session.id)
    } catch (error) {
      console.warn(`[Work Activity] 读取 Agent 运行态失败: ${session.id}`, error)
    }
    return {
      sessionId: session.id,
      parentSessionId: session.parentSessionId,
      rootSessionId: session.rootSessionId,
      workspaceId: session.workspaceId,
      workspaceName: metadata.workspaceName,
      title: session.title,
      source: metadata.source,
      automationName: metadata.automationName,
      archived: session.archived === true,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      active,
      delegationStatus: session.delegationStatus,
      run: session.workActivityRun,
      pendingActions: [...(pending.get(session.id) ?? []), ...targetActions],
      tasks: session.workActivityTasks ?? [],
      viewedAt: session.workActivityViewedAt,
      acknowledgedOutcomeAt: session.workActivityAcknowledgedOutcomeAt,
      removedOutcomeAt: session.workActivityRemovedOutcomeAt,
    }
  })
  return projectWorkActivity(facts, now)
}

export function markWorkActivityViewed(rootSessionId: string, viewedAt: number = Date.now()): void {
  const root = getAgentSessionMeta(rootSessionId)
  if (!root) throw new Error(`Agent 会话不存在: ${rootSessionId}`)
  updateAgentSessionMeta(rootSessionId, { workActivityViewedAt: viewedAt })
  broadcastWorkActivityChanged()
}

export function acknowledgeWorkActivityOutcome(rootSessionId: string, acknowledgedAt: number = Date.now()): void {
  const members = rootMembers(rootSessionId)
  if (members.length === 0) throw new Error(`Agent 会话不存在: ${rootSessionId}`)
  for (const member of members) {
    updateAgentSessionMeta(member.id, {
      workActivityAcknowledgedOutcomeAt: acknowledgedAt,
      workActivityViewedAt: acknowledgedAt,
    })
  }
  broadcastWorkActivityChanged()
}

export function removeWorkActivityCompleted(rootSessionId: string, removedAt: number = Date.now()): void {
  const root = getAgentSessionMeta(rootSessionId)
  if (!root) throw new Error(`Agent 会话不存在: ${rootSessionId}`)
  updateAgentSessionMeta(rootSessionId, { workActivityRemovedOutcomeAt: removedAt })
  broadcastWorkActivityChanged()
}

export async function removeAllWorkActivityCompleted(removedAt: number = Date.now()): Promise<number> {
  const projection = await getWorkActivityProjection(removedAt)
  const completed = projection.sessions.filter((session) => session.state === 'recently_completed')
  for (const session of completed) {
    updateAgentSessionMeta(session.rootSessionId, { workActivityRemovedOutcomeAt: removedAt })
  }
  if (completed.length > 0) broadcastWorkActivityChanged()
  return completed.length
}

export function stopWorkActivitySession(rootSessionId: string): WorkActivityStopResult {
  const members = rootMembers(rootSessionId)
  if (members.length === 0) throw new Error(`Agent 会话不存在: ${rootSessionId}`)
  const activeMembers = members.filter((member) => isRegisteredAgentActive(member.id))
  const runningChildCount = activeMembers.filter((member) => member.id !== rootSessionId).length

  // 先停止子会话，避免父会话中止回调抢先结束后遗留运行中的委派。
  for (const member of activeMembers.filter((item) => item.id !== rootSessionId)) {
    const stoppedAsDelegation = member.parentSessionId && member.sourceDelegationId
      ? stopDelegationForHost(member.parentSessionId, member.sourceDelegationId)
      : false
    if (!stoppedAsDelegation) {
      stopRegisteredAgent(member.id, 'work-activity-panel')
      if (member.sourceDelegationId) {
        updateAgentSessionMeta(member.id, { delegationStatus: 'cancelled' })
      }
    }
  }
  if (activeMembers.some((member) => member.id === rootSessionId)) {
    stopRegisteredAgent(rootSessionId, 'work-activity-panel')
  }

  if (activeMembers.length > 0) broadcastWorkActivityChanged()
  return {
    rootSessionId,
    stoppedSessionIds: activeMembers.map((member) => member.id),
    runningChildCount,
  }
}

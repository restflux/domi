import type {
  WorkActivityChildView,
  WorkActivityOutcome,
  WorkActivityPendingActionFact,
  WorkActivityPendingActionKind,
  WorkActivityProjection,
  WorkActivitySessionFact,
  WorkActivityState,
  WorkActivityTaskFact,
  WorkSessionView,
} from './types/work-activity.ts'

const STATE_PRIORITY: Record<WorkActivityState, number> = {
  attention_required: 0,
  working: 1,
  recently_completed: 2,
}

const ATTENTION_PRIORITY: Record<WorkActivityPendingActionKind, number> = {
  ask_user: 0,
  permission: 0,
  plan_approval: 0,
  failure: 1,
  interrupted: 1,
  conflict: 1,
  ready_for_review: 2,
}

interface AttentionCandidate {
  session: WorkActivitySessionFact
  kind: WorkActivityPendingActionKind
  summary: string
  occurredAt: number
  outcome?: WorkActivityOutcome
}

function resolveRootSessionId(
  fact: WorkActivitySessionFact,
  byId: Map<string, WorkActivitySessionFact>,
): string {
  if (fact.rootSessionId && byId.has(fact.rootSessionId)) return fact.rootSessionId
  let current = fact
  const visited = new Set<string>([current.sessionId])
  while (current.parentSessionId) {
    const parent = byId.get(current.parentSessionId)
    if (!parent || visited.has(parent.sessionId)) break
    visited.add(parent.sessionId)
    current = parent
  }
  return current.sessionId
}

function latestTaskPhase(tasks: WorkActivityTaskFact[]): string | undefined {
  return tasks.find((task) => task.status === 'in_progress' && task.activeForm?.trim())?.activeForm?.trim()
    ?? tasks.find((task) => task.status === 'blocked' && task.activeForm?.trim())?.activeForm?.trim()
}

function actionCandidate(
  session: WorkActivitySessionFact,
  action: WorkActivityPendingActionFact,
): AttentionCandidate {
  return { session, kind: action.kind, summary: action.summary, occurredAt: action.occurredAt }
}

function failureCandidate(
  session: WorkActivitySessionFact,
  includeAcknowledged = false,
): AttentionCandidate | undefined {
  const run = session.run
  let kind: 'failure' | 'interrupted' | undefined
  let occurredAt: number | undefined
  let summary: string | undefined

  if (run?.status === 'failed') {
    kind = 'failure'
    occurredAt = run.finishedAt ?? run.startedAt
    summary = run.error?.trim() || 'Agent 运行失败'
  } else if (run?.status === 'interrupted' || (run?.status === 'running' && !session.active)) {
    kind = 'interrupted'
    occurredAt = run.finishedAt ?? run.startedAt
    summary = '上次运行异常中断'
  } else if (!run && session.delegationStatus === 'failed') {
    kind = 'failure'
    occurredAt = session.updatedAt
    summary = '子 Agent 运行失败'
  } else if (!run && (session.delegationStatus === 'interrupted' || (session.delegationStatus === 'running' && !session.active))) {
    kind = 'interrupted'
    occurredAt = session.updatedAt
    summary = '子 Agent 异常中断'
  }

  if (!kind || occurredAt == null) return undefined
  if (!includeAcknowledged && (session.acknowledgedOutcomeAt ?? 0) >= occurredAt) return undefined
  return {
    session,
    kind,
    summary: summary!,
    occurredAt,
    outcome: kind === 'failure' ? 'failed' : 'interrupted',
  }
}

function compareAttention(a: AttentionCandidate, b: AttentionCandidate): number {
  return ATTENTION_PRIORITY[a.kind] - ATTENTION_PRIORITY[b.kind]
    || a.occurredAt - b.occurredAt
}

function childReason(session: WorkActivitySessionFact, attention?: AttentionCandidate): string {
  if (attention) return attention.summary
  if (session.active) return session.phaseSummary?.trim() || latestTaskPhase(session.tasks) || '正在处理'
  if (session.run?.status === 'failed' || session.delegationStatus === 'failed') return '运行失败'
  if (session.run?.status === 'stopped' || session.delegationStatus === 'cancelled') return '已停止'
  if (session.run?.status === 'interrupted' || session.delegationStatus === 'interrupted' || (session.delegationStatus === 'running' && !session.active)) return '异常中断'
  return '已完成'
}

function buildChildView(session: WorkActivitySessionFact): WorkActivityChildView {
  const attention = [
    ...session.pendingActions.map((action) => actionCandidate(session, action)),
    failureCandidate(session),
  ].filter((item): item is AttentionCandidate => Boolean(item)).sort(compareAttention)[0]
  return {
    sessionId: session.sessionId,
    title: session.title,
    active: session.active,
    status: attention ? 'attention_required' : session.active ? 'working' : 'completed',
    reason: childReason(session, attention),
    phaseSummary: latestTaskPhase(session.tasks) ?? session.phaseSummary?.trim() ?? childReason(session, attention),
    delegationStatus: session.delegationStatus,
    tasks: session.tasks,
  }
}

function summarizeAttention(candidate: AttentionCandidate, rootSessionId: string): string {
  if (candidate.session.sessionId === rootSessionId) return candidate.summary
  const sameKindLabel: Record<WorkActivityPendingActionKind, string> = {
    ask_user: '等待回答',
    permission: '等待权限确认',
    plan_approval: '等待计划审批',
    ready_for_review: '等待验收',
    conflict: '存在冲突',
    failure: '运行失败',
    interrupted: '异常中断',
  }
  return `1 个子会话${sameKindLabel[candidate.kind]}`
}

function deriveOutcome(members: WorkActivitySessionFact[], acknowledgedAttention?: AttentionCandidate): WorkActivityOutcome {
  if (acknowledgedAttention?.kind === 'failure' || acknowledgedAttention?.kind === 'interrupted') return 'unresolved'
  if (members.some((member) => member.run?.status === 'failed' || member.delegationStatus === 'failed')) return 'failed'
  if (members.some((member) => member.run?.status === 'interrupted' || member.delegationStatus === 'interrupted')) return 'interrupted'
  if (members.some((member) => member.run?.status === 'stopped' || member.delegationStatus === 'cancelled')) return 'stopped'
  return 'success'
}

function latestStateTime(members: WorkActivitySessionFact[]): number {
  return Math.max(...members.map((member) => member.run?.finishedAt ?? member.run?.startedAt ?? member.updatedAt))
}

function oldestActiveStart(members: WorkActivitySessionFact[]): number | undefined {
  const starts = members.filter((member) => member.active).map((member) => member.run?.startedAt ?? member.updatedAt)
  return starts.length > 0 ? Math.min(...starts) : undefined
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function buildWorkSession(
  rootSessionId: string,
  members: WorkActivitySessionFact[],
  now: number,
): WorkSessionView | null {
  const root = members.find((member) => member.sessionId === rootSessionId) ?? members[0]!
  const attentionCandidates = members.flatMap((member) => [
    ...member.pendingActions.map((action) => actionCandidate(member, action)),
    failureCandidate(member),
  ].filter((item): item is AttentionCandidate => Boolean(item))).sort(compareAttention)
  const attention = attentionCandidates[0]
  const activeMembers = members.filter((member) => member.active)
  const hasRunEvidence = members.some((member) => member.run || member.pendingActions.length > 0 || member.active || member.delegationStatus)
  if (!hasRunEvidence) return null

  const acknowledgedAttention = members
    .map((member) => failureCandidate(member, true))
    .find((candidate) => candidate && (candidate.session.acknowledgedOutcomeAt ?? 0) >= candidate.occurredAt)

  const state: WorkActivityState = attention
    ? 'attention_required'
    : activeMembers.length > 0
      ? 'working'
      : 'recently_completed'
  const stateChangedAt = attention?.occurredAt
    ?? (state === 'working' ? oldestActiveStart(activeMembers) : latestStateTime(members))
    ?? root.updatedAt

  if (state === 'recently_completed') {
    if (root.archived) return null
    if (stateChangedAt < startOfLocalDay(now)) return null
    if ((root.removedOutcomeAt ?? 0) >= stateChangedAt) return null
  }

  const rootTaskPhase = latestTaskPhase(root.tasks)
  const anyTaskPhase = members.map((member) => latestTaskPhase(member.tasks)).find(Boolean)
  const hostPhase = activeMembers.map((member) => member.phaseSummary?.trim()).find(Boolean)
  const phaseSummary = rootTaskPhase
    ?? anyTaskPhase
    ?? attention?.summary
    ?? hostPhase
    ?? (activeMembers.some((member) => member.sessionId !== rootSessionId) && !root.active ? '等待子 Agent' : undefined)
    ?? (state === 'working' ? '正在处理' : acknowledgedAttention ? '未解决' : deriveOutcome(members) === 'stopped' ? '已停止' : '已完成')
  const outcome = state === 'working' ? undefined : attention?.outcome ?? deriveOutcome(members, acknowledgedAttention)
  const reason = attention
    ? summarizeAttention(attention, rootSessionId)
    : state === 'working'
      ? activeMembers.length > 1 ? `${activeMembers.length} 个会话正在工作` : '正在工作'
      : outcome === 'unresolved' ? '失败已知晓'
        : outcome === 'stopped' ? '已停止'
          : outcome === 'failed' ? '运行失败'
            : outcome === 'interrupted' ? '异常中断'
              : '已完成'
  const latestUnreadEventAt = Math.max(
    stateChangedAt,
    ...members.flatMap((member) => member.pendingActions.map((action) => action.occurredAt)),
  )
  const viewedAt = Math.max(...members.map((member) => member.viewedAt ?? 0))
  const children = members
    .filter((member) => member.sessionId !== rootSessionId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(buildChildView)

  return {
    id: rootSessionId,
    rootSessionId,
    workspaceId: root.workspaceId,
    workspaceName: root.workspaceName,
    title: root.title,
    source: root.source,
    automationName: root.automationName,
    state,
    reason,
    pendingActionKind: attention?.kind,
    phaseSummary,
    startedAt: oldestActiveStart(members) ?? members.map((member) => member.run?.startedAt).filter((value): value is number => value != null).sort((a, b) => a - b)[0],
    stateChangedAt,
    unread: latestUnreadEventAt > viewedAt,
    archived: root.archived,
    outcome,
    activeSessionIds: activeMembers.map((member) => member.sessionId),
    completedChildren: children.filter((child) => child.status === 'completed').length,
    totalChildren: children.length,
    tasks: members.flatMap((member) => member.tasks),
    children,
  }
}

function compareWorkSessions(a: WorkSessionView, b: WorkSessionView): number {
  const stateOrder = STATE_PRIORITY[a.state] - STATE_PRIORITY[b.state]
  if (stateOrder !== 0) return stateOrder
  if (a.state === 'attention_required' && b.state === 'attention_required') {
    const attentionOrder = ATTENTION_PRIORITY[a.pendingActionKind ?? 'interrupted']
      - ATTENTION_PRIORITY[b.pendingActionKind ?? 'interrupted']
    return attentionOrder || a.stateChangedAt - b.stateChangedAt
  }
  return b.stateChangedAt - a.stateChangedAt
}

export function projectWorkActivity(
  facts: WorkActivitySessionFact[],
  now: number = Date.now(),
): WorkActivityProjection {
  const byId = new Map(facts.map((fact) => [fact.sessionId, fact]))
  const membersByRoot = new Map<string, WorkActivitySessionFact[]>()
  for (const fact of facts) {
    const rootSessionId = resolveRootSessionId(fact, byId)
    const members = membersByRoot.get(rootSessionId) ?? []
    members.push(fact)
    membersByRoot.set(rootSessionId, members)
  }

  const sessions = [...membersByRoot.entries()]
    .map(([rootSessionId, members]) => buildWorkSession(rootSessionId, members, now))
    .filter((session): session is WorkSessionView => session !== null)
    .sort(compareWorkSessions)

  return {
    sessions,
    counts: {
      attention_required: sessions.filter((session) => session.state === 'attention_required').length,
      working: sessions.filter((session) => session.state === 'working').length,
      recently_completed: sessions.filter((session) => session.state === 'recently_completed').length,
    },
    generatedAt: now,
  }
}

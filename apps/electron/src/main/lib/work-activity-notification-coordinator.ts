import type { WorkActivityProjection, WorkSessionView } from '@domi/shared'

export interface WorkActivityNotificationSettings {
  notificationsEnabled: boolean
  attentionNotificationsEnabled: boolean
  completionNotificationsEnabled: boolean
  soundEnabled: boolean
}

export interface WorkActivityNotificationWindowState {
  visible: boolean
  focused: boolean
}

export type WorkActivityNotificationTarget =
  | { type: 'session'; rootSessionId: string }
  | { type: 'work_activity' }

export interface WorkActivityNotificationContent {
  kind: 'attention' | 'completion'
  title: string
  body: string
  target: WorkActivityNotificationTarget
  soundType: 'permissionRequest' | 'exitPlanMode' | 'taskComplete'
  playSound: boolean
}

export interface WorkActivityNotificationDelivery {
  channel: 'toast' | 'system'
  notification: WorkActivityNotificationContent
}

export interface WorkActivityNotificationPendingCompletion {
  key: string
  rootSessionId: string
  title: string
  workspaceName: string
  source: WorkSessionView['source']
  automationName?: string
  sessionIds: string[]
  queuedAt: number
  deliverAt: number
}

export interface WorkActivityNotificationPersistedState {
  version: 1
  initialized: boolean
  handled: Record<string, number>
  pendingCompletions: WorkActivityNotificationPendingCompletion[]
}

export interface WorkActivityNotificationPresence {
  activeSessionId: string | null
}

export interface WorkActivityNotificationCoordinatorDependencies<TTimer> {
  now: () => number
  getProjection: () => Promise<WorkActivityProjection>
  getSettings: () => WorkActivityNotificationSettings
  getWindowState: () => WorkActivityNotificationWindowState
  loadState: () => { exists: boolean; state: WorkActivityNotificationPersistedState }
  saveState: (state: WorkActivityNotificationPersistedState) => void
  deliver: (delivery: WorkActivityNotificationDelivery) => void
  setTimeout: (callback: () => void, delay: number) => TTimer
  clearTimeout: (timer: TTimer) => void
  completionMergeWindowMs?: number
  maxHandledTransitions?: number
}

const DEFAULT_COMPLETION_MERGE_WINDOW_MS = 10_000
const DEFAULT_MAX_HANDLED_TRANSITIONS = 4_000

function transitionKey(session: WorkSessionView): string {
  const discriminator = session.state === 'attention_required'
    ? session.pendingActionKind ?? 'attention'
    : session.state === 'recently_completed'
      ? session.outcome ?? 'unresolved'
      : 'working'
  return `${session.rootSessionId}:${session.state}:${session.stateChangedAt}:${discriminator}`
}

function emptyState(): WorkActivityNotificationPersistedState {
  return { version: 1, initialized: false, handled: {}, pendingCompletions: [] }
}

function cloneState(state: WorkActivityNotificationPersistedState): WorkActivityNotificationPersistedState {
  return {
    version: 1,
    initialized: state.initialized === true,
    handled: { ...state.handled },
    pendingCompletions: state.pendingCompletions.map((item) => ({ ...item })),
  }
}

function attentionTitle(session: WorkSessionView): string {
  switch (session.pendingActionKind) {
    case 'ask_user': return 'Agent 需要你的输入'
    case 'permission': return '需要权限确认'
    case 'plan_approval': return 'Agent 计划待审批'
    case 'ready_for_review': return '工作成果待验收'
    case 'conflict': return '工作同步需要处理'
    case 'failure': return 'Agent 工作失败'
    case 'interrupted': return 'Agent 工作已中断'
    default: return '工作需要关注'
  }
}

function attentionSoundType(session: WorkSessionView): WorkActivityNotificationContent['soundType'] {
  return session.pendingActionKind === 'plan_approval' ? 'exitPlanMode' : 'permissionRequest'
}

function isViewingSession(session: WorkSessionView, activeSessionId: string | null): boolean {
  if (!activeSessionId) return false
  return activeSessionId === session.rootSessionId
    || session.children.some((child) => child.sessionId === activeSessionId)
}

function deliveryChannel(windowState: WorkActivityNotificationWindowState): WorkActivityNotificationDelivery['channel'] {
  return windowState.visible && windowState.focused ? 'toast' : 'system'
}

function completionBody(items: WorkActivityNotificationPendingCompletion[]): string {
  if (items.length === 1) {
    const item = items[0]!
    return `${item.workspaceName} · ${item.title}`
  }
  const projectCount = new Set(items.map((item) => item.workspaceName)).size
  const automationCount = items.filter((item) => item.source === 'automation').length
  const parts = [`${projectCount} 个项目`]
  if (automationCount > 0) parts.push(`${automationCount} 个自动任务`)
  return parts.join(' · ')
}

/**
 * 以宿主 Work Activity 顶层状态转换为唯一事实源的通知协调器。
 *
 * Renderer 只负责呈现 Main 已决定的 Toast；投影读取、转换去重、完成合并和
 * 当前会话抑制全部留在这里，避免 Renderer 历史扫描或第二套状态推导。
 */
export class WorkActivityNotificationCoordinator<TTimer = ReturnType<typeof setTimeout>> {
  private readonly deps: WorkActivityNotificationCoordinatorDependencies<TTimer>
  private state: WorkActivityNotificationPersistedState = emptyState()
  private presence: WorkActivityNotificationPresence = { activeSessionId: null }
  private completionTimer: TTimer | null = null
  private evaluation: Promise<void> | null = null
  private evaluationRequested = false
  private startPromise: Promise<void> | null = null
  private disposed = false

  constructor(dependencies: WorkActivityNotificationCoordinatorDependencies<TTimer>) {
    this.deps = dependencies
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    if (this.disposed) return Promise.resolve()
    this.startPromise = (async () => {
      const loaded = this.deps.loadState()
      this.state = cloneState(loaded.state)
      const current = await this.deps.getProjection()

      if (!loaded.exists || !this.state.initialized) {
        const now = this.deps.now()
        for (const session of current.sessions) {
          if (this.isNotifiableState(session)) this.state.handled[transitionKey(session)] = now
        }
        this.state.initialized = true
        this.state.pendingCompletions = []
        this.persist()
        return
      }

      this.schedulePendingCompletionFlush()
      await this.evaluateProjection(current)
    })()
    return this.startPromise
  }

  updatePresence(presence: WorkActivityNotificationPresence): void {
    this.presence = presence
  }

  evaluateNow(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.evaluationRequested = true
    if (this.evaluation) return this.evaluation
    this.evaluation = (async () => {
      await this.start()
      while (this.evaluationRequested && !this.disposed) {
        this.evaluationRequested = false
        const current = await this.deps.getProjection()
        await this.evaluateProjection(current)
      }
    })().finally(() => {
      this.evaluation = null
    })
    return this.evaluation
  }

  dispose(): void {
    this.disposed = true
    if (this.completionTimer !== null) {
      this.deps.clearTimeout(this.completionTimer)
      this.completionTimer = null
    }
  }

  private isNotifiableState(session: WorkSessionView): boolean {
    return session.state === 'attention_required'
      || (session.state === 'recently_completed' && session.outcome === 'success')
  }

  private async evaluateProjection(projection: WorkActivityProjection): Promise<void> {
    const settings = this.deps.getSettings()
    const now = this.deps.now()
    let changed = false

    for (const session of projection.sessions) {
      if (!this.isNotifiableState(session)) continue
      const key = transitionKey(session)
      if (this.state.handled[key] !== undefined) continue

      // 无论开关或在场抑制结果如何，转换都会立即被消费，防止日后补发旧事件。
      this.state.handled[key] = now
      changed = true

      const windowState = this.deps.getWindowState()
      if (windowState.visible && windowState.focused && isViewingSession(session, this.presence.activeSessionId)) continue

      if (session.state === 'attention_required') {
        if (!settings.notificationsEnabled || !settings.attentionNotificationsEnabled) continue
        this.deps.deliver({
          channel: deliveryChannel(windowState),
          notification: {
            kind: 'attention',
            title: attentionTitle(session),
            body: `[${session.title}] ${session.reason}`,
            target: { type: 'session', rootSessionId: session.rootSessionId },
            soundType: attentionSoundType(session),
            playSound: settings.soundEnabled,
          },
        })
        continue
      }

      if (!settings.notificationsEnabled || !settings.completionNotificationsEnabled) continue
      // 固定窗口从本批第一项开始计时；窗口内后续完成共享同一截止时间，
      // 避免每项各自延后 10 秒而在真实时钟下被拆成多条通知。
      const deliverAt = this.state.pendingCompletions.length > 0
        ? Math.min(...this.state.pendingCompletions.map((item) => item.deliverAt))
        : now + (this.deps.completionMergeWindowMs ?? DEFAULT_COMPLETION_MERGE_WINDOW_MS)
      this.state.pendingCompletions.push({
        key,
        rootSessionId: session.rootSessionId,
        title: session.title,
        workspaceName: session.workspaceName,
        source: session.source,
        automationName: session.automationName,
        sessionIds: [session.rootSessionId, ...session.children.map((child) => child.sessionId)],
        queuedAt: now,
        deliverAt,
      })
    }

    if (changed) {
      this.pruneHandled(new Set([
        ...projection.sessions.filter((session) => this.isNotifiableState(session)).map(transitionKey),
        ...this.state.pendingCompletions.map((item) => item.key),
      ]))
      this.persist()
    }
    this.schedulePendingCompletionFlush()
  }

  private schedulePendingCompletionFlush(): void {
    if (this.disposed || this.completionTimer !== null || this.state.pendingCompletions.length === 0) return
    const earliest = Math.min(...this.state.pendingCompletions.map((item) => item.deliverAt))
    const delay = Math.max(0, earliest - this.deps.now())
    this.completionTimer = this.deps.setTimeout(() => {
      this.completionTimer = null
      void this.flushPendingCompletions()
    }, delay)
  }

  private async flushPendingCompletions(): Promise<void> {
    if (this.disposed) return
    const now = this.deps.now()
    const due = this.state.pendingCompletions.filter((item) => item.deliverAt <= now)
    if (due.length === 0) {
      this.schedulePendingCompletionFlush()
      return
    }

    this.state.pendingCompletions = this.state.pendingCompletions.filter((item) => item.deliverAt > now)
    this.persist()

    const settings = this.deps.getSettings()
    const windowState = this.deps.getWindowState()
    const visibleDue = windowState.visible && windowState.focused && this.presence.activeSessionId
      ? due.filter((item) => !item.sessionIds.includes(this.presence.activeSessionId!))
      : due
    if (visibleDue.length > 0 && settings.notificationsEnabled && settings.completionNotificationsEnabled) {
      this.deps.deliver({
        channel: deliveryChannel(windowState),
        notification: {
          kind: 'completion',
          title: visibleDue.length === 1 ? '1 项工作已完成' : `${visibleDue.length} 项工作已完成`,
          body: completionBody(visibleDue),
          target: visibleDue.length === 1
            ? { type: 'session', rootSessionId: visibleDue[0]!.rootSessionId }
            : { type: 'work_activity' },
          soundType: 'taskComplete',
          playSound: settings.soundEnabled,
        },
      })
    }
    this.schedulePendingCompletionFlush()
  }

  private pruneHandled(preserveKeys: Set<string> = new Set()): void {
    const max = this.deps.maxHandledTransitions ?? DEFAULT_MAX_HANDLED_TRANSITIONS
    const entries = Object.entries(this.state.handled)
    if (entries.length <= max) return
    const preserved = entries.filter(([key]) => preserveKeys.has(key))
    const disposable = entries.filter(([key]) => !preserveKeys.has(key)).sort((a, b) => b[1] - a[1])
    this.state.handled = Object.fromEntries([
      ...preserved,
      ...disposable.slice(0, Math.max(0, max - preserved.length)),
    ])
  }

  private persist(): void {
    this.deps.saveState(cloneState(this.state))
  }
}

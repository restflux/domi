import { describe, expect, test } from 'bun:test'
import type { WorkActivityProjection, WorkSessionView } from '@domi/shared'
import {
  WorkActivityNotificationCoordinator,
  type WorkActivityNotificationCoordinatorDependencies,
  type WorkActivityNotificationDelivery,
  type WorkActivityNotificationPersistedState,
} from './work-activity-notification-coordinator.ts'

interface Harness {
  coordinator: WorkActivityNotificationCoordinator<number>
  deliveries: WorkActivityNotificationDelivery[]
  saved: WorkActivityNotificationPersistedState[]
  setProjection: (sessions: WorkSessionView[]) => void
  setSettings: (updates: Partial<{ enabled: boolean; attention: boolean; completion: boolean; sound: boolean }>) => void
  setWindow: (updates: Partial<{ visible: boolean; focused: boolean }>) => void
  setActiveSession: (sessionId: string | null) => void
  runTimer: () => Promise<void>
}

function session(overrides: Partial<WorkSessionView> & Pick<WorkSessionView, 'rootSessionId' | 'state' | 'stateChangedAt'>): WorkSessionView {
  const { rootSessionId, state, stateChangedAt, ...rest } = overrides
  return {
    id: rootSessionId,
    rootSessionId,
    workspaceName: 'domi',
    title: `会话 ${rootSessionId}`,
    source: 'manual',
    state,
    reason: state === 'attention_required' ? '等待回答' : state === 'working' ? '正在工作' : '已完成',
    phaseSummary: state === 'recently_completed' ? '已完成' : '正在处理',
    stateChangedAt,
    unread: true,
    archived: false,
    outcome: state === 'recently_completed' ? 'success' : undefined,
    activeSessionIds: state === 'working' ? [rootSessionId] : [],
    completedChildren: 0,
    totalChildren: 0,
    tasks: [],
    children: [],
    ...rest,
  }
}

function projection(sessions: WorkSessionView[], now: number): WorkActivityProjection {
  return {
    sessions,
    counts: {
      attention_required: sessions.filter((item) => item.state === 'attention_required').length,
      working: sessions.filter((item) => item.state === 'working').length,
      recently_completed: sessions.filter((item) => item.state === 'recently_completed').length,
    },
    generatedAt: now,
  }
}

function createHarness(options: {
  persisted?: WorkActivityNotificationPersistedState
  hasPersistedState?: boolean
  initialSessions?: WorkSessionView[]
} = {}): Harness {
  let now = 1_000
  let currentProjection = projection(options.initialSessions ?? [], now)
  let settings = { enabled: true, attention: true, completion: true, sound: true }
  let windowState = { visible: true, focused: true }
  let activeSessionId: string | null = null
  const deliveries: WorkActivityNotificationDelivery[] = []
  const saved: WorkActivityNotificationPersistedState[] = []
  let nextTimerId = 1
  let timer: { id: number; callback: () => void; delay: number } | null = null

  const dependencies: WorkActivityNotificationCoordinatorDependencies<number> = {
    now: () => now,
    getProjection: async () => currentProjection,
    getSettings: () => ({
      notificationsEnabled: settings.enabled,
      attentionNotificationsEnabled: settings.attention,
      completionNotificationsEnabled: settings.completion,
      soundEnabled: settings.sound,
    }),
    getWindowState: () => windowState,
    loadState: () => ({
      exists: options.hasPersistedState ?? options.persisted !== undefined,
      state: options.persisted ?? { version: 1, initialized: false, handled: {}, pendingCompletions: [] },
    }),
    saveState: (state) => {
      saved.push(structuredClone(state))
    },
    deliver: (delivery) => {
      deliveries.push(delivery)
    },
    setTimeout: (callback, delay) => {
      timer = { id: nextTimerId++, callback, delay }
      return timer.id
    },
    clearTimeout: (id) => {
      if (timer?.id === id) timer = null
    },
    completionMergeWindowMs: 10_000,
  }

  const coordinator = new WorkActivityNotificationCoordinator(dependencies)
  return {
    coordinator,
    deliveries,
    saved,
    setProjection: (sessions) => {
      now += 1_000
      currentProjection = projection(sessions, now)
    },
    setSettings: (updates) => { settings = { ...settings, ...updates } },
    setWindow: (updates) => { windowState = { ...windowState, ...updates } },
    setActiveSession: (sessionId) => {
      activeSessionId = sessionId
      coordinator.updatePresence({ activeSessionId })
    },
    runTimer: async () => {
      if (!timer) throw new Error('没有待运行的 timer')
      const pending = timer
      timer = null
      now += pending.delay
      pending.callback()
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe('Work Activity 通知协调器', () => {
  test('首次启用只建立宿主投影基线，不把历史状态当成新通知', async () => {
    const attention = session({ rootSessionId: 'root-a', state: 'attention_required', stateChangedAt: 900 })
    const harness = createHarness({ initialSessions: [attention], hasPersistedState: false })

    await harness.coordinator.start()

    expect(harness.deliveries).toEqual([])
    expect(Object.keys(harness.saved.at(-1)?.handled ?? {})).toHaveLength(1)
  })

  test('需要关注转换立即通知一次，重复投影不会重复通知', async () => {
    const working = session({ rootSessionId: 'root-a', state: 'working', stateChangedAt: 1_000 })
    const harness = createHarness({ initialSessions: [working], hasPersistedState: false })
    await harness.coordinator.start()

    harness.setProjection([session({
      rootSessionId: 'root-a',
      state: 'attention_required',
      stateChangedAt: 2_000,
      pendingActionKind: 'ask_user',
      reason: '等待回答',
    })])
    await harness.coordinator.evaluateNow()
    await harness.coordinator.evaluateNow()

    expect(harness.deliveries).toHaveLength(1)
    expect(harness.deliveries[0]).toMatchObject({
      channel: 'toast',
      notification: { kind: 'attention', target: { type: 'session', rootSessionId: 'root-a' } },
    })
  })

  test('同一宿主转换仅更新展示原因时不会产生第二条通知', async () => {
    const harness = createHarness({ initialSessions: [], hasPersistedState: false })
    await harness.coordinator.start()
    harness.setProjection([session({
      rootSessionId: 'root-a', state: 'attention_required', stateChangedAt: 2_000,
      pendingActionKind: 'permission', reason: '等待 Bash 权限',
    })])
    await harness.coordinator.evaluateNow()
    harness.setProjection([session({
      rootSessionId: 'root-a', state: 'attention_required', stateChangedAt: 2_000,
      pendingActionKind: 'permission', reason: '等待权限确认',
    })])
    await harness.coordinator.evaluateNow()

    expect(harness.deliveries).toHaveLength(1)
  })

  test('正在查看发生转换的 Work Session 时不重复打扰，但仍持久去重', async () => {
    const harness = createHarness({ initialSessions: [], hasPersistedState: false })
    await harness.coordinator.start()
    harness.setActiveSession('child-a')
    harness.setProjection([session({
      rootSessionId: 'root-a',
      state: 'attention_required',
      stateChangedAt: 2_000,
      pendingActionKind: 'permission',
      children: [{
        sessionId: 'child-a', title: '子会话', active: false, status: 'attention_required',
        reason: '等待权限确认', phaseSummary: '等待权限确认', tasks: [],
      }],
    })])

    await harness.coordinator.evaluateNow()
    await harness.coordinator.evaluateNow()

    expect(harness.deliveries).toEqual([])
    expect(Object.keys(harness.saved.at(-1)?.handled ?? {})).toHaveLength(1)
  })

  test('前台其他会话使用 Toast，后台或最小化使用系统通知', async () => {
    const harness = createHarness({ initialSessions: [], hasPersistedState: false })
    await harness.coordinator.start()

    harness.setProjection([session({ rootSessionId: 'front', state: 'attention_required', stateChangedAt: 2_000 })])
    await harness.coordinator.evaluateNow()
    harness.setWindow({ focused: false })
    harness.setProjection([
      session({ rootSessionId: 'front', state: 'attention_required', stateChangedAt: 2_000 }),
      session({ rootSessionId: 'back', state: 'attention_required', stateChangedAt: 3_000 }),
    ])
    await harness.coordinator.evaluateNow()

    expect(harness.deliveries.map((item) => item.channel)).toEqual(['toast', 'system'])
  })

  test('应用在后台时即使原会话仍是活动标签，也不能误判为正在查看', async () => {
    const harness = createHarness({ initialSessions: [], hasPersistedState: false })
    await harness.coordinator.start()
    harness.setActiveSession('root-a')
    harness.setWindow({ focused: false })
    harness.setProjection([session({ rootSessionId: 'root-a', state: 'attention_required', stateChangedAt: 2_000 })])

    await harness.coordinator.evaluateNow()

    expect(harness.deliveries).toHaveLength(1)
    expect(harness.deliveries[0]?.channel).toBe('system')
  })

  test('十秒窗口内的普通成功完成合并，并保留项目和自动任务汇总', async () => {
    const harness = createHarness({ initialSessions: [], hasPersistedState: false })
    await harness.coordinator.start()

    harness.setProjection([session({ rootSessionId: 'done-a', state: 'recently_completed', stateChangedAt: 2_000 })])
    await harness.coordinator.evaluateNow()
    harness.setProjection([
      session({ rootSessionId: 'done-a', state: 'recently_completed', stateChangedAt: 2_000 }),
      session({
        rootSessionId: 'done-b', state: 'recently_completed', stateChangedAt: 3_000,
        workspaceName: 'website', source: 'automation', automationName: '每日检查',
      }),
    ])
    await harness.coordinator.evaluateNow()

    expect(harness.deliveries).toEqual([])
    const pendingDeliveries = harness.saved.at(-1)?.pendingCompletions ?? []
    expect(new Set(pendingDeliveries.map((item) => item.deliverAt)).size).toBe(1)
    await harness.runTimer()

    expect(harness.deliveries).toHaveLength(1)
    expect(harness.deliveries[0]).toMatchObject({
      notification: {
        kind: 'completion',
        title: '2 项工作已完成',
        target: { type: 'work_activity' },
      },
    })
    expect(harness.deliveries[0]?.notification.body).toContain('2 个项目')
    expect(harness.deliveries[0]?.notification.body).toContain('1 个自动任务')
  })

  test('需要关注与普通完成不混合，关注立即发出且完成仍按窗口汇总', async () => {
    const harness = createHarness({ initialSessions: [], hasPersistedState: false })
    await harness.coordinator.start()
    harness.setProjection([
      session({ rootSessionId: 'done-a', state: 'recently_completed', stateChangedAt: 2_000 }),
      session({
        rootSessionId: 'attention-a', state: 'attention_required', stateChangedAt: 2_100,
        pendingActionKind: 'ready_for_review', reason: '工作成果待验收',
      }),
    ])

    await harness.coordinator.evaluateNow()

    expect(harness.deliveries).toHaveLength(1)
    expect(harness.deliveries[0]?.notification.kind).toBe('attention')
    await harness.runTimer()
    expect(harness.deliveries.map((item) => item.notification.kind)).toEqual(['attention', 'completion'])
  })

  test('关闭提示音时仍呈现通知，但 Main 指令不要求 Renderer 播放声音', async () => {
    const harness = createHarness({ initialSessions: [], hasPersistedState: false })
    await harness.coordinator.start()
    harness.setSettings({ sound: false })
    harness.setProjection([session({ rootSessionId: 'root-a', state: 'attention_required', stateChangedAt: 2_000 })])

    await harness.coordinator.evaluateNow()

    expect(harness.deliveries[0]?.notification.playSound).toBe(false)
  })

  test('完成合并等待期间切回对应子会话时抑制该项，但不影响同批其他工作', async () => {
    const harness = createHarness({ initialSessions: [], hasPersistedState: false })
    await harness.coordinator.start()
    harness.setProjection([
      session({
        rootSessionId: 'done-a', state: 'recently_completed', stateChangedAt: 2_000,
        children: [{
          sessionId: 'child-a', title: '子会话', active: false, status: 'completed',
          reason: '已完成', phaseSummary: '已完成', tasks: [],
        }],
      }),
      session({ rootSessionId: 'done-b', state: 'recently_completed', stateChangedAt: 2_100 }),
    ])
    await harness.coordinator.evaluateNow()
    harness.setActiveSession('child-a')

    await harness.runTimer()

    expect(harness.deliveries).toHaveLength(1)
    expect(harness.deliveries[0]?.notification).toMatchObject({
      title: '1 项工作已完成',
      target: { type: 'session', rootSessionId: 'done-b' },
    })
  })

  test('关闭总开关或细分开关时不通知，后续打开也不补发旧转换', async () => {
    const globallyDisabled = createHarness({ initialSessions: [], hasPersistedState: false })
    await globallyDisabled.coordinator.start()
    globallyDisabled.setSettings({ enabled: false })
    globallyDisabled.setProjection([session({ rootSessionId: 'root-a', state: 'attention_required', stateChangedAt: 2_000 })])
    await globallyDisabled.coordinator.evaluateNow()
    globallyDisabled.setSettings({ enabled: true })
    await globallyDisabled.coordinator.evaluateNow()

    const detailDisabled = createHarness({ initialSessions: [], hasPersistedState: false })
    await detailDisabled.coordinator.start()
    detailDisabled.setSettings({ attention: false, completion: false })
    detailDisabled.setProjection([
      session({ rootSessionId: 'attention', state: 'attention_required', stateChangedAt: 2_000 }),
      session({ rootSessionId: 'done', state: 'recently_completed', stateChangedAt: 2_100 }),
    ])
    await detailDisabled.coordinator.evaluateNow()
    detailDisabled.setSettings({ attention: true, completion: true })
    await detailDisabled.coordinator.evaluateNow()

    expect(globallyDisabled.deliveries).toEqual([])
    expect(detailDisabled.deliveries).toEqual([])
  })

  test('子 Agent 单独完成但顶层仍在工作时不产生完成通知', async () => {
    const harness = createHarness({ initialSessions: [], hasPersistedState: false })
    await harness.coordinator.start()
    harness.setProjection([session({
      rootSessionId: 'root-a', state: 'working', stateChangedAt: 2_000,
      completedChildren: 1, totalChildren: 2,
      children: [{
        sessionId: 'child-a', title: '已完成子会话', active: false, status: 'completed',
        reason: '已完成', phaseSummary: '已完成', tasks: [],
      }],
    })])

    await harness.coordinator.evaluateNow()

    expect(harness.deliveries).toEqual([])
  })

  test('重启后恢复尚未到期的完成合并，不丢失也不重复排队', async () => {
    const first = createHarness({ initialSessions: [], hasPersistedState: false })
    await first.coordinator.start()
    const completed = session({ rootSessionId: 'done-a', state: 'recently_completed', stateChangedAt: 2_000 })
    first.setProjection([completed])
    await first.coordinator.evaluateNow()
    const persisted = first.saved.at(-1)
    if (!persisted) throw new Error('未保存完成合并状态')

    const restarted = createHarness({ persisted, initialSessions: [completed] })
    await restarted.coordinator.start()
    await restarted.runTimer()

    expect(restarted.deliveries).toHaveLength(1)
    expect(restarted.deliveries[0]?.notification.target).toEqual({ type: 'session', rootSessionId: 'done-a' })
  })

  test('投影读取期间连续失效会再对账一次，不漏掉较晚转换', async () => {
    let calls = 0
    let latest = projection([], 1_000)
    let releaseRead: () => void = () => undefined
    const deliveries: WorkActivityNotificationDelivery[] = []
    const coordinator = new WorkActivityNotificationCoordinator<number>({
      now: () => 3_000,
      getProjection: async () => {
        calls += 1
        if (calls === 2) await new Promise<void>((resolve) => { releaseRead = resolve })
        return latest
      },
      getSettings: () => ({
        notificationsEnabled: true,
        attentionNotificationsEnabled: true,
        completionNotificationsEnabled: true,
        soundEnabled: false,
      }),
      getWindowState: () => ({ visible: true, focused: true }),
      loadState: () => ({ exists: false, state: { version: 1, initialized: false, handled: {}, pendingCompletions: [] } }),
      saveState: () => undefined,
      deliver: (delivery) => deliveries.push(delivery),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    })
    await coordinator.start()

    const first = coordinator.evaluateNow()
    await Promise.resolve()
    latest = projection([session({ rootSessionId: 'late', state: 'attention_required', stateChangedAt: 2_000 })], 3_000)
    const second = coordinator.evaluateNow()
    releaseRead()
    await Promise.all([first, second])

    expect(calls).toBe(3)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]?.notification.target).toEqual({ type: 'session', rootSessionId: 'late' })
  })

  test('重启读取持久去重键后不会重复通知同一状态转换', async () => {
    const existing = session({ rootSessionId: 'root-a', state: 'attention_required', stateChangedAt: 2_000 })
    const first = createHarness({ initialSessions: [], hasPersistedState: false })
    await first.coordinator.start()
    first.setProjection([existing])
    await first.coordinator.evaluateNow()
    expect(first.deliveries).toHaveLength(1)

    const persisted = first.saved.at(-1)
    if (!persisted) throw new Error('未保存去重状态')
    const restarted = createHarness({ persisted, initialSessions: [existing] })
    await restarted.coordinator.start()

    expect(restarted.deliveries).toEqual([])
  })
})

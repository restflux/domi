import { describe, expect, test } from 'bun:test'
import type { WorkActivitySessionFact } from './types/work-activity.ts'
import { projectWorkActivity } from './work-activity-projector.ts'

const NOW = new Date(2026, 7, 24, 14, 0, 0).getTime()

function fact(overrides: Partial<WorkActivitySessionFact> = {}): WorkActivitySessionFact {
  return {
    sessionId: 'parent',
    workspaceId: 'domi',
    workspaceName: 'domi',
    title: 'AI 工作面板',
    source: 'manual',
    archived: false,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
    active: false,
    run: { status: 'success', startedAt: NOW - 60_000, finishedAt: NOW - 1_000 },
    pendingActions: [],
    tasks: [],
    ...overrides,
  }
}

describe('Work Activity projector', () => {
  test('Given a parent is active and its child completed When projecting Then the collaboration tree is one working row', () => {
    const projection = projectWorkActivity([
      fact({ active: true, run: { status: 'running', startedAt: NOW - 60_000 }, phaseSummary: '正在实现投影' }),
      fact({
        sessionId: 'child', parentSessionId: 'parent', rootSessionId: 'parent', title: '审查状态模型',
        active: false, delegationStatus: 'completed', run: { status: 'success', startedAt: NOW - 40_000, finishedAt: NOW - 5_000 },
      }),
    ], NOW)

    expect(projection.counts).toEqual({ attention_required: 0, working: 1, recently_completed: 0 })
    expect(projection.sessions[0]).toMatchObject({
      rootSessionId: 'parent', state: 'working', phaseSummary: '正在实现投影', completedChildren: 1, totalChildren: 1,
    })
  })

  test('Given a parent runs and a child waits for permission When projecting Then attention wins for the whole tree', () => {
    const projection = projectWorkActivity([
      fact({ active: true, run: { status: 'running', startedAt: NOW - 60_000 } }),
      fact({
        sessionId: 'child', parentSessionId: 'parent', rootSessionId: 'parent', title: '验证权限', active: true,
        run: { status: 'running', startedAt: NOW - 50_000 },
        pendingActions: [{ kind: 'permission', summary: '等待权限确认', occurredAt: NOW - 30_000 }],
      }),
    ], NOW)

    expect(projection.sessions[0]).toMatchObject({
      state: 'attention_required', pendingActionKind: 'permission', reason: '1 个子会话等待权限确认',
    })
  })

  test('Given Ready for Review and completed children When projecting Then the owner still requires attention', () => {
    const projection = projectWorkActivity([
      fact({ pendingActions: [{ kind: 'ready_for_review', summary: '等待验收', occurredAt: NOW - 10_000 }] }),
      fact({ sessionId: 'child', parentSessionId: 'parent', rootSessionId: 'parent', title: '完成测试', delegationStatus: 'completed' }),
    ], NOW)

    expect(projection.sessions[0]).toMatchObject({ state: 'attention_required', pendingActionKind: 'ready_for_review', reason: '等待验收' })
  })

  test('Given a failed run When it is acknowledged Then the failure stays visible as unresolved completion', () => {
    const failed = fact({
      run: { status: 'failed', startedAt: NOW - 30_000, finishedAt: NOW - 5_000, error: '测试失败' },
    })
    expect(projectWorkActivity([failed], NOW).sessions[0]).toMatchObject({
      state: 'attention_required', pendingActionKind: 'failure', outcome: 'failed', unread: true,
    })

    const acknowledged = projectWorkActivity([{ ...failed, acknowledgedOutcomeAt: NOW - 1_000 }], NOW).sessions[0]
    expect(acknowledged).toMatchObject({ state: 'recently_completed', outcome: 'unresolved', reason: '失败已知晓' })
  })

  test('Given a pending answer has been viewed When projecting Then unread clears without clearing Pending Action', () => {
    const projection = projectWorkActivity([fact({
      pendingActions: [{ kind: 'ask_user', summary: '等待回答', occurredAt: NOW - 30_000 }],
      viewedAt: NOW - 10_000,
    })], NOW)

    expect(projection.sessions[0]).toMatchObject({ state: 'attention_required', pendingActionKind: 'ask_user', unread: false })
  })

  test('Given an active visible task and a pending action When projecting Then activeForm remains the trusted phase summary', () => {
    const projection = projectWorkActivity([fact({
      active: true,
      run: { status: 'running', startedAt: NOW - 60_000 },
      pendingActions: [{ kind: 'permission', summary: '等待权限确认', occurredAt: NOW - 30_000 }],
      tasks: [{ id: '1', subject: '完成验证', status: 'in_progress', activeForm: '正在运行聚焦测试' }],
    })], NOW)

    expect(projection.sessions[0]).toMatchObject({
      state: 'attention_required',
      reason: '等待权限确认',
      phaseSummary: '正在运行聚焦测试',
    })
  })

  test('Given archived sessions When projecting Then active or pending stays visible but an ordinary terminal session is hidden', () => {
    const projection = projectWorkActivity([
      fact({ sessionId: 'running', archived: true, active: true, run: { status: 'running', startedAt: NOW - 20_000 } }),
      fact({ sessionId: 'pending', archived: true, pendingActions: [{ kind: 'plan_approval', summary: '等待计划审批', occurredAt: NOW - 10_000 }] }),
      fact({ sessionId: 'done', archived: true }),
    ], NOW)

    expect(projection.sessions.map((item) => item.rootSessionId)).toEqual(['pending', 'running'])
  })

  test('Given a previously running session has no real active run after restart When projecting Then it is interrupted', () => {
    const projection = projectWorkActivity([fact({
      active: false,
      run: { status: 'running', startedAt: NOW - 60_000 },
    })], NOW)

    expect(projection.sessions[0]).toMatchObject({
      state: 'attention_required', pendingActionKind: 'interrupted', outcome: 'interrupted', reason: '上次运行异常中断',
    })
  })

  test('Given different states and wait times When projecting Then attention type and oldest wait determine sorting', () => {
    const projection = projectWorkActivity([
      fact({ sessionId: 'working', active: true, run: { status: 'running', startedAt: NOW - 100_000 } }),
      fact({ sessionId: 'new-attention', pendingActions: [{ kind: 'ask_user', summary: '等待回答', occurredAt: NOW - 10_000 }] }),
      fact({ sessionId: 'old-attention', pendingActions: [{ kind: 'permission', summary: '等待权限确认', occurredAt: NOW - 20_000 }] }),
      fact({ sessionId: 'old-review', pendingActions: [{ kind: 'ready_for_review', summary: '等待验收', occurredAt: NOW - 200_000 }] }),
      fact({ sessionId: 'conflict', pendingActions: [{ kind: 'conflict', summary: '存在冲突', occurredAt: NOW - 5_000 }] }),
      fact({ sessionId: 'done' }),
    ], NOW)

    expect(projection.sessions.map((item) => item.rootSessionId)).toEqual([
      'old-attention',
      'new-attention',
      'conflict',
      'old-review',
      'working',
      'done',
    ])
  })

  test('Given only a persisted failed delegation status When projecting Then the child failure still requires attention', () => {
    const projection = projectWorkActivity([
      fact(),
      fact({
        sessionId: 'child',
        parentSessionId: 'parent',
        rootSessionId: 'parent',
        title: '独立审查',
        run: undefined,
        delegationStatus: 'failed',
        updatedAt: NOW - 2_000,
      }),
    ], NOW)

    expect(projection.sessions[0]).toMatchObject({
      state: 'attention_required',
      pendingActionKind: 'failure',
      reason: '1 个子会话运行失败',
    })
  })
})

import { describe, expect, test } from 'bun:test'
import {
  buildRetryInNewSessionIntent,
  buildSessionTargetViewModel,
  getSessionTargetInteraction,
  type SessionTargetDisplayInput,
  type SessionTargetKind,
  type SessionTargetOwnership,
  type SessionTargetPendingAction,
  type SessionTargetPhase,
} from './session-target-view-model.ts'

interface TargetOverrides {
  projectName?: string
  target?: SessionTargetKind
  phase?: SessionTargetPhase
  delivery?: SessionTargetDisplayInput['delivery']
  currentBranch?: string | null
  headOid?: string | null
  sourceBranch?: string | null
  checkoutId?: string
  ownership?: SessionTargetOwnership
  dirty?: boolean
  pendingAction?: SessionTargetPendingAction | null
  running?: boolean
}

function target(overrides: TargetOverrides = {}): SessionTargetDisplayInput {
  const kind = overrides.target ?? 'local'
  const phase = overrides.phase ?? 'ready'
  const currentBranch = overrides.currentBranch === undefined ? 'main' : overrides.currentBranch
  const headOid = overrides.headOid === undefined ? '1234567890abcdef' : overrides.headOid
  const sourceBranch = overrides.sourceBranch ?? currentBranch ?? 'HEAD'

  return {
    project: { name: overrides.projectName ?? 'domi' },
    checkout: {
      id: overrides.checkoutId ?? (kind === 'isolated' ? 'm2-ui-4f91' : `local:domi`),
      kind,
      phase,
    },
    source: kind === 'unselected' || !headOid ? null : { ref: sourceBranch, oid: headOid },
    current: kind === 'unselected' || !headOid ? null : { branch: currentBranch, oid: headOid },
    ownership: overrides.ownership ?? 'owner',
    dirty: overrides.dirty ?? false,
    pendingAction: overrides.pendingAction ?? null,
    running: overrides.running ?? false,
    ...(overrides.delivery ? { delivery: overrides.delivery } : {}),
  }
}

describe('Session Target renderer view model', () => {
  test('Given Local on main When display data is built Then project, target, branch, and short HEAD stay identifiable', () => {
    const model = buildSessionTargetViewModel(target())

    expect(model.identity).toEqual({
      projectName: 'domi',
      targetLabel: 'Local',
      branchLabel: 'main',
      headLabel: '1234567',
      sourceLabel: null,
    })
  })

  test('Given an isolated detached checkout from main When display data is built Then Worktree and its source stay distinct from the current branch', () => {
    const model = buildSessionTargetViewModel(target({
      target: 'isolated',
      currentBranch: null,
      sourceBranch: 'refs/heads/main',
      checkoutId: 'm2-ui-4f91',
    }))

    expect(model.identity).toEqual({
      projectName: 'domi',
      targetLabel: 'Worktree',
      branchLabel: 'Detached',
      headLabel: '1234567',
      sourceLabel: '来自 main',
    })
  })

  test('Given an isolated checkout manually switched to a branch When display data is built Then current branch and original source remain separately visible', () => {
    const model = buildSessionTargetViewModel(target({
      target: 'isolated',
      currentBranch: 'feat/manual-checkout',
      sourceBranch: 'main',
      checkoutId: 'm2-ui-4f91',
    }))

    expect(model.identity.branchLabel).toBe('feat/manual-checkout')
    expect(model.identity.sourceLabel).toBe('来自 main')
  })

  test('Given retry in a new Pi session When intent is built Then prompt waits for target selection instead of immediate send', () => {
    expect(buildRetryInNewSessionIntent('source-session')).toEqual({
      prompt: '请读取 &session:source-session 的历史，然后从上个会话停止的位置继续。',
      mentionedSessionIds: ['source-session'],
      markAsDraft: true,
      delivery: 'after_target_selection',
    })
  })

  test('Given the owner has a dirty ready Worktree When actions are built Then Apply and confirmed Discard are available', () => {
    const model = buildSessionTargetViewModel(target({
      target: 'isolated',
      checkoutId: 'm2-ui-4f91',
      dirty: true,
    }))

    expect(model.chooser.visible).toBeFalse()
    expect(model.actions.apply).toEqual({ visible: true, enabled: true, pending: false })
    expect(model.actions.discard).toEqual({ visible: true, enabled: true, pending: false })
    expect(model.discardNeedsConfirmation).toBeTrue()
  })

  test('Given an owner reopens a clean Worktree with committed changes after continuing the conversation When actions are built Then Apply and Discard remain reachable without a completion flag', () => {
    const model = buildSessionTargetViewModel(target({
      target: 'isolated',
      checkoutId: 'm2-ui-4f91',
      dirty: false,
    }))

    expect(model.actions.apply).toEqual({ visible: true, enabled: true, pending: false })
    expect(model.actions.discard).toEqual({ visible: true, enabled: true, pending: false })
    expect(model.discardNeedsConfirmation).toBeFalse()
  })

  test('Given a child session inherits a Worktree When actions are built Then it cannot Apply or Discard the parent checkout', () => {
    const model = buildSessionTargetViewModel(target({
      target: 'isolated',
      checkoutId: 'parent-7ca2',
      ownership: 'inherited',
    }))

    expect(model.inheritanceLabel).toBe('共享父会话 Worktree')
    expect(model.actions.apply.visible).toBeFalse()
    expect(model.actions.discard.visible).toBeFalse()
  })

  test('Given an isolated owner is running When actions are built Then lifecycle actions are disabled', () => {
    const ready = buildSessionTargetViewModel(target({
      target: 'isolated',
      checkoutId: 'm2-ui-4f91',
      dirty: true,
      running: true,
    }))
    const recovery = buildSessionTargetViewModel(target({
      target: 'isolated',
      phase: 'recovery_required',
      checkoutId: 'm2-ui-4f91',
      running: true,
    }))

    expect(ready.actions.apply.enabled).toBeFalse()
    expect(ready.actions.discard.enabled).toBeFalse()
    expect(recovery.actions.recover).toEqual({ visible: true, enabled: false, pending: false })
  })

  test('Given Apply is pending When actions are built Then duplicate owner actions are disabled and progress is explicit', () => {
    const model = buildSessionTargetViewModel(target({
      target: 'isolated',
      phase: 'applying',
      checkoutId: 'm2-ui-4f91',
      pendingAction: 'apply',
    }))

    const discarding = buildSessionTargetViewModel(target({
      target: 'isolated',
      checkoutId: 'm2-ui-4f91',
      dirty: true,
      pendingAction: 'discard',
    }))

    expect(model.status).toEqual({ label: '正在应用修改', tone: 'progress' })
    expect(model.actions.apply).toEqual({ visible: true, enabled: false, pending: true })
    expect(model.actions.discard.enabled).toBeFalse()
    expect(discarding.actions.apply.enabled).toBeFalse()
    expect(discarding.actions.discard).toEqual({ visible: true, enabled: false, pending: true })
  })

  test('Given an owner checkout requires recovery When actions are built Then Recover and explicit Discard both remain actionable', () => {
    const model = buildSessionTargetViewModel(target({
      target: 'isolated',
      phase: 'recovery_required',
      checkoutId: 'm2-ui-4f91',
      dirty: true,
    }))

    const recovering = buildSessionTargetViewModel(target({
      target: 'isolated',
      phase: 'recovery_required',
      checkoutId: 'm2-ui-4f91',
      pendingAction: 'recover',
    }))

    expect(model.status).toEqual({ label: '需要恢复', tone: 'warning' })
    expect(model.actions.apply.enabled).toBeFalse()
    expect(model.actions.discard).toEqual({ visible: true, enabled: true, pending: false })
    expect(model.actions.recover).toEqual({ visible: true, enabled: true, pending: false })
    expect(recovering.actions.recover).toEqual({ visible: true, enabled: false, pending: true })
  })

  test('Given a new session has no target When display data is built Then it offers only Local and Worktree without path or branch inputs', () => {
    const model = buildSessionTargetViewModel(target({
      target: 'unselected',
      phase: 'unselected',
      currentBranch: null,
      headOid: null,
    }))

    expect(model.chooser).toEqual({
      visible: true,
      options: [
        { choice: 'local', label: 'Local', description: '直接在当前项目中工作' },
        { choice: 'isolated', label: 'Worktree', description: '基于当前 HEAD 创建，不复制 Local 未提交修改' },
      ],
    })
    // 未绑定新会话默认显示 Local，不展示分支/HEAD 占位。
    expect(model.identity).toEqual({
      projectName: 'domi',
      targetLabel: 'Local',
      branchLabel: '',
      headLabel: '',
      sourceLabel: null,
    })
    expect(model.actions.apply.visible).toBeFalse()
    expect(model.actions.discard.visible).toBeFalse()
  })

  test('Given a cold-start Pi session is persisted unselected but is no longer a draft When send and visibility are derived Then the chooser is visible and the first message is not blocked', () => {
    expect(getSessionTargetInteraction({
      hasTarget: false,
      selectionRequired: true,
    })).toEqual({
      showControls: true,
      requireChoiceBeforeSend: false,
    })
  })

  test('Given any Agent session When visibility is derived Then Session Target controls remain available without blocking first send', () => {
    expect(getSessionTargetInteraction({ hasTarget: false, selectionRequired: true })).toEqual({
      showControls: true,
      requireChoiceBeforeSend: false,
    })
    expect(getSessionTargetInteraction({ hasTarget: true, selectionRequired: false })).toEqual({
      showControls: true,
      requireChoiceBeforeSend: false,
    })
  })

  test('Given a Worktree advances through non-ready phases When status is built Then preparing and discarded remain explicit', () => {
    const preparing = buildSessionTargetViewModel(target({
      target: 'isolated',
      phase: 'preparing',
      checkoutId: 'm2-ui-4f91',
    }))
    const discarded = buildSessionTargetViewModel(target({
      target: 'isolated',
      phase: 'discarded',
      checkoutId: 'm2-ui-4f91',
      delivery: {
        state: 'ready_for_review',
        review: {
          reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: '已准备验收', validationStatus: 'passed',
          tests: [], changedFiles: ['src/a.ts'], suggestedCommitMessage: 'fix: task',
        },
      },
    }))

    expect(preparing.status).toEqual({ label: '正在准备 Worktree', tone: 'progress' })
    expect(discarded.status).toEqual({ label: '已放弃', tone: 'muted' })
    expect(discarded.actions.apply.enabled).toBeFalse()
  })

  test('Given the shared SessionTargetView shape When it reaches the renderer seam Then no domain type copy is required', () => {
    const sharedViewShape = {
      project: { id: 'project-1', name: 'domi' },
      checkout: {
        id: '12345678-abcd-4ef0',
        kind: 'isolated' as const,
        label: 'Isolated Checkout',
        phase: 'ready' as const,
      },
      source: { ref: 'refs/heads/main', oid: 'abcdef0123456789' },
      current: { branch: null, oid: 'abcdef0123456789' },
      ownership: 'owner' as const,
      dirty: true,
      revision: 3,
    }

    const model = buildSessionTargetViewModel(sharedViewShape)

    expect(model.identity.targetLabel).toBe('Worktree')
    expect(model.identity.sourceLabel).toBe('来自 main')
  })
})

import { describe, expect, test } from 'bun:test'
import type { AgentWorkspace, SessionTargetView } from '@domi/shared'
import { SessionCheckoutError } from './session-checkout/index.ts'
import {
  bindAgentSessionTargetForLaunch,
  resolveAgentSessionTarget,
  resolvePiForkTargetChoice,
} from './agent-session-target.ts'
import type { CheckoutLease, SessionCheckoutModule } from './session-checkout/index.ts'

const workspace: Pick<AgentWorkspace, 'slug'> = { slug: 'project-a' }

function createCheckoutModule(lease: CheckoutLease): SessionCheckoutModule & {
  bindings: Array<{ sessionId: string; choice: { kind: 'local' } | { kind: 'inherit'; parentSessionId: string } }>
} {
  const bindings: Array<{
    sessionId: string
    choice: { kind: 'local' } | { kind: 'inherit'; parentSessionId: string }
  }> = []
  return {
    bindings,
    inspect: async () => { throw new Error('测试不使用 inspect') },
    readSessionDeliveries: () => new Map(),
    readSessionChangedFiles: () => [],
    runExclusiveSessionMutation: async () => { throw new Error('测试不使用 runExclusiveSessionMutation') },
    lease: async () => lease,
    markReadyForReview: async () => { throw new Error('测试不使用 markReadyForReview') },
    operate: async () => { throw new Error('测试不使用 operate') },
    listManagedWorktrees: async () => [],
    inspectManagedWorktreeCleanup: async () => [],
    bulkCleanupManagedWorktrees: async () => ({ cleaned: [], retained: [] }),
    manageManagedWorktree: async () => { throw new Error('测试不使用 manageManagedWorktree') },
    resolveManagedRootForReveal: async () => { throw new Error('测试不使用 resolveManagedRootForReveal') },
    cleanupExpiredRetained: async () => [],
    assertReleaseSession: async () => { throw new Error('测试不使用 assertReleaseSession') },
    releaseSession: async () => { throw new Error('测试不使用 releaseSession') },
    reconcile: async () => ({
      recoveryRequiredCheckoutIds: [],
      orphanedCheckoutIds: [],
      dirtyOrphanedCheckoutIds: [],
      retainedCheckoutCount: 0,
    }),
    cloneIsolatedTarget: async () => { throw new Error('测试不复制 isolated') },
    bindVerifiedIsolated: async () => { throw new Error('测试不创建 verified isolated') },
    beginNextIteration: async () => { throw new Error('测试不创建下一轮 isolated') },
    captureSessionHandoff: async () => { throw new Error('测试不捕获 session handoff') },
    captureRecoveryHandoff: async () => { throw new Error('测试不捕获 recovery handoff') },
    bind: async (sessionId, choice) => {
      if (choice.kind === 'isolated') throw new Error('测试不创建 isolated')
      bindings.push({ sessionId, choice })
      return {
        project: { id: lease.projectId, name: '项目 A' },
        checkout: { id: lease.checkoutId, kind: lease.checkoutId.startsWith('local:') ? 'local' : 'isolated', label: 'target', phase: 'ready' },
        source: { ref: 'HEAD', oid: lease.baseOid },
        current: { branch: null, oid: lease.baseOid },
        ownership: choice.kind === 'inherit' ? 'inherited' : 'owner',
        dirty: false,
        revision: 1,
      }
    },
  }
}

const localLease: CheckoutLease = {
  kind: 'local',
  cwd: 'D:/projects/a',
  allowedRoot: 'D:/projects/a',
  localRoot: 'D:/projects/a',
  baseOid: 'local-oid',
  sourceRef: 'refs/heads/main',
  projectId: 'project-a',
  checkoutId: 'local:project-a',
  ownerSessionId: 'session-local',
  revision: 1,
}

const isolatedLease: CheckoutLease = {
  kind: 'isolated',
  cwd: 'D:/domi/checkouts/abc123',
  allowedRoot: 'D:/domi/checkouts/abc123',
  localRoot: 'D:/projects/a',
  baseOid: 'isolated-oid',
  sourceRef: 'refs/heads/main',
  projectId: 'project-a',
  checkoutId: 'checkout-abc123',
  ownerSessionId: 'session-owner',
  revision: 2,
}

describe('Agent Session Target resolver', () => {
  test.each([
    ['Local', localLease],
    ['Isolated', isolatedLease],
  ] as const)('Given Pi %s lease When 解析运行目标 Then SDK cwd、prompt cwd 与 Execution root 使用同一租约', async (_kind, lease) => {
    const target = await resolveAgentSessionTarget({
      sessionId: 'session-a',
      workspace,
      agentCwdMode: 'project',
    }, {
      checkout: createCheckoutModule(lease),
    })

    expect(target).toEqual({
      cwd: lease.cwd,
      promptCwd: lease.cwd,
      workspaceRoot: lease.allowedRoot,
      localBaselineRoot: lease.localRoot,
      followupOnly: false,
      lease,
    })
    expect(target.cwd).toBe(target.promptCwd)
    expect(target.workspaceRoot).toBe(lease.allowedRoot)
    expect(target.localBaselineRoot).toBe('D:/projects/a')
  })

  test('Given an owner Worktree has a prior review When resolving the target Then cumulative delivery context is exposed without changing cwd', async () => {
    const lease: CheckoutLease = {
      ...isolatedLease,
      deliveryBaseOid: 'a'.repeat(40),
      previousReview: {
        reviewId: 'review-major',
        iteration: 2,
        summary: '完成主要功能',
        suggestedCommitMessage: 'feat: 完成主要功能',
        changedFiles: ['src/major.ts'],
      },
    }
    const target = await resolveAgentSessionTarget({ sessionId: 'session-owner', workspace }, {
      checkout: createCheckoutModule(lease),
    })

    expect(target).toMatchObject({
      cwd: isolatedLease.cwd,
      deliveryBaseOid: 'a'.repeat(40),
      previousReview: {
        reviewId: 'review-major',
        summary: '完成主要功能',
        changedFiles: ['src/major.ts'],
      },
    })
  })

  test('Given active Local Preview lease When 解析运行目标 Then 保留只读原因供 Prompt 和工具路由', async () => {
    const lease: CheckoutLease = {
      ...isolatedLease,
      cwd: isolatedLease.localRoot,
      allowedRoot: isolatedLease.localRoot,
      followupOnly: true,
      followupReason: 'preview_active',
    }
    const target = await resolveAgentSessionTarget({ sessionId: 'session-owner', workspace }, {
      checkout: createCheckoutModule(lease),
    })

    expect(target).toMatchObject({
      followupOnly: true,
      followupReason: 'preview_active',
      cwd: isolatedLease.localRoot,
      workspaceRoot: isolatedLease.localRoot,
    })
  })

  test('Given Pi target 尚未选择 When 解析后准备启动 adapter Then fail closed 且 adapter 未启动', async () => {
    let adapterStarts = 0
    const checkout = createCheckoutModule(localLease)
    checkout.lease = async () => {
      throw new SessionCheckoutError('target_unselected', '会话尚未选择 Session Target')
    }

    await expect((async () => {
      const target = await resolveAgentSessionTarget({
        sessionId: 'unselected-session',
        workspace,
        agentCwdMode: 'project',
      }, { checkout })
      adapterStarts += 1
      return target
    })()).rejects.toMatchObject({ code: 'target_unselected' })
    expect(adapterStarts).toBe(0)
  })

  test('Given recovery_required checkout When 解析运行目标 Then fail closed', async () => {
    const checkout = createCheckoutModule(isolatedLease)
    checkout.lease = async () => {
      throw new SessionCheckoutError('recovery_required', 'Isolated Checkout 需要恢复')
    }

    await expect(resolveAgentSessionTarget({
      sessionId: 'recovery-session',
      workspace,
      agentCwdMode: 'project',
    }, { checkout })).rejects.toMatchObject({ code: 'recovery_required' })
  })
})

describe('Pi Fork Session Target 策略', () => {
  const localTarget: SessionTargetView = {
    project: { id: 'project-a', name: '项目 A' },
    checkout: { id: 'local:project-a', kind: 'local', label: 'Local Checkout', phase: 'ready' },
    source: { ref: 'refs/heads/main', oid: 'base-oid' },
    current: { branch: 'main', oid: 'base-oid' },
    ownership: 'owner',
    dirty: false,
    revision: 1,
  }

  test('Given 未指定目标 When Fork Pi 会话 Then 兼容继承父 Session Target', () => {
    expect(resolvePiForkTargetChoice('parent-session', undefined, localTarget)).toEqual({
      kind: 'inherit',
      parentSessionId: 'parent-session',
    })
  })

  test('Given Isolated 父目标 When 内部调用明确请求 inherit Then 保留共享目标语义', () => {
    expect(resolvePiForkTargetChoice('parent-session', { kind: 'inherit' }, {
      ...localTarget,
      checkout: { ...localTarget.checkout, id: 'checkout-a', kind: 'isolated' },
      revision: 5,
    })).toEqual({
      kind: 'inherit',
      parentSessionId: 'parent-session',
    })
  })

  test('Given Isolated 父目标与 local 请求 When Fork Then 子会话显式绑定项目当前目录', () => {
    expect(resolvePiForkTargetChoice('parent-session', { kind: 'local' }, {
      ...localTarget,
      checkout: { ...localTarget.checkout, id: 'checkout-a', kind: 'isolated' },
      revision: 5,
    })).toEqual({ kind: 'local' })
  })

  test('Given clean Local 与 isolated 请求 When Fork Then 为子会话创建独立 Isolated Target', () => {
    expect(resolvePiForkTargetChoice('parent-session', {
      kind: 'isolated',
      confirmDirty: false,
    }, localTarget)).toEqual({ kind: 'isolated' })
  })

  test('Given dirty Local 未确认 When Fork 到 Worktree Then fail closed', () => {
    expect(() => resolvePiForkTargetChoice('parent-session', {
      kind: 'isolated',
      confirmDirty: false,
    }, { ...localTarget, dirty: true })).toThrow('未提交修改')
  })

  test('Given dirty Local 已确认 When Fork 到 Worktree Then 不复制修改并允许创建', () => {
    expect(resolvePiForkTargetChoice('parent-session', {
      kind: 'isolated',
      confirmDirty: true,
    }, { ...localTarget, dirty: true })).toEqual({ kind: 'isolated' })
  })

  test('Given Isolated 父目标 When 请求复制当前 Worktree Then 返回独立 snapshot copy 意图', () => {
    expect(resolvePiForkTargetChoice('parent-session', {
      kind: 'isolated-copy',
    }, {
      ...localTarget,
      checkout: { ...localTarget.checkout, id: 'checkout-a', kind: 'isolated' },
      revision: 7,
    })).toEqual({
      kind: 'isolated-copy',
      parentSessionId: 'parent-session',
      expectedSourceRevision: 7,
    })
  })

  test('Given Isolated 父目标 When 请求从 Local HEAD 另建 Worktree Then 拒绝含糊来源语义', () => {
    expect(() => resolvePiForkTargetChoice('parent-session', {
      kind: 'isolated',
      confirmDirty: false,
    }, {
      ...localTarget,
      checkout: { ...localTarget.checkout, id: 'checkout-a', kind: 'isolated' },
    })).toThrow('仅支持从 Local Checkout')
  })
})

describe('非交互 Pi 会话目标绑定', () => {
  test('Given automation 新 Pi 会话 When 启动前绑定 Then 显式绑定 Local', async () => {
    const checkout = createCheckoutModule(localLease)

    await bindAgentSessionTargetForLaunch({
      sessionId: 'automation-child',
      choice: { kind: 'local' },
    }, checkout)

    expect(checkout.bindings).toEqual([{ sessionId: 'automation-child', choice: { kind: 'local' } }])
  })

  test.each([
    ['delegation-child', 'Isolated', isolatedLease],
    ['fork-child', 'Local', localLease],
  ] as const)(
    'Given %s Pi 会话与 %s 父目标 When 启动前继承 Then 绑定父会话 checkout',
    async (sessionId, _parentKind, parentLease) => {
      const checkout = createCheckoutModule(parentLease)

      await bindAgentSessionTargetForLaunch({
        sessionId,
        choice: { kind: 'inherit', parentSessionId: 'parent-session' },
      }, checkout)

      expect(checkout.bindings).toEqual([{
        sessionId,
        choice: { kind: 'inherit', parentSessionId: 'parent-session' },
      }])
    },
  )
})

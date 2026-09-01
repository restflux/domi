import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitPushSessionTrustView, SessionTargetView } from '@domi/shared'
import type { GitPushSessionTrustProposal } from './execution-policy/git-push-session-trust.ts'
import { AgentPermissionService, type CanUseToolOptions } from './agent-permission-service'

function permissionOptions(signal: AbortSignal, toolUseID: string): CanUseToolOptions {
  return { signal, toolUseID, displayName: '删除分组', description: '删除 Todo 分组' }
}

function isolatedTarget(revision = 7, oid = 'a'.repeat(40)): SessionTargetView {
  return {
    project: { id: 'project-1', name: 'Project' },
    checkout: { id: 'checkout-1', kind: 'isolated', label: 'Worktree', phase: 'ready' },
    source: { ref: 'refs/heads/main', oid: 'b'.repeat(40) },
    current: { branch: null, oid },
    ownership: 'owner',
    dirty: true,
    revision,
    delivery: { state: 'working', iteration: 1 },
  }
}

function readyForReviewTarget(revision = 7, oid = 'a'.repeat(40)): SessionTargetView {
  return {
    ...isolatedTarget(revision, oid),
    delivery: {
      state: 'ready_for_review',
      review: {
        reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: 'ready', validationStatus: 'passed',
        tests: [], changedFiles: ['src/conflict.ts'], suggestedCommitMessage: 'fix: conflict',
      },
    },
  }
}

test('Given Execution Policy requests approval When the banner request is built Then the structured policy reason is preserved', async () => {
  const service = new AgentPermissionService()
  const controller = new AbortController()
  let request: import('@domi/shared').PermissionRequest | undefined
  const pending = service.requestSingleApproval(
    'session-policy',
    'Bash',
    { command: '$RUNNER --force' },
    {
      ...permissionOptions(controller.signal, 'policy-1'),
      policy: {
        category: 'opaque-command',
        reason: '无法可靠解析 Shell 结构，已保守请求确认',
        scope: 'single',
        executionPolicy: 'controlled',
        workflow: 'direct',
        decisionCode: 'shell-analysis-opaque',
      },
    },
    (candidate) => { request = candidate },
  )

  expect(request?.policy).toEqual({
    category: 'opaque-command',
    reason: '无法可靠解析 Shell 结构，已保守请求确认',
    scope: 'single',
    executionPolicy: 'controlled',
    workflow: 'direct',
    decisionCode: 'shell-analysis-opaque',
  })
  await service.respondToPermission(request!.requestId, 'deny', false)
  expect(await pending).toMatchObject({ behavior: 'deny' })
})

test('Given a destructive planning request When it is approved Then approval is single-use and cannot create a session whitelist', async () => {
  const service = new AgentPermissionService()
  const controller = new AbortController()
  let firstRequest: { requestId: string; allowAlways?: boolean } | undefined

  const firstResult = service.requestSingleApproval(
    'session-1',
    'mcp__planning__delete_group',
    { id: 'group-1', scope: 'todo' },
    permissionOptions(controller.signal, 'tool-1'),
    (request) => { firstRequest = request },
  )

  expect(firstRequest?.allowAlways).toBe(false)
  expect(await service.respondToPermission(firstRequest!.requestId, 'allow', true)).toEqual({ ok: true, sessionId: 'session-1' })
  expect((await firstResult).behavior).toBe('allow')

  let secondRequest: { requestId: string } | undefined
  const secondResult = service.requestSingleApproval(
    'session-1',
    'mcp__planning__delete_group',
    { id: 'group-2', scope: 'todo' },
    permissionOptions(controller.signal, 'tool-2'),
    (request) => { secondRequest = request },
  )

  expect(secondRequest).toBeDefined()
  expect(await service.respondToPermission(secondRequest!.requestId, 'deny', false)).toEqual({ ok: true, sessionId: 'session-1' })
  expect((await secondResult).behavior).toBe('deny')
})

test('Given a prepared Git push trust request When the user approves Then only the bounded proposal becomes a session grant', async () => {
  const granted: GitPushSessionTrustProposal[] = []
  const views = new Map<string, GitPushSessionTrustView>()
  const trust = {
    grant: async (proposal: GitPushSessionTrustProposal) => {
      granted.push(proposal)
      views.set(proposal.view.sessionId, proposal.view)
      return proposal.view
    },
    list: (sessionId: string) => {
      const view = views.get(sessionId)
      return view ? [view] : []
    },
    revoke: (sessionId: string, grantId: string) => {
      const view = views.get(sessionId)
      if (!view || view.grantId !== grantId) return false
      views.delete(sessionId)
      return true
    },
    clear: (sessionId: string) => { views.delete(sessionId) },
  }
  const service = new AgentPermissionService(undefined, trust)
  const controller = new AbortController()
  const view: GitPushSessionTrustView = {
    grantId: 'grant-1',
    kind: 'git_push_current_source',
    sessionId: 'session-1',
    remoteName: 'origin',
    remoteDisplay: 'example.com/org/repo',
    targetBranch: 'main',
    recommendedCommand: 'git push --no-verify --no-follow-tags --no-push-option origin HEAD:main',
    createdAt: 1,
  }
  const proposal: GitPushSessionTrustProposal = {
    view,
    checkoutId: 'checkout-1',
    repositoryRoot: 'D:/repo',
    sourceRef: 'refs/heads/main',
    targetRef: 'refs/heads/main',
    remoteUrlFingerprint: 'hash',
    generation: 0,
  }
  let request: { requestId: string; allowAlways?: boolean; sessionCapability?: GitPushSessionTrustView } | undefined

  const pending = service.requestGitPushSessionTrustApproval(
    'session-1',
    proposal,
    { reason: '用户要求完成后推送' },
    permissionOptions(controller.signal, 'push-trust-1'),
    (candidate) => { request = candidate },
  )

  expect(request).toMatchObject({ allowAlways: false, sessionCapability: view })
  expect(await service.respondToPermission(request!.requestId, 'allow', true)).toEqual({ ok: true, sessionId: 'session-1' })
  expect(await pending).toMatchObject({ behavior: 'allow' })
  expect(granted).toEqual([proposal])
  expect(service.listSessionCapabilityGrants('session-1')).toEqual([view])
  expect(service.revokeSessionCapabilityGrant('session-1', 'grant-1')).toBe(true)
  expect(service.listSessionCapabilityGrants('session-1')).toEqual([])
})

test('Given a Git push trust request is pending When policy downgrade invalidates its generation Then later approval cannot revive it', async () => {
  let generation = 0
  const trust = {
    grant: async (proposal: GitPushSessionTrustProposal) => {
      if (proposal.generation !== generation) throw new Error('Git push 会话授权请求已失效，请重新请求')
      return proposal.view
    },
    list: () => [],
    revoke: () => false,
    clear: () => { generation += 1 },
  }
  const service = new AgentPermissionService(undefined, trust)
  const controller = new AbortController()
  const view: GitPushSessionTrustView = {
    grantId: 'grant-stale', kind: 'git_push_current_source', sessionId: 'session-1', remoteName: 'origin',
    remoteDisplay: 'example.com/org/repo', targetBranch: 'main', recommendedCommand: 'git push --no-verify --no-follow-tags --no-push-option origin HEAD:main', createdAt: 1,
  }
  const proposal: GitPushSessionTrustProposal = {
    view, checkoutId: 'checkout-1', repositoryRoot: 'D:/repo', sourceRef: 'refs/heads/main',
    targetRef: 'refs/heads/main', remoteUrlFingerprint: 'hash', generation: 0,
  }
  let requestId = ''
  const pending = service.requestGitPushSessionTrustApproval(
    'session-1', proposal, { reason: 'push' }, permissionOptions(controller.signal, 'push-stale'),
    (request) => { requestId = request.requestId },
  )

  trust.clear()
  const response = await service.respondToPermission(requestId, 'allow', false)

  expect(response).toMatchObject({ ok: false, consumed: true, message: expect.stringContaining('已失效') })
  expect(await pending).toMatchObject({ behavior: 'deny', message: expect.stringContaining('已失效') })
})

test('Given FinishWorktree confirmation edits Commit Message When approved Then only that bounded product input is updated', async () => {
  const service = new AgentPermissionService()
  const controller = new AbortController()
  let finishRequest: { requestId: string; toolInput: Record<string, unknown> } | undefined
  const finishResult = service.requestSingleApproval(
    'session-1',
    'FinishWorktree',
    {
      commitMessage: 'feat: cumulative delivery\n\n- preserve checkpoints\n- final wording tweak\n- preserve checkpoints',
      retention: 'cleanup',
    },
    permissionOptions(controller.signal, 'finish-1'),
    (request) => { finishRequest = request },
  )

  expect(finishRequest?.toolInput).toEqual({
    commitMessage: 'feat: cumulative delivery\n\n- preserve checkpoints\n- final wording tweak',
    retention: 'cleanup',
  })

  await service.respondToPermission(finishRequest!.requestId, 'allow', false, {
    commitMessage: '  refactor: 使用公开的 turn stop hook\n\n- 保留原 hook 的短路行为\n- 队列只清理一次\n- 保留原 hook 的短路行为\n- 队列只清理一次  ',
    retention: 'retain_24h',
  })
  expect(await finishResult).toEqual({
    behavior: 'allow',
    updatedInput: {
      commitMessage: 'refactor: 使用公开的 turn stop hook\n\n- 保留原 hook 的短路行为\n- 队列只清理一次',
      retention: 'retain_24h',
    },
  })

  let applyRequest: { requestId: string } | undefined
  const applyResult = service.requestSingleApproval(
    'session-1',
    'ApplyWorktree',
    {},
    permissionOptions(controller.signal, 'apply-1'),
    (request) => { applyRequest = request },
  )
  await service.respondToPermission(applyRequest!.requestId, 'allow', false, { commitMessage: 'must not cross tools' })
  expect(await applyResult).toEqual({ behavior: 'allow', updatedInput: {} })
})

test('Given Apply preflight already detects a conflict When Agent requests ApplyWorktree Then no useless Local approval is created and the conflict is returned to the same run', async () => {
  const root = mkdtempSync(join(tmpdir(), 'domi-preflight-conflict-permission-'))
  const persistencePath = join(root, 'pending.json')
  let sent = false
  let operationCount = 0
  try {
    const service = new AgentPermissionService(persistencePath)
    service.configureDeferredWorktreeApprovals({
      inspect: async () => readyForReviewTarget(),
      assertIdle: async () => {},
      preflight: async () => ({
        status: 'conflict', localModified: false, checkoutId: 'checkout-1', reviewId: 'review-1', revision: 7,
        configuredBaseOid: 'b'.repeat(40), effectiveBaseOid: 'b'.repeat(40), baseStrategy: 'recorded_base',
        localBranch: 'main', localHeadOid: 'c'.repeat(40), isolatedHeadOid: 'a'.repeat(40),
        changedFiles: ['src/conflict.ts'], conflictingFiles: ['src/conflict.ts'],
      }),
      operate: async () => { operationCount += 1; return { status: 'applied', target: readyForReviewTarget(), changedFiles: [] } },
    })

    const result = await service.requestSingleApproval(
      'session-1', 'ApplyWorktree', {}, permissionOptions(new AbortController().signal, 'apply-preflight-conflict'),
      () => { sent = true },
    )

    expect(result).toMatchObject({ behavior: 'deny' })
    if (result.behavior !== 'deny') throw new Error('expected ApplyWorktree to be denied before approval')
    expect(result.message).toContain('Local 未修改')
    expect(result.message).toContain('c'.repeat(40))
    expect(result.message).toContain('src/conflict.ts')
    expect(result.message).toContain('ReadyForReview')
    expect(result.message).toContain('新的验收卡')
    expect(result.message).toContain('不要再次调用 ApplyWorktree')
    expect(result.message).toContain('不要调用 FinishWorktree')
    expect(sent).toBe(false)
    expect(operationCount).toBe(0)
    expect(service.getPendingRequests()).toHaveLength(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Given Apply preflight is safe When Agent requests ApplyWorktree Then the snapshot-bound Local approval is still created', async () => {
  const root = mkdtempSync(join(tmpdir(), 'domi-ready-preflight-permission-'))
  const persistencePath = join(root, 'pending.json')
  let sentRequestId = ''
  try {
    const service = new AgentPermissionService(persistencePath)
    service.configureDeferredWorktreeApprovals({
      inspect: async () => readyForReviewTarget(),
      assertIdle: async () => {},
      preflight: async () => ({
        status: 'ready', localModified: false, checkoutId: 'checkout-1', reviewId: 'review-1', revision: 7,
        configuredBaseOid: 'b'.repeat(40), effectiveBaseOid: 'b'.repeat(40), baseStrategy: 'recorded_base',
        localBranch: 'main', localHeadOid: 'b'.repeat(40), isolatedHeadOid: 'a'.repeat(40), changedFiles: ['src/a.ts'],
      }),
      operate: async () => ({ status: 'applied', target: readyForReviewTarget(), changedFiles: [] }),
    })

    const result = await service.requestSingleApproval(
      'session-1', 'ApplyWorktree', {}, permissionOptions(new AbortController().signal, 'apply-ready-preflight'),
      (request) => { sentRequestId = request.requestId },
    )

    expect(result).toMatchObject({ behavior: 'deny' })
    expect(sentRequestId).not.toBe('')
    expect(service.getPendingRequests()).toHaveLength(1)
    expect(service.getPendingRequests()[0]?.requestId).toBe(sentRequestId)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Given a Worktree product approval When the Agent reaches it Then the request persists without holding the run and executes after restart against the same snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'domi-deferred-permission-'))
  const persistencePath = join(root, 'pending.json')
  const controller = new AbortController()
  const operations: unknown[] = []
  try {
    const service = new AgentPermissionService(persistencePath)
    service.configureDeferredWorktreeApprovals({
      inspect: async () => isolatedTarget(),
      assertIdle: async () => {},
      operate: async (input) => {
        operations.push(input)
        return { status: 'applied', target: isolatedTarget(8), changedFiles: ['src/a.ts'] }
      },
    })
    const result = await service.requestSingleApproval(
      'session-1',
      'ApplyWorktree',
      {},
      permissionOptions(controller.signal, 'apply-deferred'),
      () => {},
    )
    expect(result).toMatchObject({ behavior: 'deny' })
    expect(service.getPendingRequests()).toHaveLength(1)
    service.clearSessionPending('session-1')
    expect(service.getPendingRequests()).toHaveLength(1)

    const reloaded = new AgentPermissionService(persistencePath)
    reloaded.configureDeferredWorktreeApprovals({
      inspect: async () => isolatedTarget(),
      assertIdle: async () => {},
      operate: async (input) => {
        operations.push(input)
        return { status: 'applied', target: isolatedTarget(8), changedFiles: ['src/a.ts'] }
      },
    })
    const request = reloaded.getPendingRequests()[0]!
    expect(request.deferred).toMatchObject({ checkoutId: 'checkout-1', expectedRevision: 7 })
    expect(await reloaded.respondToPermission(request.requestId, 'allow', false)).toEqual({ ok: true, sessionId: 'session-1' })
    expect(operations).toEqual([{ action: 'apply', sessionId: 'session-1', expectedRevision: 7 }])
    expect(reloaded.getPendingRequests()).toHaveLength(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Given a Local maintenance request When Agent yields and app restarts Then approval opens exactly the snapshot-bound transaction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'domi-local-maintenance-permission-'))
  const persistencePath = join(root, 'pending.json')
  const started: unknown[] = []
  const snapshot = {
    checkoutId: 'checkout-1', expectedRevision: 7, expectedWorktreeOid: 'a'.repeat(40),
    localHeadOid: 'b'.repeat(40), localBranch: 'main', localStatusHash: 'status-hash', createdAt: 123,
  }
  try {
    const service = new AgentPermissionService(persistencePath)
    service.configureDeferredWorktreeApprovals({
      inspect: async () => isolatedTarget(), assertIdle: async () => {},
      operate: async () => ({ status: 'applied', target: isolatedTarget(), changedFiles: [] }),
      captureLocalMaintenance: async () => snapshot,
      startLocalMaintenance: async (sessionId, goal, accepted) => {
        started.push({ sessionId, goal, accepted })
        return { id: 'maintenance-1' }
      },
    })
    const result = await service.requestSingleApproval(
      'session-1', 'RequestLocalMaintenance', { goal: '修复 Local 配置' },
      permissionOptions(new AbortController().signal, 'maintenance-1'), () => {},
    )
    expect(result).toMatchObject({ behavior: 'deny' })
    expect(service.getPendingRequests()[0]?.deferred).toEqual({ kind: 'local_maintenance', ...snapshot })

    const reloaded = new AgentPermissionService(persistencePath)
    reloaded.configureDeferredWorktreeApprovals({
      inspect: async () => isolatedTarget(), assertIdle: async () => {},
      operate: async () => ({ status: 'applied', target: isolatedTarget(), changedFiles: [] }),
      captureLocalMaintenance: async () => snapshot,
      startLocalMaintenance: async (sessionId, goal, accepted) => {
        started.push({ sessionId, goal, accepted })
        return { id: 'maintenance-1' }
      },
    })
    const request = reloaded.getPendingRequests()[0]!
    expect(await reloaded.respondToPermission(request.requestId, 'allow', false)).toMatchObject({
      ok: true,
      sessionId: 'session-1',
      message: 'Local 维修事务已开启；Domi 正在自动续跑原任务。',
      continuation: {
        kind: 'local_maintenance',
        requestId: request.requestId,
        transactionId: 'maintenance-1',
        goal: '修复 Local 配置',
      },
    })
    expect(started).toEqual([{ sessionId: 'session-1', goal: '修复 Local 配置', accepted: { kind: 'local_maintenance', ...snapshot } }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Given a Local maintenance approval While the session is running Then no transaction starts and the consumed consent cannot be replayed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'domi-permission-maintenance-busy-'))
  const persistencePath = join(root, 'deferred.json')
  let started = false
  let busy = true
  try {
    const service = new AgentPermissionService(persistencePath)
    service.configureDeferredWorktreeApprovals({
      inspect: async () => isolatedTarget(),
      assertIdle: async () => {},
      operate: async () => ({ status: 'applied', target: isolatedTarget(), changedFiles: [] }),
      captureLocalMaintenance: async () => ({
        checkoutId: 'checkout-1', expectedRevision: 1, expectedWorktreeOid: 'abc123',
        localHeadOid: 'abc123', localBranch: 'main', localStatusHash: 'status-1', createdAt: Date.now(),
      }),
      startLocalMaintenance: async () => { started = true; return { id: 'maintenance-1' } },
    })
    await service.requestSingleApproval(
      'session-1', 'RequestLocalMaintenance', { goal: '修复 Local 配置' },
      permissionOptions(new AbortController().signal, 'maintenance-busy'), () => {},
    )
    const request = service.getPendingRequests()[0]!
    const reloaded = new AgentPermissionService(persistencePath)
    reloaded.configureDeferredWorktreeApprovals({
      inspect: async () => isolatedTarget(),
      assertIdle: async () => { if (busy) throw new Error('session still running') },
      operate: async () => ({ status: 'applied', target: isolatedTarget(), changedFiles: [] }),
      startLocalMaintenance: async () => { started = true; return { id: 'maintenance-1' } },
    })

    expect(await reloaded.respondToPermission(request.requestId, 'allow', false)).toMatchObject({
      ok: false,
      sessionId: 'session-1',
      consumed: false,
      message: 'session still running；本次确认仍保留，请等待当前 Agent 结束后重试。',
    })
    expect(started).toBe(false)
    expect(reloaded.getPendingRequests().map((candidate) => candidate.requestId)).toEqual([request.requestId])

    busy = false
    expect(await reloaded.respondToPermission(request.requestId, 'allow', false)).toMatchObject({
      ok: true,
      consumed: true,
      continuation: { kind: 'local_maintenance', requestId: request.requestId },
    })
    expect(started).toBe(true)
    expect(await reloaded.respondToPermission(request.requestId, 'allow', false)).toEqual({ ok: false, message: '确认请求已失效或已处理' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Given Apply becomes conflicting after the user approval When deferred execution runs Then the old consent is consumed and the original Agent receives a conflict continuation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'domi-raced-conflict-permission-'))
  const persistencePath = join(root, 'pending.json')
  try {
    const service = new AgentPermissionService(persistencePath)
    service.configureDeferredWorktreeApprovals({
      inspect: async () => readyForReviewTarget(),
      assertIdle: async () => {},
      operate: async () => ({
        status: 'conflict', code: 'apply_conflict', reason: 'content_conflict', target: readyForReviewTarget(9),
        baseStrategy: 'recorded_base', effectiveBaseOid: 'b'.repeat(40), localHeadOid: 'c'.repeat(40),
        isolatedHeadOid: 'a'.repeat(40), canRetryAfterRefresh: false, conflictingFiles: ['src/conflict.ts'],
      }),
    })
    await service.requestSingleApproval(
      'session-1', 'ApplyWorktree', {}, permissionOptions(new AbortController().signal, 'apply-raced-conflict'), () => {},
    )
    const request = service.getPendingRequests()[0]!

    expect(await service.respondToPermission(request.requestId, 'allow', false)).toMatchObject({
      ok: true,
      sessionId: 'session-1',
      consumed: true,
      continuation: {
        kind: 'worktree_apply_conflict',
        requestId: request.requestId,
        checkoutId: 'checkout-1',
        revision: 9,
        localHeadOid: 'c'.repeat(40),
        conflictingFiles: ['src/conflict.ts'],
      },
    })
    expect(service.getPendingRequests()).toHaveLength(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Given a deferred Worktree approval When revision or HEAD changes Then old consent is consumed and no mutation runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'domi-stale-permission-'))
  const persistencePath = join(root, 'pending.json')
  let target = isolatedTarget()
  let operationCount = 0
  try {
    const service = new AgentPermissionService(persistencePath)
    service.configureDeferredWorktreeApprovals({
      inspect: async () => target,
      assertIdle: async () => {},
      operate: async () => {
        operationCount += 1
        return { status: 'applied', target, changedFiles: [] }
      },
    })
    await service.requestSingleApproval(
      'session-1', 'ApplyWorktree', {}, permissionOptions(new AbortController().signal, 'apply-stale'), () => {},
    )
    const request = service.getPendingRequests()[0]!
    target = isolatedTarget(8, 'c'.repeat(40))
    const result = await service.respondToPermission(request.requestId, 'allow', false)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('已变化')
    expect(operationCount).toBe(0)
    expect(service.getPendingRequests()).toHaveLength(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

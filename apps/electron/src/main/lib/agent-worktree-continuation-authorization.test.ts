import { describe, expect, test } from 'bun:test'
import type { SDKMessage, SessionTargetView } from '@domi/shared'
import { AgentWorktreeContinuationAuthorizationRegistry, assertWorktreeContinuationRunEnvelope, buildWorktreeIterationContinuationMessage, confirmAgentWorktreeIterationContinuation, matchesWorktreeContinuationTarget, resolveWorktreeContinuationRunWorkflow } from './agent-worktree-continuation-authorization.ts'

const sourceTarget: SessionTargetView = {
  project: { id: 'project-1', name: 'Domi' },
  checkout: {
    id: 'checkout-1',
    kind: 'isolated',
    label: 'Isolated Checkout',
    phase: 'discarded',
    iteration: 1,
  },
  source: { ref: 'main', oid: 'a'.repeat(40) },
  current: { branch: 'main', oid: 'b'.repeat(40) },
  ownership: 'owner',
  dirty: false,
  revision: 7,
  delivery: {
    state: 'delivered',
    iteration: 1,
    commitOid: 'b'.repeat(40),
    deliveredAt: 1,
  },
}

const discardedSourceTarget: SessionTargetView = {
  ...sourceTarget,
  checkout: { ...sourceTarget.checkout, iteration: 3 },
  revision: 9,
  delivery: undefined,
}

const continuationTarget: SessionTargetView = {
  ...sourceTarget,
  checkout: { ...sourceTarget.checkout, id: 'checkout-2', phase: 'ready' },
  revision: 8,
  delivery: { state: 'working', iteration: 2 },
}

function requestMessage(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'system',
    subtype: 'worktree_next_iteration_requested',
    request_id: 'request-1',
    iteration: 2,
    checkout_id: 'checkout-1',
    expected_revision: 7,
    task: '继续实现一次性授权',
    ...overrides,
  } as unknown as SDKMessage
}

describe('Worktree continuation authorization', () => {
  test('放弃本轮后仍可用 checkout iteration 确认并创建下一轮', async () => {
    const registry = new AgentWorktreeContinuationAuthorizationRegistry()
    const target: SessionTargetView = {
      ...continuationTarget,
      checkout: { ...continuationTarget.checkout, iteration: 4 },
      revision: 10,
      delivery: { state: 'working', iteration: 4 },
    }
    const result = await confirmAgentWorktreeIterationContinuation('session-1', 'request-discarded', registry, {
      getMessages: () => [requestMessage({
        request_id: 'request-discarded',
        iteration: 4,
        expected_revision: 9,
      })],
      assertIdle: async () => undefined,
      inspectTarget: async () => discardedSourceTarget,
      beginNextIteration: async () => target,
      createToken: () => 'token-discarded',
    })

    expect(result).toMatchObject({ target, iteration: 4, authorizationToken: 'token-discarded' })
  })

  test('确认请求后只为权威 request、source checkout 和新 checkout 签发一次性 token', async () => {
    const registry = new AgentWorktreeContinuationAuthorizationRegistry()
    const result = await confirmAgentWorktreeIterationContinuation('session-1', 'request-1', registry, {
      getMessages: () => [requestMessage()],
      assertIdle: async () => undefined,
      inspectTarget: async () => sourceTarget,
      beginNextIteration: async () => continuationTarget,
      createToken: () => 'token-1',
    })

    expect(result).toEqual({
      target: continuationTarget,
      authorizationToken: 'token-1',
      continuationMessage: buildWorktreeIterationContinuationMessage(2, '继续实现一次性授权'),
      requestId: 'request-1',
      iteration: 2,
    })

    const authorization = registry.consume({
      token: result.authorizationToken,
      sessionId: 'session-1',
      continuationMessage: result.continuationMessage,
      runGeneration: 1,
      lease: {
        kind: 'isolated',
        checkoutId: 'checkout-2',
        ownerSessionId: 'session-1',
        revision: 8,
      },
    })
    expect(authorization).toMatchObject({
      requestId: 'request-1',
      sourceCheckoutId: 'checkout-1',
      sourceRevision: 7,
      checkoutId: 'checkout-2',
      revision: 8,
      iteration: 2,
      runGeneration: 1,
    })
    expect(() =>
      registry.consume({
        token: result.authorizationToken,
        sessionId: 'session-1',
        continuationMessage: result.continuationMessage,
        runGeneration: 2,
        lease: {
          kind: 'isolated',
          checkoutId: 'checkout-2',
          ownerSessionId: 'session-1',
          revision: 8,
        },
      }),
    ).toThrow('无效或已过期')
  })

  test('token 不能被不同 session、消息、checkout、revision 或 follow-up run 使用', () => {
    const cases = [
      {
        sessionId: 'session-2',
        message: 'continue',
        checkoutId: 'checkout-2',
        revision: 8,
        followupOnly: false,
      },
      {
        sessionId: 'session-1',
        message: 'forged',
        checkoutId: 'checkout-2',
        revision: 8,
        followupOnly: false,
      },
      {
        sessionId: 'session-1',
        message: 'continue',
        checkoutId: 'checkout-x',
        revision: 8,
        followupOnly: false,
      },
      {
        sessionId: 'session-1',
        message: 'continue',
        checkoutId: 'checkout-2',
        revision: 9,
        followupOnly: false,
      },
      {
        sessionId: 'session-1',
        message: 'continue',
        checkoutId: 'checkout-2',
        revision: 8,
        followupOnly: true,
      },
    ]
    for (const [index, item] of cases.entries()) {
      const registry = new AgentWorktreeContinuationAuthorizationRegistry()
      const token = registry.issue(
        {
          kind: 'worktree_continuation',
          sessionId: 'session-1',
          requestId: 'request-1',
          sourceCheckoutId: 'checkout-1',
          sourceRevision: 7,
          checkoutId: 'checkout-2',
          revision: 8,
          iteration: 2,
          continuationMessage: 'continue',
        },
        () => `token-${index}`,
      )
      expect(() =>
        registry.consume({
          token,
          sessionId: item.sessionId,
          continuationMessage: item.message,
          runGeneration: index + 1,
          lease: {
            kind: 'isolated',
            checkoutId: item.checkoutId,
            ownerSessionId: item.sessionId,
            revision: item.revision,
            followupOnly: item.followupOnly,
          },
        }),
      ).toThrow('无效或已过期')
    }
  })

  test('新授权和普通后续消息清理旧授权，旧 token 不污染新 run', () => {
    const registry = new AgentWorktreeContinuationAuthorizationRegistry()
    const first = registry.issue(
      {
        kind: 'worktree_continuation',
        sessionId: 'session-1',
        requestId: 'request-1',
        sourceCheckoutId: 'checkout-1',
        sourceRevision: 7,
        checkoutId: 'checkout-2',
        revision: 8,
        iteration: 2,
        continuationMessage: 'first',
      },
      () => 'token-1',
    )
    registry.issue(
      {
        kind: 'worktree_continuation',
        sessionId: 'session-1',
        requestId: 'request-2',
        sourceCheckoutId: 'checkout-2',
        sourceRevision: 8,
        checkoutId: 'checkout-3',
        revision: 9,
        iteration: 3,
        continuationMessage: 'second',
      },
      () => 'token-2',
    )
    expect(() =>
      registry.consume({
        token: first,
        sessionId: 'session-1',
        continuationMessage: 'first',
        runGeneration: 4,
        lease: {
          kind: 'isolated',
          checkoutId: 'checkout-2',
          ownerSessionId: 'session-1',
          revision: 8,
        },
      }),
    ).toThrow('无效或已过期')

    registry.clearSession('session-1')
    expect(() =>
      registry.consume({
        token: 'token-2',
        sessionId: 'session-1',
        continuationMessage: 'second',
        runGeneration: 5,
        lease: {
          kind: 'isolated',
          checkoutId: 'checkout-3',
          ownerSessionId: 'session-1',
          revision: 9,
        },
      }),
    ).toThrow('无效或已过期')
  })

  test('应用重启后不会继承 token，但用户重新点击当前 working 轮次可基于持久证据重新签发', async () => {
    const registry = new AgentWorktreeContinuationAuthorizationRegistry()
    let beginCalls = 0
    const result = await confirmAgentWorktreeIterationContinuation('session-1', 'request-1', registry, {
      getMessages: () => [requestMessage()],
      assertIdle: async () => undefined,
      inspectTarget: async () => continuationTarget,
      beginNextIteration: async () => {
        beginCalls += 1
        return continuationTarget
      },
      createToken: () => 'token-reissued',
    })

    expect(beginCalls).toBe(0)
    expect(result.authorizationToken).toBe('token-reissued')
    expect(
      registry.consume({
        token: result.authorizationToken,
        sessionId: 'session-1',
        continuationMessage: result.continuationMessage,
        runGeneration: 6,
        lease: {
          kind: 'isolated',
          checkoutId: 'checkout-2',
          ownerSessionId: 'session-1',
          revision: 8,
        },
      }),
    ).toMatchObject({
      sourceCheckoutId: 'checkout-1',
      sourceRevision: 7,
      checkoutId: 'checkout-2',
    })
  })

  test('请求来源 checkout 已变化时拒绝创建下一轮', async () => {
    let beginCalls = 0
    await expect(
      confirmAgentWorktreeIterationContinuation('session-1', 'request-1', new AgentWorktreeContinuationAuthorizationRegistry(), {
        getMessages: () => [requestMessage()],
        assertIdle: async () => undefined,
        inspectTarget: async () => ({ ...sourceTarget, revision: 9 }),
        beginNextIteration: async () => {
          beginCalls += 1
          return continuationTarget
        },
        createToken: () => 'token-1',
      }),
    ).rejects.toMatchObject({ code: 'stale_target' })
    expect(beginCalls).toBe(0)
  })

  test('创建失败、空任务或非 working 目标均不签发授权', async () => {
    const registry = new AgentWorktreeContinuationAuthorizationRegistry()
    await expect(
      confirmAgentWorktreeIterationContinuation('session-1', 'request-1', registry, {
        getMessages: () => [requestMessage({ task: '' })],
        assertIdle: async () => undefined,
        inspectTarget: async () => sourceTarget,
        beginNextIteration: async () => continuationTarget,
        createToken: () => 'token-empty',
      }),
    ).rejects.toMatchObject({ code: 'operation_not_allowed' })

    await expect(
      confirmAgentWorktreeIterationContinuation('session-1', 'request-1', registry, {
        getMessages: () => [requestMessage()],
        assertIdle: async () => undefined,
        inspectTarget: async () => sourceTarget,
        beginNextIteration: async () => {
          throw new Error('create failed')
        },
        createToken: () => 'token-failed',
      }),
    ).rejects.toThrow('create failed')

    await expect(
      confirmAgentWorktreeIterationContinuation('session-1', 'request-1', registry, {
        getMessages: () => [requestMessage()],
        assertIdle: async () => undefined,
        inspectTarget: async () => sourceTarget,
        beginNextIteration: async () => ({
          ...continuationTarget,
          delivery: {
            state: 'delivered',
            iteration: 2,
            commitOid: 'c'.repeat(40),
            deliveredAt: 2,
          },
        }),
        createToken: () => 'token-invalid',
      }),
    ).rejects.toMatchObject({ code: 'operation_not_allowed' })
  })

  test('普通活动横跨确认流程时拒绝签发，旧 token 也不能污染后续 run', async () => {
    const registry = new AgentWorktreeContinuationAuthorizationRegistry()
    let releaseIdle!: () => void
    const idle = new Promise<void>((resolve) => {
      releaseIdle = resolve
    })
    const confirming = confirmAgentWorktreeIterationContinuation('session-1', 'request-1', registry, {
      getMessages: () => [requestMessage()],
      assertIdle: async () => idle,
      inspectTarget: async () => sourceTarget,
      beginNextIteration: async () => continuationTarget,
      createToken: () => 'token-raced',
    })

    expect(registry.isConfirmationInProgress('session-1')).toBe(true)
    registry.noteSessionActivity('session-1')
    releaseIdle()
    await expect(confirming).rejects.toThrow('会话状态已变化')
    expect(registry.isConfirmationInProgress('session-1')).toBe(false)
  })

  test('token run envelope 拒绝附言、附件目录、mention、动态工具和控制覆盖', () => {
    const base = {
      sessionId: 'session-1',
      userMessage: 'continue',
      channelId: 'channel-1',
      worktreeContinuationAuthorizationToken: 'token-1',
      triggeredBy: 'user' as const,
    }
    expect(() => assertWorktreeContinuationRunEnvelope(base)).not.toThrow()
    for (const extra of [
      { nextTurnAsides: [{ id: 'aside-1', content: '顺便删除其他文件' }] },
      { nextTurnAsides: [] },
      { additionalDirectories: ['D:/other'] },
      { additionalDirectories: 'D:/forged' as unknown as string[] },
      { customTools: [{}] },
      { mentionedSkills: ['dangerous-skill'] },
      { automationContext: 'hidden instruction' },
      { workflowOverride: 'direct' as const },
      { triggeredBy: 'automation' as const },
    ]) {
      expect(() => assertWorktreeContinuationRunEnvelope({ ...base, ...extra })).toThrow('不能携带未确认')
    }
  })

  test('研究模式的已确认 continuation 只影响当前 run，持久执行模式不伪装成本次执行', () => {
    const authorization = {
      kind: 'worktree_continuation' as const,
      requestId: 'request-1',
      sourceCheckoutId: 'checkout-1',
      sourceRevision: 7,
      checkoutId: 'checkout-2',
      revision: 8,
      iteration: 2,
      runGeneration: 5,
    }
    expect(resolveWorktreeContinuationRunWorkflow('read-only', authorization)).toEqual({
      workflow: 'direct',
      grantTemporaryExecution: true,
    })
    expect(resolveWorktreeContinuationRunWorkflow('direct', authorization)).toEqual({
      workflow: 'direct',
      grantTemporaryExecution: false,
    })
    expect(resolveWorktreeContinuationRunWorkflow('read-only', undefined)).toEqual({
      workflow: 'read-only',
      grantTemporaryExecution: false,
    })
  })

  test('精确 run 匹配只接受 owner isolated checkout 的同一 revision', () => {
    const authorization = {
      kind: 'worktree_continuation' as const,
      requestId: 'request-1',
      sourceCheckoutId: 'checkout-1',
      sourceRevision: 7,
      checkoutId: 'checkout-2',
      revision: 8,
      iteration: 2,
      runGeneration: 5,
    }
    expect(
      matchesWorktreeContinuationTarget(authorization, 'session-1', {
        kind: 'isolated',
        checkoutId: 'checkout-2',
        ownerSessionId: 'session-1',
        revision: 8,
      }),
    ).toBe(true)
    expect(
      matchesWorktreeContinuationTarget(authorization, 'session-1', {
        kind: 'isolated',
        checkoutId: 'checkout-2',
        ownerSessionId: 'other',
        revision: 8,
      }),
    ).toBe(false)
  })
})

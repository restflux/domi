import { describe, expect, test } from 'bun:test'
import { SESSION_CHECKOUT_IPC_CHANNELS } from '@domi/shared'
import { registerSessionCheckoutIpc } from './register-session-checkout-ipc.ts'

interface RegisteredHandler {
  (event: unknown, input: unknown): Promise<unknown>
}

function setup(): {
  handlers: Map<string, RegisteredHandler>
  calls: string[]
} {
  const handlers = new Map<string, RegisteredHandler>()
  const calls: string[] = []
  registerSessionCheckoutIpc({
    handle: (channel, handler) => {
      handlers.set(channel, handler as RegisteredHandler)
    },
  }, {
    inspect: async (sessionId) => {
      calls.push(`inspect:${sessionId}`)
      return targetView()
    },
    preflight: async (sessionId, expectedRevision) => {
      calls.push(`preflight:${sessionId}:${expectedRevision}`)
      return {
        status: 'ready',
        localModified: false,
        checkoutId: 'checkout-1',
        reviewId: 'review-1',
        revision: expectedRevision,
        configuredBaseOid: 'a'.repeat(40),
        effectiveBaseOid: 'a'.repeat(40),
        baseStrategy: 'recorded_base',
        localBranch: 'main',
        localHeadOid: 'a'.repeat(40),
        isolatedHeadOid: 'a'.repeat(40),
        changedFiles: ['src/task.ts'],
      }
    },
    bind: async (sessionId, choice) => {
      calls.push(`bind:${sessionId}:${choice.kind}`)
      return targetView(choice.kind)
    },
    operate: async (input) => {
      const commitAction = input.action === 'finish' || input.action === 'finalize_preview'
      const messageAction = commitAction || input.action === 'checkpoint'
      const collaboratorSuffix = input.action === 'release_collaborator' ? `:${input.collaboratorSessionId}` : ''
      const rollbackSuffix = input.action === 'rollback_preview' && input.resumeRevision ? ':resume' : ''
      calls.push(`operate:${input.sessionId}:${input.action}${messageAction ? `:${input.commitMessage}` : collaboratorSuffix || rollbackSuffix}`)
      if (input.action === 'checkpoint') {
        return {
          status: 'checkpointed',
          target: targetView('isolated'),
          checkpoint: {
            checkpointId: 'checkpoint-1', sequence: 1, reviewId: 'review-1', createdAt: 1,
            summary: '阶段 A', validationStatus: 'passed', changedFiles: ['src/task.ts'],
          },
          changedFiles: ['src/task.ts'],
        }
      }
      return commitAction
        ? {
            status: 'finished',
            target: targetView('isolated'),
            changedFiles: ['src/task.ts'],
            commitOid: 'f'.repeat(40),
            cleanup: 'discarded',
          }
        : { status: 'discarded', target: targetView('isolated') }
    },
    listManagedWorktrees: async (input) => {
      calls.push(`list:${input?.projectId ?? 'all'}:${input?.needsAttention === true ? 'attention' : 'any'}:${input?.checkoutId ?? 'all-checkouts'}:${input?.includeDiagnostics === true ? 'diagnostics' : 'fast'}`)
      return []
    },
    inspectManagedWorktreeCleanup: async (input) => {
      calls.push(`inspect-cleanup:${input?.projectId ?? 'all'}`)
      return []
    },
    bulkCleanupManagedWorktrees: async (candidates) => {
      calls.push(`bulk-cleanup:${candidates.map((candidate) => `${candidate.checkoutId}@${candidate.expectedRevision}`).join(',')}`)
      return { cleaned: [], retained: [] }
    },
    manageManagedWorktree: async (input) => {
      calls.push(`manage:${input.checkoutId}:${input.action}`)
      return {
        checkoutId: input.checkoutId,
        revision: input.expectedRevision + 1,
        ownerSessionId: 'session-1',
        ownerSessionTitle: 'Session',
        project: { id: 'project-1', name: 'Domi' },
        iteration: 1,
        state: 'retained',
        phase: 'retained',
        dirty: false,
        commitOid: 'f'.repeat(40),
        retention: 'retain_manual',
        retainedAt: 1,
        expiresAt: null,
        approximateBytes: 0,
        updatedAt: 1,
        canReveal: true,
        canCleanup: true,
      }
    },
    resolveManagedRootForReveal: async (checkoutId) => {
      calls.push(`reveal:${checkoutId}`)
      return 'D:/managed'
    },
  }, undefined, undefined, async () => { calls.push('revealed-root') }, undefined, undefined, async (input) => {
    calls.push(`handoff:${input.sessionId}:${input.expectedRevision}:${input.confirmedIgnoreDirtyLocal}`)
    return {
      session: { id: 'recovery-child', title: 'Recovery', createdAt: 1, updatedAt: 1 },
      handoffId: 'handoff-1',
      reused: false,
      mode: 'fork' as const,
    }
  }, async (input) => {
    calls.push(`session-handoff:${input.sessionId}:${input.expectedRevision}:${input.targetKind}:${input.confirmedIgnoreDirtyLocal}`)
    return {
      session: { id: 'handoff-child', title: 'Handoff', createdAt: 1, updatedAt: 1 },
      handoffId: 'handoff-2',
      reused: false,
      mode: 'degraded' as const,
      degradedReason: 'session_artifact_missing' as const,
    }
  }, async (input) => {
    calls.push(`confirm-iteration:${input.sessionId}:${input.requestId}`)
    return {
      target: { ...targetView('isolated'), delivery: { state: 'working' as const, iteration: 2 } },
      authorizationToken: 'token-1',
      continuationMessage: '继续第二轮任务',
      requestId: input.requestId,
      iteration: 2,
    }
  })
  return { handlers, calls }
}

function targetView(kind: 'local' | 'isolated' = 'local') {
  return {
    project: { id: 'project-1', name: 'Domi' },
    checkout: { id: 'checkout-1', kind, label: kind, phase: 'ready' as const },
    source: { ref: 'main', oid: 'abcdef0123456789' },
    current: { branch: kind === 'isolated' ? null : 'main', oid: 'abcdef0123456789' },
    ownership: 'owner' as const,
    dirty: false,
    revision: 2,
  }
}

describe('Session Checkout IPC', () => {
  test('Worktree 续跑确认只接收 sessionId 与 requestId，并返回宿主签发的 continuation', async () => {
    const { handlers, calls } = setup()
    const confirm = handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.CONFIRM_ITERATION)!

    const result = await confirm({}, { sessionId: 'session-1', requestId: 'request-1' })
    const forged = await confirm({}, { sessionId: 'session-1', requestId: 'request-1', task: '伪造任务' })

    expect(result).toMatchObject({
      ok: true,
      value: {
        authorizationToken: 'token-1', requestId: 'request-1', iteration: 2,
        continuationMessage: '继续第二轮任务',
      },
    })
    expect(forged).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(calls).toContain('confirm-iteration:session-1:request-1')
  })

  test('Given renderer bind input When it contains inherit or path fields Then it is rejected before the module is called', async () => {
    const { handlers, calls } = setup()
    const bind = handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.BIND)!

    const inherit = await bind({}, {
      sessionId: 'session-1',
      choice: { kind: 'inherit', parentSessionId: 'parent-1' },
    })
    const forgedPath = await bind({}, {
      sessionId: 'session-1',
      choice: { kind: 'isolated', path: 'D:\\other-worktree' },
    })
    const forgedOperate = await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.OPERATE)!({}, {
      sessionId: 'session-1',
      action: 'apply',
      expectedRevision: 2,
      projectId: 'project-1',
      checkoutId: 'checkout-1',
    })

    expect(inherit).toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'Session Target 请求参数无效' },
    })
    expect(forgedPath).toEqual(inherit)
    expect(forgedOperate).toEqual(inherit)
    expect(calls).toEqual([])
  })

  test('Given a generic session handoff When it crosses IPC Then renderer can only choose target kind and explicit dirty confirmation', async () => {
    const { handlers, calls } = setup()
    const handoff = handlers.get('session-checkout:handoff-session')!

    const local = await handoff({}, {
      sessionId: 'session-1', expectedRevision: 2, targetKind: 'local', confirmedIgnoreDirtyLocal: false,
    })
    const isolated = await handoff({}, {
      sessionId: 'session-1', expectedRevision: 2, targetKind: 'isolated', confirmedIgnoreDirtyLocal: true,
    })
    const forged = await handoff({}, {
      sessionId: 'session-1', expectedRevision: 2, targetKind: 'isolated', confirmedIgnoreDirtyLocal: true,
      localHeadOid: 'forged', path: 'D:/other',
    })

    expect(local).toMatchObject({
      ok: true,
      value: { session: { id: 'handoff-child' }, mode: 'degraded', degradedReason: 'session_artifact_missing' },
    })
    expect(isolated).toMatchObject({ ok: true })
    expect(forged).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(calls).toContain('session-handoff:session-1:2:local:false')
    expect(calls).toContain('session-handoff:session-1:2:isolated:true')
  })

  test('Given recovery handoff confirmation When it crosses IPC Then only stable identity and explicit dirty confirmation reach main', async () => {
    const { handlers, calls } = setup()
    const handoff = handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.HANDOFF_RECOVERY)!

    const forged = await handoff({}, {
      sessionId: 'session-1', expectedRevision: 2, confirmedIgnoreDirtyLocal: true,
      sourcePath: 'D:/forged',
    })
    const missingConfirmation = await handoff({}, {
      sessionId: 'session-1', expectedRevision: 2, confirmedIgnoreDirtyLocal: false,
    })
    const accepted = await handoff({}, {
      sessionId: 'session-1', expectedRevision: 2, confirmedIgnoreDirtyLocal: true,
    })

    expect(forged).toEqual({ ok: false, error: { code: 'invalid_request', message: 'Session Target 请求参数无效' } })
    expect(missingConfirmation).toEqual(forged)
    expect(accepted).toMatchObject({ ok: true, value: { handoffId: 'handoff-1', reused: false, mode: 'fork', session: { id: 'recovery-child' } } })
    expect(calls).toEqual(['handoff:session-1:2:true'])
  })

  test('Given valid renderer commands When they cross IPC Then only session identity and fixed command fields reach the module', async () => {
    const { handlers, calls } = setup()

    const inspected = await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.INSPECT)!({}, { sessionId: 'session-1' })
    const preflight = await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.PREFLIGHT)!({}, {
      sessionId: 'session-1',
      expectedRevision: 2,
    })
    const forgedPreflight = await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.PREFLIGHT)!({}, {
      sessionId: 'session-1',
      expectedRevision: 2,
      localRoot: 'D:\\forged',
    })
    const bound = await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.BIND)!({}, {      sessionId: 'session-1',
      choice: { kind: 'isolated' },
    })
    const operated = await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.OPERATE)!({}, {
      sessionId: 'session-1',
      action: 'discard',
      expectedRevision: 2,
      confirmDirty: true,
    })

    expect(inspected).toEqual({ ok: true, value: targetView() })
    expect(preflight).toMatchObject({ ok: true, value: { status: 'ready', localModified: false, revision: 2 } })
    expect(forgedPreflight).toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'Session Target 请求参数无效' },
    })
    expect(bound).toEqual({ ok: true, value: targetView('isolated') })
    expect(operated).toEqual({
      ok: true,
      value: { status: 'discarded', target: targetView('isolated') },
    })
    expect(calls).toEqual([
      'inspect:session-1',
      'preflight:session-1:2',
      'bind:session-1:isolated',
      'operate:session-1:discard',
    ])
  })

  test('Given a valid finish command When it crosses IPC Then the trimmed commit message reaches the module and invalid variants are rejected', async () => {
    const { handlers, calls } = setup()
    const operate = handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.OPERATE)!

    const finished = await operate({}, {
      sessionId: 'session-1',
      action: 'finish',
      expectedRevision: 2,
      commitMessage: '  fix: finish task  ',
      retention: 'retain_24h',
    })
    const empty = await operate({}, {
      sessionId: 'session-1',
      action: 'finish',
      expectedRevision: 2,
      commitMessage: '   ',
      retention: 'cleanup',
    })
    const forged = await operate({}, {
      sessionId: 'session-1',
      action: 'finish',
      expectedRevision: 2,
      commitMessage: 'fix: finish task',
      retention: 'cleanup',
      localPath: 'D:\\forged',
    })

    expect(finished).toEqual({
      ok: true,
      value: {
        status: 'finished',
        target: targetView('isolated'),
        changedFiles: ['src/task.ts'],
        commitOid: 'f'.repeat(40),
        cleanup: 'discarded',
      },
    })
    expect(empty).toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'Session Target 请求参数无效' },
    })
    expect(forged).toEqual(empty)
    expect(calls).toEqual(['operate:session-1:finish:fix: finish task'])
  })

  test('Given Preview lifecycle commands cross IPC When parsed Then only their strict action fields reach the module', async () => {
    const { handlers, calls } = setup()
    const operate = handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.OPERATE)!

    await operate({}, { sessionId: 'session-1', action: 'preview', expectedRevision: 2 })
    await operate({}, { sessionId: 'session-1', action: 'checkpoint', expectedRevision: 2, commitMessage: '  feat: stage A  ' })
    await operate({}, { sessionId: 'session-1', action: 'rollback_preview', expectedRevision: 3 })
    await operate({}, { sessionId: 'session-1', action: 'rollback_preview', expectedRevision: 3, resumeRevision: true })
    await operate({}, {
      sessionId: 'session-1',
      action: 'finalize_preview',
      expectedRevision: 4,
      commitMessage: '  fix: accepted  ',
      retention: 'cleanup',
    })
    await operate({}, { sessionId: 'session-1', action: 'retry_cleanup', expectedRevision: 5 })
    await operate({}, {
      sessionId: 'session-1',
      action: 'release_collaborator',
      expectedRevision: 6,
      collaboratorSessionId: 'child-session',
    })
    await operate({}, {
      sessionId: 'session-1',
      action: 'release_collaborators',
      expectedRevision: 7,
    })
    await operate({}, {
      sessionId: 'session-1',
      action: 'discard',
      expectedRevision: 7,
      confirmDirty: true,
    })
    const invalidLegacyDiscard = await operate({}, {
      sessionId: 'session-1',
      action: 'discard',
      expectedRevision: 7,
      confirmDirty: true,
      rollbackPreview: true,
    })
    const invalid = await operate({}, {
      sessionId: 'session-1',
      action: 'preview',
      expectedRevision: 8,
      localRoot: 'D:\\forged',
    })
    const invalidRollback = await operate({}, {
      sessionId: 'session-1',
      action: 'rollback_preview',
      expectedRevision: 8,
      resumeRevision: 'yes',
    })
    const invalidRelease = await operate({}, {
      sessionId: 'session-1',
      action: 'release_collaborator',
      expectedRevision: 8,
      collaboratorSessionId: '',
    })

    expect(calls).toEqual([
      'operate:session-1:preview',
      'operate:session-1:checkpoint:feat: stage A',
      'operate:session-1:rollback_preview',
      'operate:session-1:rollback_preview:resume',
      'operate:session-1:finalize_preview:fix: accepted',
      'operate:session-1:retry_cleanup',
      'operate:session-1:release_collaborator:child-session',
      'operate:session-1:release_collaborators',
      'operate:session-1:discard',
    ])
    expect(invalid).toEqual({
      ok: false,
      error: { code: 'invalid_request', message: 'Session Target 请求参数无效' },
    })
    expect(invalidLegacyDiscard).toEqual(invalid)
    expect(invalidRollback).toEqual(invalid)
    expect(invalidRelease).toEqual(invalid)
  })

  test('Given bulk managed cleanup crosses IPC When parsed Then only bounded checkout identities and revisions reach main', async () => {
    const { handlers, calls } = setup()
    const bulkCleanup = handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.BULK_CLEANUP_MANAGED)!

    const valid = await bulkCleanup({}, {
      candidates: [
        { checkoutId: 'checkout-2', expectedRevision: 4 },
        { checkoutId: 'checkout-1', expectedRevision: 3 },
      ],
    })
    const forged = await bulkCleanup({}, {
      candidates: [{ checkoutId: 'checkout-1', expectedRevision: 3, managedRoot: 'D:\\forged' }],
    })

    expect(valid).toEqual({ ok: true, value: { cleaned: [], retained: [] } })
    expect(forged).toEqual({ ok: false, error: { code: 'invalid_request', message: 'Session Target 请求参数无效' } })
    expect(calls).toEqual(['bulk-cleanup:checkout-2@4,checkout-1@3'])
  })

  test('Given managed Worktree list/manage/reveal requests When parsed Then no renderer path or forged retention time crosses IPC', async () => {
    const { handlers, calls } = setup()
    const listed = await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.LIST_MANAGED)!({}, {
      projectId: 'project-1', needsAttention: true, checkoutId: 'checkout-1', includeDiagnostics: true,
    })
    const managed = await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.MANAGE)!({}, {
      checkoutId: 'checkout-1', expectedRevision: 2, action: 'set_retention', retention: 'retain_manual',
    })
    const retried = await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.MANAGE)!({}, {
      checkoutId: 'checkout-1', expectedRevision: 3, action: 'retry_cleanup',
    })
    const revealed = await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.REVEAL_MANAGED)!({}, { checkoutId: 'checkout-1' })
    const forged = await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.MANAGE)!({}, {
      checkoutId: 'checkout-1', expectedRevision: 2, action: 'set_retention', retention: 'retain_24h', expiresAt: 1,
    })
    const forgedList = await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.LIST_MANAGED)!({}, {
      checkoutId: 'checkout-1', includeDiagnostics: 'yes',
    })

    expect(listed).toEqual({ ok: true, value: [] })
    expect(managed).toMatchObject({ ok: true, value: { checkoutId: 'checkout-1', retention: 'retain_manual' } })
    expect(retried).toMatchObject({ ok: true, value: { checkoutId: 'checkout-1' } })
    expect(revealed).toEqual({ ok: true, value: undefined })
    expect(forged).toEqual({ ok: false, error: { code: 'invalid_request', message: 'Session Target 请求参数无效' } })
    expect(forgedList).toEqual({ ok: false, error: { code: 'invalid_request', message: 'Session Target 请求参数无效' } })
    expect(calls).toEqual([
      'inspect-cleanup:project-1',
      'manage:checkout-1:set_retention',
      'manage:checkout-1:retry_cleanup',
      'reveal:checkout-1',
      'revealed-root',
    ])
  })

  test('Given management confirms abandoning a running Worktree When IPC handles discard Then active sessions are exposed and stop-to-idle runs before mutation', async () => {
    const handlers = new Map<string, RegisteredHandler>()
    const calls: string[] = []
    const summary = {
      checkoutId: 'checkout-1', revision: 2, ownerSessionId: 'owner', ownerSessionTitle: 'Owner',
      project: { id: 'project-1', name: 'Domi' }, iteration: 1, state: 'working' as const,
      phase: 'ready' as const, dirty: true, commitOid: null, approximateBytes: 1, updatedAt: 1,
      canReveal: true, canCleanup: false,
    }
    registerSessionCheckoutIpc({ handle: (channel, handler) => handlers.set(channel, handler as RegisteredHandler) }, {
      inspect: async () => targetView('isolated'),
      bind: async () => targetView('isolated'),
      operate: async () => ({ status: 'discarded', target: targetView('isolated') }),
      listManagedWorktrees: async () => [summary],
      manageManagedWorktree: async (input) => {
        calls.push(`manage:${input.action}`)
        return { ...summary, phase: 'discarded' as const }
      },
    }, undefined, undefined, undefined, async (ownerSessionId) => {
      calls.push(`prepare:${ownerSessionId}`)
    }, async () => ['owner', 'child'])

    const listed = await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.LIST_MANAGED)!({}, {})
    const discarded = await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.MANAGE)!({}, {
      checkoutId: 'checkout-1', expectedRevision: 2, action: 'discard', confirmDirty: true,
    })
    const forged = await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.MANAGE)!({}, {
      checkoutId: 'checkout-1', expectedRevision: 2, action: 'discard', confirmDirty: false,
    })

    expect(listed).toMatchObject({ ok: true, value: [{ activeSessionIds: ['owner', 'child'] }] })
    expect(discarded).toMatchObject({ ok: true })
    expect(forged).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
    expect(calls).toEqual(['prepare:owner', 'manage:discard'])
  })

  test('Given interactive binding succeeds When IPC returns the authoritative target Then session metadata stores the Local or Isolated reference', async () => {
    const handlers = new Map<string, RegisteredHandler>()
    const persisted: Array<{ sessionId: string; target: { kind: 'local' } | { kind: 'isolated'; checkoutId: string } }> = []
    registerSessionCheckoutIpc({
      handle: (channel, handler) => handlers.set(channel, handler),
    }, {
      inspect: async () => targetView(),
      bind: async (_sessionId, choice) => targetView(choice.kind),
      operate: async () => ({ status: 'discarded', target: targetView('isolated') }),
    }, (sessionId, target) => {
      persisted.push({ sessionId, target })
    })

    await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.BIND)!({}, {
      sessionId: 'local-session',
      choice: { kind: 'local' },
    })
    await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.BIND)!({}, {
      sessionId: 'isolated-session',
      choice: { kind: 'isolated' },
    })

    expect(persisted).toEqual([
      { sessionId: 'local-session', target: { kind: 'local' } },
      { sessionId: 'isolated-session', target: { kind: 'isolated', checkoutId: 'checkout-1' } },
    ])
  })

  test('Given main reports the checkout is still active When renderer operates Then the module is never called', async () => {
    const handlers = new Map<string, RegisteredHandler>()
    let operateCalls = 0
    registerSessionCheckoutIpc({
      handle: (channel, handler) => handlers.set(channel, handler),
    }, {
      inspect: async () => targetView(),
      bind: async () => targetView(),
      operate: async () => {
        operateCalls += 1
        return { status: 'discarded', target: targetView('isolated') }
      },
    }, undefined, async () => {
      throw Object.assign(new Error('Agent 仍在运行'), { code: 'operation_not_allowed' })
    })

    const result = await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.OPERATE)!({}, {
      sessionId: 'session-1',
      action: 'discard',
      expectedRevision: 2,
      confirmDirty: true,
    })

    expect(result).toEqual({
      ok: false,
      error: { code: 'operation_not_allowed', message: 'Agent 仍在运行' },
    })
    expect(operateCalls).toBe(0)
  })

  test('Given operate 返回领域 error When IPC serializes it Then 判别 union 与稳定 code 保持不变', async () => {
    const handlers = new Map<string, RegisteredHandler>()
    registerSessionCheckoutIpc({
      handle: (channel, handler) => handlers.set(channel, handler),
    }, {
      inspect: async () => targetView(),
      bind: async () => targetView(),
      operate: async () => ({
        status: 'error',
        code: 'dirty_confirmation_required',
        message: '需要确认 dirty checkout',
        target: targetView('isolated'),
      }),
    })

    const result = await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.OPERATE)!({}, {
      sessionId: 'session-1',
      action: 'discard',
      expectedRevision: 2,
      confirmDirty: false,
    })

    expect(result).toEqual({
      ok: true,
      value: {
        status: 'error',
        code: 'dirty_confirmation_required',
        message: '需要确认 dirty checkout',
        target: targetView('isolated'),
      },
    })
  })

  test('Given a domain failure When IPC serializes it Then renderer receives a stable code and message', async () => {
    const handlers = new Map<string, RegisteredHandler>()
    registerSessionCheckoutIpc({
      handle: (channel, handler) => handlers.set(channel, handler as RegisteredHandler),
    }, {
      inspect: async () => {
        throw Object.assign(new Error('目标需要恢复'), { code: 'recovery_required' })
      },
      bind: async () => targetView(),
      operate: async () => ({ status: 'error', code: 'stale_target', message: '目标已经变化' }),
    })

    expect(await handlers.get(SESSION_CHECKOUT_IPC_CHANNELS.INSPECT)!({}, { sessionId: 'session-1' })).toEqual({
      ok: false,
      error: { code: 'recovery_required', message: '目标需要恢复' },
    })
  })
})

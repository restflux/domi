import { describe, expect, test } from 'bun:test'
import type { SessionTargetView } from '@domi/shared'
import { SessionCheckoutOperationGuard } from './session-checkout-operation-guard.ts'

function target(id: string, kind: 'local' | 'isolated' = 'isolated'): SessionTargetView {
  return {
    project: { id: 'project-a', name: 'Project A' },
    checkout: { id, kind, label: id, phase: 'ready' },
    source: { ref: 'main', oid: 'a'.repeat(40) },
    current: { branch: null, oid: 'a'.repeat(40) },
    ownership: 'owner',
    dirty: false,
    revision: 1,
  }
}

function review() {
  return {
    reviewId: 'review-1',
    iteration: 1,
    preparedAt: 1,
    summary: '完成任务',
    validationStatus: 'passed' as const,
    tests: [],
    changedFiles: ['src/task.ts'],
    suggestedCommitMessage: 'fix: task',
  }
}

function actionCardTarget(id: string, state: 'ready_for_review' | 'preview_active' = 'ready_for_review'): SessionTargetView {
  return {
    ...target(id),
    delivery: state === 'ready_for_review'
      ? { state, review: review() }
      : { state, review: review(), previewedAt: 2 },
  }
}

describe('SessionCheckoutOperationGuard', () => {
  test('Given a terminating owner briefly remains active after a review or revision card appears When checkout operation starts Then main waits for handoff and allows the first click', async () => {
    for (const deliveryState of ['ready_for_review', 'preview_active'] as const) {
      const active = new Set(['owner'])
      const guard = new SessionCheckoutOperationGuard({
        listSessionIds: () => ['owner'],
        isSessionActive: (sessionId) => active.has(sessionId),
        inspect: async () => actionCardTarget('shared-checkout', deliveryState),
      }, { ownerHandoffTimeoutMs: 50, ownerHandoffPollMs: 5 })
      setTimeout(() => active.delete('owner'), 10)

      await expect(guard.assertIdle('owner')).resolves.toBeUndefined()
    }
  })

  test('Given a normal working owner is active When checkout operation starts Then main rejects immediately without treating it as a card handoff', async () => {
    let sleepCalls = 0
    const guard = new SessionCheckoutOperationGuard({
      listSessionIds: () => ['owner'],
      isSessionActive: () => true,
      inspect: async () => target('shared-checkout'),
    }, {
      ownerHandoffTimeoutMs: 50,
      ownerHandoffPollMs: 5,
      sleep: async () => { sleepCalls += 1 },
    })

    await expect(guard.assertIdle('owner')).rejects.toMatchObject({ code: 'operation_not_allowed' })
    expect(sleepCalls).toBe(0)
  })

  test('Given a deferred Local maintenance approval arrives while the requesting run is terminating Then the explicit handoff option waits and accepts the first click', async () => {
    const active = new Set(['owner'])
    const guard = new SessionCheckoutOperationGuard({
      listSessionIds: () => ['owner'],
      isSessionActive: (sessionId) => active.has(sessionId),
      inspect: async () => target('shared-checkout'),
    }, { ownerHandoffTimeoutMs: 50, ownerHandoffPollMs: 5 })
    setTimeout(() => active.delete('owner'), 10)

    await expect(guard.assertIdle('owner', { awaitOwnerHandoff: true })).resolves.toBeUndefined()
  })

  test('Given a Local fork requests handoff while its parent still runs on the same Local Then main rejects concurrent writers', async () => {
    const active = new Set(['parent'])
    const guard = new SessionCheckoutOperationGuard({
      listSessionIds: () => ['parent', 'fork', 'other'],
      isSessionActive: (sessionId) => active.has(sessionId),
      inspect: async (sessionId) => sessionId === 'other'
        ? { ...target('local:project-b', 'local'), project: { id: 'project-b', name: 'Project B' } }
        : { ...target('local:project-a', 'local'), ownership: sessionId === 'parent' ? 'owner' : 'inherited' },
    })

    await expect(guard.assertIdle('fork')).rejects.toMatchObject({ code: 'operation_not_allowed' })
    active.clear()
    await expect(guard.assertIdle('fork')).resolves.toBeUndefined()
  })

  test('Given owner is background-waiting or an inherited session is active When checkout operation starts Then main rejects before mutation', async () => {
    const active = new Set(['child'])
    const guard = new SessionCheckoutOperationGuard({
      listSessionIds: () => ['owner', 'child', 'other'],
      isSessionActive: (sessionId) => active.has(sessionId),
      inspect: async (sessionId) => sessionId === 'other'
        ? target('other-checkout')
        : { ...actionCardTarget('shared-checkout'), ownership: sessionId === 'owner' ? 'owner' : 'inherited' },
    }, { ownerHandoffTimeoutMs: 5, ownerHandoffPollMs: 1 })

    await expect(guard.assertIdle('owner')).rejects.toMatchObject({ code: 'operation_not_allowed' })

    active.clear()
    active.add('owner')
    await expect(guard.assertIdle('owner')).rejects.toMatchObject({ code: 'operation_not_allowed' })
  })

  test('Given user confirms abandoning a running owner and collaborator When main prepares discard Then it stops only sessions on the same Checkout and waits for idle', async () => {
    const active = new Set(['owner', 'child', 'other'])
    const stopped: string[] = []
    const guard = new SessionCheckoutOperationGuard({
      listSessionIds: () => ['owner', 'child', 'other'],
      isSessionActive: (sessionId) => active.has(sessionId),
      inspect: async (sessionId) => ({
        ...target(sessionId === 'other' ? 'other-checkout' : 'shared-checkout'),
        ownership: sessionId === 'child' ? 'inherited' : 'owner',
      }),
      stopSession: (sessionId) => {
        stopped.push(sessionId)
        active.delete(sessionId)
      },
    }, { stopTimeoutMs: 50, ownerHandoffPollMs: 1 })

    expect(await guard.getActiveSessionIds('owner')).toEqual(['owner', 'child'])
    await expect(guard.stopAndAssertIdle('owner')).resolves.toBeUndefined()
    expect(stopped).toEqual(['owner', 'child'])
    expect(active.has('other')).toBe(true)
  })

  test('Given a related Agent cannot stop within the confirmed budget When discard prepares Then it fails closed before checkout mutation', async () => {
    const guard = new SessionCheckoutOperationGuard({
      listSessionIds: () => ['owner'],
      isSessionActive: () => true,
      inspect: async () => target('shared-checkout'),
      stopSession: () => {},
    }, { stopTimeoutMs: 1, ownerHandoffPollMs: 1, sleep: async () => {} })

    await expect(guard.stopAndAssertIdle('owner')).rejects.toMatchObject({ code: 'operation_not_allowed' })
  })

  test('Given the owner and unrelated checkouts are idle When operation starts Then main allows it', async () => {
    const guard = new SessionCheckoutOperationGuard({
      listSessionIds: () => ['owner', 'other'],
      isSessionActive: () => false,
      inspect: async (sessionId) => target(sessionId === 'owner' ? 'owner-checkout' : 'other-checkout'),
    })

    await expect(guard.assertIdle('owner')).resolves.toBeUndefined()
  })
})

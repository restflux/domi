import { afterEach, describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { SessionCheckoutRendererApi, SessionTargetView } from '@domi/shared'
import {
  bindSessionTargetAtomFamily,
  confirmWorktreeIterationAtomFamily,
  inspectSessionTargetAtomFamily,
  operateSessionTargetAtomFamily,
  preflightSessionTargetAtomFamily,
  sessionTargetStateAtomFamily,
  sessionTargetWorktreePendingAtomFamily,
} from './session-target-atoms.ts'

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')

function view(id: string, revision = 1): SessionTargetView {
  return {
    project: { id: 'project-1', name: 'Domi' },
    checkout: { id, kind: 'isolated', label: id, phase: 'ready' },
    source: { ref: 'main', oid: 'abcdef0123456789' },
    current: { branch: null, oid: 'abcdef0123456789' },
    ownership: 'owner',
    dirty: true,
    revision,
  }
}

function installApi(api: SessionCheckoutRendererApi): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronAPI: { sessionCheckout: api } },
  })
}

afterEach(() => {
  if (originalWindowDescriptor) Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
  else Reflect.deleteProperty(globalThis, 'window')
  disableFakeTimers()
})

/** 推进 microtask 链，让 tick 触发的 setTimeout 回调后的 await 继续执行。 */
async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

// bun 1.3 的 mock.timers 不可用，这里用替换 globalThis.setTimeout 的轻量 fake timers，
// 让“IPC 超时 + 轮询等待”可以在毫秒级可控地推进。
interface FakeTimerEntry {
  callback: () => void
  at: number
}

const realSetTimeout = globalThis.setTimeout
let fakeTimerQueue: FakeTimerEntry[] = []
let fakeTimerNow = 0

function enableFakeTimers(): void {
  fakeTimerQueue = []
  fakeTimerNow = 0
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    fakeTimerQueue.push({ callback, at: fakeTimerNow + (delay ?? 0) })
    return 0
  }) as typeof setTimeout
}

function disableFakeTimers(): void {
  globalThis.setTimeout = realSetTimeout
  fakeTimerQueue = []
}

async function tickFakeTimers(ms: number): Promise<void> {
  fakeTimerNow += ms
  const due = fakeTimerQueue
    .filter((timer) => timer.at <= fakeTimerNow)
    .sort((left, right) => left.at - right.at)
  fakeTimerQueue = fakeTimerQueue.filter((timer) => timer.at > fakeTimerNow)
  for (const timer of due) {
    timer.callback()
    await flushMicrotasks()
  }
}

function mutatingView(id: string, revision: number): SessionTargetView {
  return { ...view(id, revision), checkout: { ...view(id, revision).checkout, phase: 'mutating' } }
}

function finalizedView(id: string, revision: number, commitOid = 'f'.repeat(40)): SessionTargetView {
  return {
    project: { id: 'project-1', name: 'Domi' },
    checkout: { id, kind: 'isolated', label: id, phase: 'finalized' },
    source: { ref: 'main', oid: 'a'.repeat(40) },
    current: { branch: 'main', oid: commitOid },
    ownership: 'owner',
    dirty: true,
    revision,
    delivery: {
      state: 'finalized',
      review: {
        reviewId: 'review-1',
        iteration: 1,
        preparedAt: 1,
        summary: '验证超时自动恢复',
        validationStatus: 'passed',
        tests: [],
        changedFiles: ['src/task.ts'],
        suggestedCommitMessage: 'fix: slow submit',
      },
      commitOid,
      cleanup: 'pending',
    },
  }
}

describe('session target atoms', () => {
  test('Worktree 续跑确认把宿主返回的精确 target 与 opaque token 保持在单次调用结果中', async () => {
    const target = { ...view('checkout-2', 8), delivery: { state: 'working' as const, iteration: 2 } }
    const inputs: unknown[] = []
    installApi({
      inspect: async () => ({ ok: true, value: target }),
      bind: async () => ({ ok: true, value: target }),
      operate: async () => ({ ok: true, value: { status: 'discarded', target } }),
      confirmIteration: async (input) => {
        inputs.push(input)
        return {
          ok: true,
          value: {
            target,
            authorizationToken: 'opaque-token',
            continuationMessage: '继续第二轮任务',
            requestId: 'request-1',
            iteration: 2,
          },
        }
      },
    })
    const store = createStore()
    const result = await store.set(confirmWorktreeIterationAtomFamily('session-1'), 'request-1')

    expect(inputs).toEqual([{ sessionId: 'session-1', requestId: 'request-1' }])
    expect(result).toEqual({
      authorizationToken: 'opaque-token', continuationMessage: '继续第二轮任务',
      requestId: 'request-1', iteration: 2,
    })
    expect(store.get(sessionTargetStateAtomFamily('session-1')).snapshot).toEqual(target)
  })

  test('Given cold-start Pi metadata is no longer a draft When inspect reports target_unselected Then selection remains required until binding succeeds', async () => {
    installApi({
      inspect: async () => ({
        ok: false,
        error: { code: 'target_unselected', message: '会话尚未选择 Session Target' },
      }),
      bind: async () => ({ ok: true, value: view('bound-local') }),
      operate: async () => ({
        ok: true,
        value: { status: 'applied', target: view('unused'), changedFiles: [] },
      }),
    })
    const store = createStore()

    await store.set(inspectSessionTargetAtomFamily('cold-session'))
    expect(store.get(sessionTargetStateAtomFamily('cold-session')).selectionRequired).toBeTrue()

    await store.set(bindSessionTargetAtomFamily('cold-session'), 'local')
    expect(store.get(sessionTargetStateAtomFamily('cold-session'))).toEqual(expect.objectContaining({
      snapshot: view('bound-local'),
      selectionRequired: false,
    }))
  })

  test('Given a ready review When preflight atom runs Then strict revision input crosses IPC and structured facts stay session scoped', async () => {
    const store = createStore()
    const snapshot = view('checkout-1', 7)
    snapshot.delivery = {
      state: 'ready_for_review',
      review: { reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: 'ready', validationStatus: 'passed', tests: [], changedFiles: ['src/a.ts'], suggestedCommitMessage: 'fix: ready' },
    }
    const calls: unknown[] = []
    installApi({
      inspect: async () => ({ ok: true, value: snapshot }),
      preflight: async (input) => {
        calls.push(input)
        return {
          ok: true,
          value: {
            status: 'ready', localModified: false, checkoutId: 'checkout-1', reviewId: 'review-1', revision: 7,
            configuredBaseOid: 'a'.repeat(40), effectiveBaseOid: 'a'.repeat(40), baseStrategy: 'recorded_base',
            localBranch: 'main', localHeadOid: 'a'.repeat(40), isolatedHeadOid: 'b'.repeat(40), changedFiles: ['src/a.ts'],
          },
        }
      },
      bind: async () => ({ ok: true, value: snapshot }),
      operate: async () => ({ ok: true, value: { status: 'discarded', target: snapshot } }),
    })
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot,
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })

    await store.set(preflightSessionTargetAtomFamily('session-1'))

    expect(calls).toEqual([{ sessionId: 'session-1', expectedRevision: 7 }])
    expect(store.get(sessionTargetStateAtomFamily('session-1')).preflight).toMatchObject({ status: 'ready', revision: 7 })
  })

  test('Given periodic inspect returns the same review identity When refreshed Then existing preflight remains visible without a loading flash', async () => {
    const store = createStore()
    const snapshot = view('checkout-1', 7)
    snapshot.delivery = {
      state: 'ready_for_review',
      review: { reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: 'ready', validationStatus: 'passed', tests: [], changedFiles: ['src/a.ts'], suggestedCommitMessage: 'fix: ready' },
    }
    let resolveInspect!: (result: { ok: true; value: SessionTargetView }) => void
    installApi({
      inspect: async () => new Promise((resolve) => { resolveInspect = resolve }),
      bind: async () => ({ ok: true, value: snapshot }),
      operate: async () => ({ ok: true, value: { status: 'discarded', target: snapshot } }),
    })
    const cachedPreflight = {
      status: 'ready' as const, localModified: false as const, checkoutId: 'checkout-1', reviewId: 'review-1', revision: 7,
      configuredBaseOid: 'a'.repeat(40), effectiveBaseOid: 'a'.repeat(40), baseStrategy: 'recorded_base' as const,
      localBranch: 'main', localHeadOid: 'a'.repeat(40), isolatedHeadOid: 'b'.repeat(40), changedFiles: ['src/a.ts'],
    }
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot, selectionRequired: false, loading: false, pendingAction: null, error: null,
      preflight: cachedPreflight, preflightLoading: false, preflightError: null,
    })

    const refreshing = store.set(inspectSessionTargetAtomFamily('session-1'), { silent: true })
    expect(store.get(sessionTargetStateAtomFamily('session-1'))).toMatchObject({
      loading: false,
      preflight: cachedPreflight,
      preflightLoading: false,
    })
    resolveInspect({ ok: true, value: { ...snapshot, dirty: false } })
    await refreshing

    expect(store.get(sessionTargetStateAtomFamily('session-1'))).toMatchObject({
      snapshot: { checkout: { id: 'checkout-1' }, revision: 7, dirty: false },
      preflight: cachedPreflight,
      preflightLoading: false,
    })
  })

  test('Given another task releases the Local acceptance slot When periodic inspect refreshes the same review Then the cached busy preflight is discarded and a fresh preflight can succeed', async () => {
    const store = createStore()
    const waiting = view('checkout-1', 7)
    waiting.reviewSlot = 'waiting'
    waiting.reviewSlotOwnerSessionId = 'other-session'
    waiting.delivery = {
      state: 'ready_for_review',
      review: { reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: 'ready', validationStatus: 'passed', tests: [], changedFiles: [], suggestedCommitMessage: 'fix: ready' },
    }
    const available = { ...waiting, reviewSlot: 'available' as const, reviewSlotOwnerSessionId: undefined }
    let preflightCalls = 0
    installApi({
      inspect: async () => ({ ok: true, value: available }),
      preflight: async () => {
        preflightCalls += 1
        return {
          ok: true,
          value: {
            status: 'ready', localModified: false, checkoutId: 'checkout-1', reviewId: 'review-1', revision: 7,
            configuredBaseOid: 'a'.repeat(40), effectiveBaseOid: 'a'.repeat(40), baseStrategy: 'recorded_base',
            localBranch: 'main', localHeadOid: 'a'.repeat(40), isolatedHeadOid: 'b'.repeat(40), changedFiles: [],
          },
        }
      },
      bind: async () => ({ ok: true, value: available }),
      operate: async () => ({ ok: true, value: { status: 'discarded', target: available } }),
    })
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: waiting, selectionRequired: false, loading: false, pendingAction: null, error: null,
      preflight: {
        status: 'blocked', localModified: false, checkoutId: 'checkout-1', reviewId: 'review-1', revision: 7,
        reason: 'project_acceptance_busy', message: '另一个任务正在占用该项目的 Local 验收槽位',
      },
      preflightLoading: false,
      preflightError: null,
    })

    await store.set(inspectSessionTargetAtomFamily('session-1'), { silent: true })

    expect(store.get(sessionTargetStateAtomFamily('session-1'))).toMatchObject({
      snapshot: { reviewSlot: 'available' },
      preflight: null,
      preflightLoading: false,
      preflightError: null,
    })

    const refreshing = store.set(preflightSessionTargetAtomFamily('session-1'), { silent: true, invalidateCached: true })
    expect(store.get(sessionTargetStateAtomFamily('session-1'))).toMatchObject({
      snapshot: { reviewSlot: 'available' },
      preflight: null,
      preflightLoading: true,
    })
    await refreshing

    expect(preflightCalls).toBe(1)
    expect(store.get(sessionTargetStateAtomFamily('session-1'))).toMatchObject({
      snapshot: { reviewSlot: 'available' },
      preflight: { status: 'ready', reviewId: 'review-1', revision: 7 },
      preflightLoading: false,
    })
  })

  test('Given an old busy preflight is still in flight When inspect observes the slot release Then its late result cannot restore the stale blocker', async () => {
    const store = createStore()
    const waiting = view('checkout-1', 7)
    waiting.reviewSlot = 'waiting'
    waiting.reviewSlotOwnerSessionId = 'other-session'
    waiting.delivery = {
      state: 'ready_for_review',
      review: { reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: 'ready', validationStatus: 'passed', tests: [], changedFiles: [], suggestedCommitMessage: 'fix: ready' },
    }
    const available = { ...waiting, reviewSlot: 'available' as const, reviewSlotOwnerSessionId: undefined }
    let resolvePreflight!: (result: Awaited<ReturnType<NonNullable<SessionCheckoutRendererApi['preflight']>>>) => void
    installApi({
      inspect: async () => ({ ok: true, value: available }),
      preflight: async () => new Promise((resolve) => { resolvePreflight = resolve }),
      bind: async () => ({ ok: true, value: available }),
      operate: async () => ({ ok: true, value: { status: 'discarded', target: available } }),
    })
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: waiting, selectionRequired: false, loading: false, pendingAction: null, error: null,
      preflight: null, preflightLoading: false, preflightError: null,
    })

    const stalePreflight = store.set(preflightSessionTargetAtomFamily('session-1'))
    await flushMicrotasks()
    expect(typeof resolvePreflight).toBe('function')
    await store.set(inspectSessionTargetAtomFamily('session-1'), { silent: true })
    resolvePreflight({
      ok: true,
      value: {
        status: 'blocked', localModified: false, checkoutId: 'checkout-1', reviewId: 'review-1', revision: 7,
        reason: 'project_acceptance_busy', message: '另一个任务正在占用该项目的 Local 验收槽位',
      },
    })
    await stalePreflight

    expect(store.get(sessionTargetStateAtomFamily('session-1'))).toMatchObject({
      snapshot: { reviewSlot: 'available' },
      preflight: null,
      preflightLoading: false,
    })
  })

  test('Given a background inspect times out behind a queued checkout operation When a snapshot already exists Then the authoritative view and operation state remain intact', async () => {
    enableFakeTimers()
    const store = createStore()
    const snapshot = view('checkout-1', 7)
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot,
      selectionRequired: false,
      loading: false,
      pendingAction: 'finish',
      error: null,
    })
    installApi({
      inspect: async () => new Promise<never>(() => {}),
      bind: async () => ({ ok: true, value: snapshot }),
      operate: async () => ({ ok: true, value: { status: 'discarded', target: snapshot } }),
    })

    const refreshing = store.set(inspectSessionTargetAtomFamily('session-1'))
    await tickFakeTimers(45_000)
    await refreshing

    expect(store.get(sessionTargetStateAtomFamily('session-1'))).toEqual({
      snapshot,
      selectionRequired: false,
      loading: false,
      pendingAction: 'finish',
      error: null,
    })
  })

  test('Given inspect already timed out in Renderer When user retries before Main settles Then the pending IPC is reused instead of queued again', async () => {
    enableFakeTimers()
    const store = createStore()
    const snapshot = view('checkout-recovered', 8)
    let inspectCalls = 0
    let resolveInspect!: (result: { ok: true; value: SessionTargetView }) => void
    installApi({
      inspect: async () => {
        inspectCalls += 1
        if (inspectCalls > 1) return { ok: true, value: snapshot }
        return new Promise((resolve) => { resolveInspect = resolve })
      },
      bind: async () => ({ ok: true, value: snapshot }),
      operate: async () => ({ ok: true, value: { status: 'discarded', target: snapshot } }),
    })

    const initial = store.set(inspectSessionTargetAtomFamily('retry-session'))
    await tickFakeTimers(45_000)
    await initial
    const retry = store.set(inspectSessionTargetAtomFamily('retry-session'))
    await flushMicrotasks()

    expect(inspectCalls).toBe(1)
    resolveInspect({ ok: true, value: snapshot })
    await retry
    expect(store.get(sessionTargetStateAtomFamily('retry-session')).snapshot).toEqual(snapshot)

    await store.set(inspectSessionTargetAtomFamily('retry-session'))
    expect(inspectCalls).toBe(2)
  })

  test('Given inspect completes while an operation atom is still pending When state refreshes Then it does not unlock the operation early', async () => {
    const store = createStore()
    const snapshot = view('checkout-1', 7)
    const refreshed = mutatingView('checkout-1', 8)
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot,
      selectionRequired: false,
      loading: false,
      pendingAction: 'finish',
      error: null,
    })
    installApi({
      inspect: async () => ({ ok: true, value: refreshed }),
      bind: async () => ({ ok: true, value: snapshot }),
      operate: async () => ({ ok: true, value: { status: 'discarded', target: snapshot } }),
    })

    await store.set(inspectSessionTargetAtomFamily('session-1'), { silent: true })

    expect(store.get(sessionTargetStateAtomFamily('session-1'))).toEqual(expect.objectContaining({
      snapshot: refreshed,
      pendingAction: 'finish',
      error: null,
    }))
  })

  test('Given inspect changes checkout review or revision When refreshed Then stale preflight is discarded exactly once', async () => {
    const store = createStore()
    const before = view('checkout-1', 7)
    before.delivery = {
      state: 'ready_for_review',
      review: { reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: 'ready', validationStatus: 'passed', tests: [], changedFiles: [], suggestedCommitMessage: 'fix: ready' },
    }
    const after = view('checkout-1', 8)
    after.delivery = {
      state: 'ready_for_review',
      review: { ...before.delivery.review, reviewId: 'review-2' },
    }
    installApi({
      inspect: async () => ({ ok: true, value: after }),
      bind: async () => ({ ok: true, value: after }),
      operate: async () => ({ ok: true, value: { status: 'discarded', target: after } }),
    })
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: before, selectionRequired: false, loading: false, pendingAction: null, error: null,
      preflight: {
        status: 'ready', localModified: false, checkoutId: 'checkout-1', reviewId: 'review-1', revision: 7,
        configuredBaseOid: 'a'.repeat(40), effectiveBaseOid: 'a'.repeat(40), baseStrategy: 'recorded_base', localBranch: 'main',
        localHeadOid: 'a'.repeat(40), isolatedHeadOid: 'a'.repeat(40), changedFiles: [],
      },
    })

    await store.set(inspectSessionTargetAtomFamily('session-1'), { silent: true })

    expect(store.get(sessionTargetStateAtomFamily('session-1')).preflight).toBeNull()
  })

  test('Given two sessions When each is inspected and one binds Then snapshots and pending state remain session scoped', async () => {
    installApi({
      inspect: async ({ sessionId }) => ({ ok: true, value: view(`checkout-${sessionId}`) }),
      bind: async ({ sessionId }) => ({ ok: true, value: view(`bound-${sessionId}`, 2) }),
      operate: async () => ({
        ok: true,
        value: { status: 'applied', target: view('unused'), changedFiles: [] },
      }),
    })
    const store = createStore()

    await store.set(inspectSessionTargetAtomFamily('a'))
    await store.set(inspectSessionTargetAtomFamily('b'))
    await store.set(bindSessionTargetAtomFamily('a'), 'isolated')

    expect(store.get(sessionTargetStateAtomFamily('a'))).toEqual(expect.objectContaining({
      snapshot: view('bound-a', 2),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    }))
    expect(store.get(sessionTargetStateAtomFamily('b'))).toEqual(expect.objectContaining({
      snapshot: view('checkout-b'),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    }))
  })

  test('Given Apply 返回 conflict When 操作完成 Then 不当作成功、展示稳定错误并重新 inspect', async () => {
    const refreshed = view('checkout-a', 5)
    let inspectCalls = 0
    installApi({
      inspect: async () => {
        inspectCalls += 1
        return { ok: true, value: refreshed }
      },
      bind: async () => ({ ok: true, value: refreshed }),
      operate: async () => ({
        ok: true,
        value: {
          status: 'conflict',
          code: 'apply_conflict',
          reason: 'content_conflict',
          target: view('checkout-a', 4),
          baseStrategy: 'recorded_base',
          effectiveBaseOid: 'a'.repeat(40),
          localHeadOid: 'c'.repeat(40),
          isolatedHeadOid: 'd'.repeat(40),
          canRetryAfterRefresh: false,
          conflictingFiles: ['src/conflict.ts'],
        },
      }),
    })
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('a'), {
      snapshot: view('checkout-a', 3),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })

    await store.set(operateSessionTargetAtomFamily('a'), { action: 'apply' })

    expect(inspectCalls).toBe(1)
    expect(store.get(sessionTargetStateAtomFamily('a'))).toEqual({
      snapshot: refreshed,
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: {
        code: 'apply_conflict',
        message: 'Apply 冲突（使用记录基线，base aaaaaaa）：src/conflict.ts。Local 保持未变，可让 Agent 在当前 Worktree 解决后重试。',
      },
      conflict: {
        status: 'conflict',
        code: 'apply_conflict',
        reason: 'content_conflict',
        target: view('checkout-a', 4),
        baseStrategy: 'recorded_base',
        effectiveBaseOid: 'a'.repeat(40),
        localHeadOid: 'c'.repeat(40),
        isolatedHeadOid: 'd'.repeat(40),
        canRetryAfterRefresh: false,
        conflictingFiles: ['src/conflict.ts'],
      },
    })
  })

  test('Given 操作返回领域 error When atoms 完成动作 Then 保留稳定 code 并重新 inspect', async () => {
    const refreshed = view('checkout-a', 6)
    installApi({
      inspect: async () => ({ ok: true, value: refreshed }),
      bind: async () => ({ ok: true, value: refreshed }),
      operate: async () => ({
        ok: true,
        value: {
          status: 'error',
          code: 'dirty_confirmation_required',
          message: '需要确认丢弃 dirty checkout',
          target: view('checkout-a', 5),
        },
      }),
    })
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('a'), {
      snapshot: view('checkout-a', 4),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })

    await store.set(operateSessionTargetAtomFamily('a'), { action: 'discard', confirmDirty: true })

    expect(store.get(sessionTargetStateAtomFamily('a'))).toEqual({
      snapshot: refreshed,
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: {
        code: 'dirty_confirmation_required',
        message: '需要确认丢弃 dirty checkout',
      },
    })
  })

  test('Given Finish is requested When atoms operate Then the commit message is forwarded and the authoritative target is refreshed', async () => {
    const refreshed = view('checkout-a', 9)
    const operatedInputs: Array<Parameters<SessionCheckoutRendererApi['operate']>[0]> = []
    installApi({
      inspect: async () => ({ ok: true, value: refreshed }),
      bind: async () => ({ ok: true, value: refreshed }),
      operate: async (input) => {
        operatedInputs.push(input)
        return {
          ok: true,
          value: {
            status: 'finished',
            target: view('checkout-a', 8),
            changedFiles: ['src/task.ts'],
            commitOid: 'f'.repeat(40),
            cleanup: 'discarded',
          },
        }
      },
    })
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('a'), {
      snapshot: view('checkout-a', 7),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })

    await store.set(operateSessionTargetAtomFamily('a'), {
      action: 'finish',
      commitMessage: 'fix: finish task',
    })

    expect(operatedInputs[0]).toEqual({
      sessionId: 'a',
      action: 'finish',
      expectedRevision: 7,
      commitMessage: 'fix: finish task',
      retention: 'cleanup',
    })
    expect(store.get(sessionTargetStateAtomFamily('a'))).toEqual({
      snapshot: refreshed,
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })
  })

  test('Given a reviewed stage is saved When atoms operate Then only its Commit Message and authoritative revision cross IPC', async () => {
    const refreshed = {
      ...view('checkout-a', 9),
      delivery: { state: 'working' as const, iteration: 1 },
      checkpoints: [{
        checkpointId: 'checkpoint-1', sequence: 1, reviewId: 'review-1', createdAt: 1,
        summary: '阶段 A', validationStatus: 'passed' as const, changedFiles: ['src/task.ts'],
      }],
    }
    const operatedInputs: Array<Parameters<SessionCheckoutRendererApi['operate']>[0]> = []
    installApi({
      inspect: async () => ({ ok: true, value: refreshed }),
      bind: async () => ({ ok: true, value: refreshed }),
      operate: async (input) => {
        operatedInputs.push(input)
        return {
          ok: true,
          value: {
            status: 'checkpointed', target: refreshed, checkpoint: refreshed.checkpoints[0]!, changedFiles: ['src/task.ts'],
          },
        }
      },
    })
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('a'), {
      snapshot: view('checkout-a', 7), selectionRequired: false, loading: false, pendingAction: null, error: null,
    })

    await store.set(operateSessionTargetAtomFamily('a'), { action: 'checkpoint', commitMessage: 'feat: stage A' })

    expect(operatedInputs[0]).toEqual({
      sessionId: 'a', action: 'checkpoint', expectedRevision: 7, commitMessage: 'feat: stage A',
    })
    expect(store.get(sessionTargetStateAtomFamily('a')).snapshot?.checkpoints).toHaveLength(1)
  })

  test('Given Preview revision is confirmed When atoms operate Then authoritative resumeRevision crosses IPC', async () => {
    const refreshed = view('checkout-a', 9)
    const operatedInputs: Array<Parameters<SessionCheckoutRendererApi['operate']>[0]> = []
    installApi({
      inspect: async () => ({ ok: true, value: refreshed }),
      bind: async () => ({ ok: true, value: refreshed }),
      operate: async (input) => {
        operatedInputs.push(input)
        return { ok: true, value: { status: 'preview_rolled_back', target: refreshed, changedFiles: ['src/task.ts'] } }
      },
    })
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('a'), {
      snapshot: view('checkout-a', 7),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })

    await store.set(operateSessionTargetAtomFamily('a'), { action: 'rollback_preview', resumeRevision: true })

    expect(operatedInputs[0]).toEqual({
      sessionId: 'a',
      action: 'rollback_preview',
      expectedRevision: 7,
      resumeRevision: true,
    })
  })

  test('Given a completed collaborator is released When atoms operate Then only the authoritative child session ID crosses IPC', async () => {
    const refreshed = view('checkout-a', 8)
    const operatedInputs: Array<Parameters<SessionCheckoutRendererApi['operate']>[0]> = []
    installApi({
      inspect: async () => ({ ok: true, value: refreshed }),
      bind: async () => ({ ok: true, value: refreshed }),
      operate: async (input) => {
        operatedInputs.push(input)
        return {
          ok: true,
          value: {
            status: 'collaborator_released',
            target: refreshed,
            collaboratorSessionId: 'child-session',
          },
        }
      },
    })
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('a'), {
      snapshot: view('checkout-a', 7),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })

    await store.set(operateSessionTargetAtomFamily('a'), {
      action: 'release_collaborator',
      collaboratorSessionId: 'child-session',
    })

    expect(operatedInputs).toEqual([{
      sessionId: 'a',
      action: 'release_collaborator',
      expectedRevision: 7,
      collaboratorSessionId: 'child-session',
    }])
    expect(store.get(sessionTargetStateAtomFamily('a')).snapshot).toBe(refreshed)
  })

  test('Given bulk collaborator release is confirmed When atoms operate Then only session identity and expected revision cross IPC', async () => {
    const store = createStore()
    const snapshot = view('checkout-owner', 9)
    const calls: unknown[] = []
    installApi({
      inspect: async () => ({ ok: true, value: { ...snapshot, revision: 10, collaborators: undefined } }),
      bind: async () => ({ ok: true, value: snapshot }),
      operate: async (input) => {
        calls.push(input)
        return { ok: true, value: { status: 'collaborators_released', collaboratorSessionIds: ['child-1', 'child-2'], target: { ...snapshot, revision: 10 } } }
      },
    })
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot, selectionRequired: false, loading: false, pendingAction: null, error: null,
    })

    await store.set(operateSessionTargetAtomFamily('session-1'), { action: 'release_collaborators' })

    expect(calls).toEqual([{ sessionId: 'session-1', action: 'release_collaborators', expectedRevision: 9 }])
    expect(store.get(sessionTargetStateAtomFamily('session-1')).snapshot?.revision).toBe(10)
  })

  test('Given Apply returns stale_local When atoms refresh Then stable code and authoritative target are both preserved', async () => {
    const refreshed = view('checkout-a', 8)
    installApi({
      inspect: async () => ({ ok: true, value: refreshed }),
      bind: async () => ({ ok: true, value: refreshed }),
      operate: async () => ({
        ok: true,
        value: {
          status: 'error',
          code: 'stale_local',
          message: 'Local 在 plan 后发生变化，请重新计算',
          target: view('checkout-a', 7),
        },
      }),
    })
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('a'), {
      snapshot: view('checkout-a', 6),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })

    await store.set(operateSessionTargetAtomFamily('a'), { action: 'apply' })

    expect(store.get(sessionTargetStateAtomFamily('a'))).toEqual({
      snapshot: refreshed,
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: {
        code: 'stale_local',
        message: 'Local 在 plan 后发生变化，请重新计算',
      },
    })
  })

  test('Given Apply 与 Discard 成功 When atoms 完成动作 Then 每次都重新 inspect 获取权威 view', async () => {
    let revision = 10
    let inspectCalls = 0
    installApi({
      inspect: async ({ sessionId }) => {
        inspectCalls += 1
        revision += 1
        return { ok: true, value: view(`${sessionId}-refreshed`, revision) }
      },
      bind: async () => ({ ok: true, value: view('unused') }),
      operate: async ({ action }) => action === 'apply'
        ? { ok: true, value: { status: 'applied', target: view('stale-result'), changedFiles: ['a.ts'] } }
        : { ok: true, value: { status: 'discarded', target: view('stale-result') } },
    })
    const store = createStore()
    for (const action of ['apply', 'discard'] as const) {
      store.set(sessionTargetStateAtomFamily(action), {
        snapshot: view(`${action}-before`, 2),
        selectionRequired: false,
        loading: false,
        pendingAction: null,
        error: null,
      })
      if (action === 'discard') {
        await store.set(operateSessionTargetAtomFamily(action), { action, confirmDirty: true })
      } else {
        await store.set(operateSessionTargetAtomFamily(action), { action })
      }
      expect(store.get(sessionTargetStateAtomFamily(action)).snapshot).toEqual(
        view(`${action}-refreshed`, revision),
      )
      expect(store.get(sessionTargetStateAtomFamily(action)).error).toBeNull()
    }
    expect(inspectCalls).toBe(2)
  })

  test('Given an optimistic Apply When transport fails Then the session rolls back and refreshes from main without changing another session', async () => {
    const refreshed = view('checkout-a', 4)
    let inspectCalls = 0
    installApi({
      inspect: async ({ sessionId }) => {
        inspectCalls += 1
        return { ok: true, value: sessionId === 'a' ? refreshed : view('checkout-b') }
      },
      bind: async () => ({ ok: true, value: refreshed }),
      operate: async () => ({
        ok: false,
        error: { code: 'stale_revision', message: '目标已经变化，请重试' },
      }),
    })
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('a'), {
      snapshot: view('checkout-a', 3),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })
    store.set(sessionTargetStateAtomFamily('b'), {
      snapshot: view('checkout-b'),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })

    const applying = store.set(operateSessionTargetAtomFamily('a'), { action: 'apply' })
    expect(store.get(sessionTargetStateAtomFamily('a')).pendingAction).toBe('apply')
    expect(store.get(sessionTargetStateAtomFamily('a')).snapshot?.checkout.phase).toBe('mutating')
    await applying

    expect(inspectCalls).toBe(1)
    expect(store.get(sessionTargetStateAtomFamily('a'))).toEqual({
      snapshot: refreshed,
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: { code: 'stale_revision', message: '目标已经变化，请重试' },
    })
    expect(store.get(sessionTargetStateAtomFamily('b')).snapshot).toEqual(view('checkout-b'))
  })

  test('Given 用户勾选 Worktree When 设置 pending 偏好 Then 与 SessionTargetState 相互独立', async () => {
    installApi({
      inspect: async () => ({ ok: true, value: view('checkout-a') }),
      bind: async () => ({ ok: true, value: view('checkout-a') }),
      operate: async () => ({
        ok: true,
        value: { status: 'applied', target: view('unused'), changedFiles: [] },
      }),
    })
    const store = createStore()
    await store.set(inspectSessionTargetAtomFamily('a'))

    expect(store.get(sessionTargetWorktreePendingAtomFamily('a'))).toBeFalse()
    store.set(sessionTargetWorktreePendingAtomFamily('a'), true)
    expect(store.get(sessionTargetWorktreePendingAtomFamily('a'))).toBeTrue()
    store.set(sessionTargetWorktreePendingAtomFamily('a'), false)
    expect(store.get(sessionTargetWorktreePendingAtomFamily('a'))).toBeFalse()
  })

  test('Given bind 失败 When 调用方等待结果 Then 返回 false 并保留错误', async () => {
    installApi({
      inspect: async () => ({ ok: true, value: view('checkout-a') }),
      bind: async () => ({
        ok: false,
        error: { code: 'checkout_limit_reached', message: '已达到 managed checkout 上限' },
      }),
      operate: async () => ({
        ok: true,
        value: { status: 'applied', target: view('unused'), changedFiles: [] },
      }),
    })
    const store = createStore()

    const ok = await store.set(bindSessionTargetAtomFamily('a'), 'isolated')

    expect(ok).toBeFalse()
    expect(store.get(sessionTargetStateAtomFamily('a')).error?.code).toBe('checkout_limit_reached')
  })

  test('Given bind 成功 When 调用方等待结果 Then 返回 true 且 target 就绪', async () => {
    const bound = view('bound-a')
    installApi({
      inspect: async () => ({ ok: true, value: view('checkout-a') }),
      bind: async () => ({ ok: true, value: bound }),
      operate: async () => ({
        ok: true,
        value: { status: 'applied', target: view('unused'), changedFiles: [] },
      }),
    })
    const store = createStore()

    const ok = await store.set(bindSessionTargetAtomFamily('a'), 'isolated')

    expect(ok).toBeTrue()
    expect(store.get(sessionTargetStateAtomFamily('a')).snapshot).toEqual(bound)
  })

  test('Given operate IPC 超时 When 主进程随后完成提交 Then 自动等待收敛且不要求手动重试', async () => {
    enableFakeTimers()
    let inspectPhase: 'mutating' | 'finalized' = 'mutating'
    installApi({
      inspect: async () => ({
        ok: true,
        value: inspectPhase === 'finalized' ? finalizedView('checkout-a', 9) : mutatingView('checkout-a', 8),
      }),
      bind: async () => ({ ok: true, value: view('unused') }),
      // 主进程处理超过 IPC 超时（45s），operate 永不返回，由 invokeWithTimeout 超时。
      operate: async () => new Promise<never>(() => {}),
    })
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('a'), {
      snapshot: view('checkout-a', 7),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })

    const operating = store.set(operateSessionTargetAtomFamily('a'), { action: 'finish', commitMessage: 'fix: slow submit' })
    expect(store.get(sessionTargetStateAtomFamily('a')).pendingAction).toBe('finish')

    await tickFakeTimers(45_000) // 触发 IPC 超时，转入自动等待收敛
    await tickFakeTimers(2_000) // 第一轮轮询：主进程仍 mutating
    inspectPhase = 'finalized'
    await tickFakeTimers(2_000) // 第二轮轮询：拿到权威终态
    const result = await operating

    expect(result).toBeNull()
    expect(store.get(sessionTargetStateAtomFamily('a'))).toEqual({
      snapshot: finalizedView('checkout-a', 9),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })
  })

  test('Given operate IPC 超时 When 主进程最终未生效（phase 回到 ready） Then 展示中性提示而非失败', async () => {
    enableFakeTimers()
    let inspected = false
    installApi({
      inspect: async () => ({ ok: true, value: inspected ? view('checkout-a', 8) : mutatingView('checkout-a', 8) }),
      bind: async () => ({ ok: true, value: view('unused') }),
      operate: async () => new Promise<never>(() => {}),
    })
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('a'), {
      snapshot: view('checkout-a', 7),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })

    const operating = store.set(operateSessionTargetAtomFamily('a'), { action: 'finish', commitMessage: 'fix: not applied' })
    await tickFakeTimers(45_000)
    await tickFakeTimers(2_000) // 第一轮轮询：仍 mutating
    inspected = true
    await tickFakeTimers(2_000) // 第二轮轮询：回到 ready，操作未生效
    await operating

    expect(store.get(sessionTargetStateAtomFamily('a'))).toEqual(expect.objectContaining({
      snapshot: view('checkout-a', 8),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: {
        code: 'operate_incomplete',
        message: '操作已完成处理但未能确认结果，请查看当前状态；如未生效可重试。',
      },
    }))
  })

  test('Given operate IPC 立即 reject 非超时错误 When 调用方等待结果 Then 维持失败展示且不进入收敛等待', async () => {
    let inspectCalls = 0
    installApi({
      inspect: async () => {
        inspectCalls += 1
        return { ok: true, value: view('checkout-a', 4) }
      },
      bind: async () => ({ ok: true, value: view('unused') }),
      operate: async () => { throw new Error('ipc channel closed') },
    })
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('a'), {
      snapshot: view('checkout-a', 3),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })

    const result = await store.set(operateSessionTargetAtomFamily('a'), { action: 'apply' })

    expect(result).toBeNull()
    expect(inspectCalls).toBe(0)
    expect(store.get(sessionTargetStateAtomFamily('a'))).toEqual(expect.objectContaining({
      pendingAction: null,
      error: { code: 'operate_failed', message: 'ipc channel closed' },
    }))
  })
})

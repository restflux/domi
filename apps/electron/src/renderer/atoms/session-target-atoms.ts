import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type {
  RendererSessionTargetChoice,
  SessionCheckoutAction,
  SessionCheckoutConflictResult,
  SessionCheckoutIpcError,
  SessionCheckoutOperationResult,
  SessionTargetView,
  WorktreeRetentionMode,
  WorktreeApplyPreflightView,
} from '@domi/shared'

export interface SessionTargetState {
  snapshot: SessionTargetView | null
  selectionRequired: boolean
  loading: boolean
  pendingAction: SessionCheckoutAction | null
  error: SessionCheckoutIpcError | null
  /** 保留安全的结构化 Apply 冲突诊断，避免 renderer 只剩一行文件名。 */
  conflict?: SessionCheckoutConflictResult | null
  preflight?: WorktreeApplyPreflightView | null
  preflightLoading?: boolean
  preflightError?: SessionCheckoutIpcError | null
}

const EMPTY_STATE: SessionTargetState = {
  snapshot: null,
  selectionRequired: false,
  loading: false,
  pendingAction: null,
  error: null,
}

/**
 * IPC 超时专用错误：用于区分“主进程仍在处理”与真正的 IPC 失败。
 * 超时后主进程的 operate 通常仍在继续执行，渲染层应等待其收敛而不是要求用户重试。
 */
export class SessionCheckoutIpcTimeoutError extends Error {}

/**
 * IPC 超时保护：主进程 git/fs 操作被占用（如残留 Agent 进程锁住 Worktree）时可能长时间不返回。
 * 超时按“处理中”处理：operate 会转入自动等待收敛；冷启动 inspect/bind 才展示错误，已有快照的后台 inspect 保留当前状态。
 * Windows 上验收提交（plan + preview + finalize + cleanup）的正常耗时可达 20-40s，故不设 20s。
 */
const SESSION_CHECKOUT_IPC_TIMEOUT_MS = 45_000

/** operate 超时后自动等待主进程收敛的轮询参数（单位 ms）。 */
const OPERATION_SETTLE_POLL_INTERVAL_MS = 2_000
const OPERATION_SETTLE_POLL_ATTEMPT_TIMEOUT_MS = 10_000
const OPERATION_SETTLE_POLL_DEADLINE_MS = 120_000

async function invokeWithTimeout<T>(
  invoke: () => Promise<T>,
  timeoutMs: number = SESSION_CHECKOUT_IPC_TIMEOUT_MS,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      invoke(),
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => reject(new SessionCheckoutIpcTimeoutError(`Session Target 请求等待超过 ${timeoutMs}ms，后台操作可能仍在排队或执行`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

/**
 * operate 超时后轮询 inspect，直到主进程操作收敛（phase 不再是 mutating）或到达预算上限。
 * 主进程 operate 期间 phase 保持 mutating，且 inspect 在 binding 队列中排队等待锁，
 * 因此操作结束后下一次 inspect 必然能拿到权威终态。返回 null 表示预算耗尽仍未收敛。
 */
async function waitForOperationSettlement(sessionId: string): Promise<SessionTargetView | null> {
  const deadline = Date.now() + OPERATION_SETTLE_POLL_DEADLINE_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, OPERATION_SETTLE_POLL_INTERVAL_MS))
    let result: Awaited<ReturnType<typeof window.electronAPI.sessionCheckout.inspect>> | null = null
    try {
      result = await invokeWithTimeout(
        () => window.electronAPI.sessionCheckout.inspect({ sessionId }),
        OPERATION_SETTLE_POLL_ATTEMPT_TIMEOUT_MS,
      )
    } catch {
      // 主进程仍忙时 inspect 也会排队超时；继续下一轮。
    }
    if (result?.ok) {
      const view = result.value
      if (view.checkout.phase !== 'mutating') return view
    }
  }
  return null
}

/** 收敛后按终态推断操作结果：明确成功则不展示错误，其余给中性提示避免误判失败。 */
function settlementError(action: SessionCheckoutAction, view: SessionTargetView): SessionCheckoutIpcError | null {
  const phase = view.checkout.phase
  const deliveryState = view.delivery?.state
  const committed = phase === 'finalized' || phase === 'retained' || phase === 'discarded'
  const previewSettled = deliveryState === 'preview_active' || deliveryState === 'preview_detached'
  const rolledBack = action === 'rollback_preview' && !previewSettled
  if (committed || previewSettled || rolledBack) return null
  return {
    code: 'operate_incomplete',
    message: '操作已完成处理但未能确认结果，请查看当前状态；如未生效可重试。',
  }
}

export const sessionTargetStateAtomFamily = atomFamily((_sessionId: string) =>
  atom<SessionTargetState>({ ...EMPTY_STATE }),
)

/**
 * 用户勾选了 Worktree 但尚未在首次对话前完成创建的 UI 偏好。
 * 与 SessionTargetState 分离：它是纯渲染态，不随 inspect/bind/operate 覆盖，
 * 会话重启后由持久化的 target kind 重新推导。
 */
export const sessionTargetWorktreePendingAtomFamily = atomFamily((_sessionId: string) =>
  atom<boolean>(false),
)

function optimisticSnapshot(
  snapshot: SessionTargetView,
  action: SessionCheckoutAction,
): SessionTargetView {
  if (!['apply', 'finish', 'preview', 'checkpoint', 'rollback_preview', 'finalize_preview', 'retry_cleanup'].includes(action)) return snapshot
  return {
    ...snapshot,
    checkout: { ...snapshot.checkout, phase: 'mutating' },
  }
}

export interface InspectSessionTargetOptions {
  /** 周期刷新不切换全卡 loading，保留当前可读结果。 */
  silent?: boolean
}

function preflightIdentityMatchesSnapshot(
  preflight: WorktreeApplyPreflightView | null | undefined,
  snapshot: SessionTargetView,
): boolean {
  if (!preflight) return false
  const delivery = snapshot.delivery
  return delivery?.state === 'ready_for_review'
    && preflight.checkoutId === snapshot.checkout.id
    && preflight.reviewId === delivery.review.reviewId
    && preflight.revision === snapshot.revision
}

function preflightMatchesSnapshot(
  preflight: WorktreeApplyPreflightView | null | undefined,
  previousSnapshot: SessionTargetView | null | undefined,
  snapshot: SessionTargetView,
): boolean {
  const acceptanceSlotReleased = previousSnapshot?.reviewSlot === 'waiting' && snapshot.reviewSlot === 'available'
  return preflightIdentityMatchesSnapshot(preflight, snapshot) && !acceptanceSlotReleased
}

export const inspectSessionTargetAtomFamily = atomFamily((sessionId: string) => {
  const stateAtom = sessionTargetStateAtomFamily(sessionId)
  return atom(null, async (_get, set, options: InspectSessionTargetOptions = {}): Promise<void> => {
    if (!options.silent) set(stateAtom, (state) => ({ ...state, loading: true, error: null }))
    let result: Awaited<ReturnType<typeof window.electronAPI.sessionCheckout.inspect>> | null = null
    try {
      result = await invokeWithTimeout(() => window.electronAPI.sessionCheckout.inspect({ sessionId }))
    } catch (error) {
      set(stateAtom, (state) => {
        // 已有权威快照时，inspect 只是后台刷新。它可能排在 Session Checkout 的
        // 串行 mutation 后面，超时不等于当前 target 或用户操作失败；保留现状，
        // 避免验收卡和输入区重复展示同一条误导性错误，也不能提前解锁按钮。
        if (options.silent || state.snapshot) return { ...state, loading: false }
        return {
          ...EMPTY_STATE,
          error: {
            code: 'inspect_failed',
            message: error instanceof Error ? error.message : 'Session Target 检查失败，请重试',
          },
        }
      })
      return
    }
    if (result.ok) {
      set(stateAtom, (current) => {
        const keepPreflight = preflightMatchesSnapshot(current.preflight, current.snapshot, result.value)
        return {
          snapshot: result.value,
          selectionRequired: false,
          loading: false,
          pendingAction: current.pendingAction,
          error: current.pendingAction ? current.error : null,
          preflight: keepPreflight ? current.preflight : null,
          preflightLoading: false,
          preflightError: keepPreflight ? current.preflightError : null,
        }
      })
      return
    }
    if (result.error.code === 'target_unselected') {
      set(stateAtom, { ...EMPTY_STATE, selectionRequired: true })
      return
    }
    set(stateAtom, (state) => ({ ...state, loading: false, error: result.error }))
  })
})

export interface PreflightSessionTargetOptions {
  /** 已有结果时后台更新，不把结果区域切回 loading。 */
  silent?: boolean
  /** 外部状态变化使缓存结果过期时，先清空旧结果再重新计算。 */
  invalidateCached?: boolean
}

export const preflightSessionTargetAtomFamily = atomFamily((sessionId: string) => {
  const stateAtom = sessionTargetStateAtomFamily(sessionId)
  return atom(null, async (get, set, options: PreflightSessionTargetOptions = {}): Promise<WorktreeApplyPreflightView | null> => {
    const state = get(stateAtom)
    const snapshot = state.snapshot
    if (!snapshot || !window.electronAPI.sessionCheckout.preflight) return null
    const showLoading = !options.silent || !state.preflight || options.invalidateCached === true
    set(stateAtom, (current) => ({
      ...current,
      preflight: options.invalidateCached ? null : current.preflight,
      preflightLoading: showLoading,
      preflightError: null,
    }))
    try {
      const result = await invokeWithTimeout(() => window.electronAPI.sessionCheckout.preflight!({
        sessionId,
        expectedRevision: snapshot.revision,
      }))
      if (result.ok) {
        let accepted = false
        set(stateAtom, (current) => {
          const currentSnapshot = current.snapshot ?? snapshot
          const slotChangedWhilePending = snapshot.reviewSlot !== currentSnapshot.reviewSlot
          if (!preflightIdentityMatchesSnapshot(result.value, currentSnapshot) || slotChangedWhilePending) {
            return { ...current, preflightLoading: false }
          }
          accepted = true
          return {
            ...current,
            preflight: result.value,
            preflightLoading: false,
            preflightError: null,
          }
        })
        return accepted ? result.value : null
      }
      set(stateAtom, (current) => ({ ...current, preflightLoading: false, preflightError: result.error }))
    } catch (error) {
      set(stateAtom, (current) => ({
        ...current,
        preflightLoading: false,
        preflightError: {
          code: 'preflight_failed',
          message: error instanceof Error ? error.message : '同步预检失败，请重试',
        },
      }))
    }
    return null
  })
})

export interface ConfirmWorktreeIterationResult {
  authorizationToken: string
  continuationMessage: string
  requestId: string
  iteration: number
}

export const confirmWorktreeIterationAtomFamily = atomFamily((sessionId: string) => {
  const stateAtom = sessionTargetStateAtomFamily(sessionId)
  return atom(null, async (_get, set, requestId: string): Promise<ConfirmWorktreeIterationResult | null> => {
    const confirmIteration = window.electronAPI.sessionCheckout.confirmIteration
    if (!confirmIteration) {
      set(stateAtom, (state) => ({
        ...state,
        error: { code: 'unsupported', message: '当前版本不支持 Worktree 自动续跑确认' },
      }))
      return null
    }
    set(stateAtom, (state) => ({ ...state, loading: true, error: null }))
    try {
      const result = await invokeWithTimeout(() => confirmIteration({ sessionId, requestId }))
      if (result.ok) {
        set(stateAtom, {
          snapshot: result.value.target,
          selectionRequired: false,
          loading: false,
          pendingAction: null,
          error: null,
        })
        return {
          authorizationToken: result.value.authorizationToken,
          continuationMessage: result.value.continuationMessage,
          requestId: result.value.requestId,
          iteration: result.value.iteration,
        }
      }
      set(stateAtom, (state) => ({ ...state, loading: false, error: result.error }))
    } catch (error) {
      set(stateAtom, (state) => ({
        ...state,
        loading: false,
        error: {
          code: 'confirm_iteration_failed',
          message: error instanceof Error ? error.message : 'Worktree 自动续跑确认失败，请重试',
        },
      }))
    }
    return null
  })
})

export const bindSessionTargetAtomFamily = atomFamily((sessionId: string) => {
  const stateAtom = sessionTargetStateAtomFamily(sessionId)
  return atom(null, async (_get, set, kind: RendererSessionTargetChoice['kind']): Promise<boolean> => {
    set(stateAtom, (state) => ({ ...state, loading: true, error: null }))
    let result: Awaited<ReturnType<typeof window.electronAPI.sessionCheckout.bind>> | null = null
    try {
      result = await invokeWithTimeout(() => window.electronAPI.sessionCheckout.bind({ sessionId, choice: { kind } }))
    } catch (error) {
      set(stateAtom, {
        ...EMPTY_STATE,
        error: {
          code: 'bind_failed',
          message: error instanceof Error ? error.message : 'Session Target 绑定失败，请重试',
        },
      })
      return false
    }
    if (result.ok) {
      set(stateAtom, {
        snapshot: result.value,
        selectionRequired: false,
        loading: false,
        pendingAction: null,
        error: null,
      })
      return true
    }
    set(stateAtom, (state) => ({ ...state, loading: false, error: result.error }))
    return false
  })
})

export type OperateSessionTargetAtomInput =
  | { action: 'apply' | 'preview' | 'retry_cleanup' | 'recover' }
  | { action: 'checkpoint'; commitMessage: string }
  | { action: 'rollback_preview'; resumeRevision?: boolean }
  | { action: 'finish' | 'finalize_preview'; commitMessage: string; retention?: WorktreeRetentionMode }
  | { action: 'discard'; confirmDirty: boolean }
  | { action: 'release_collaborator'; collaboratorSessionId: string }
  | { action: 'release_collaborators' }

function getOperationError(result: SessionCheckoutOperationResult): SessionCheckoutIpcError | null {
  if (result.status === 'error') return { code: result.code, message: result.message }
  if (result.status === 'conflict') {
    const visibleFiles = result.conflictingFiles.slice(0, 3)
    const remaining = result.conflictingFiles.length - visibleFiles.length
    const fileSummary = `${visibleFiles.join('、')}${remaining > 0 ? ` 等 ${result.conflictingFiles.length} 个文件` : ''}`
    const strategyLabel = result.baseStrategy === 'isolated_contains_local_head'
      ? 'Isolated 已包含 Local HEAD'
      : result.baseStrategy === 'local_contains_isolated_head'
        ? 'Local 已包含 Isolated HEAD'
        : result.baseStrategy === 'shared_merge_base'
          ? '使用双方共享 Git 基线'
          : '使用记录基线'
    return {
      code: result.code,
      message: `Apply 冲突（${strategyLabel}，base ${result.effectiveBaseOid.slice(0, 7)}）：${fileSummary}。Local 保持未变，可让 Agent 在当前 Worktree 解决后重试。`,
    }
  }
  return null
}

export const operateSessionTargetAtomFamily = atomFamily((sessionId: string) => {
  const stateAtom = sessionTargetStateAtomFamily(sessionId)
  return atom(null, async (get, set, input: OperateSessionTargetAtomInput): Promise<SessionCheckoutOperationResult | null> => {
    const before = get(stateAtom)
    if (!before.snapshot || before.pendingAction) return null
    // 窄化提取：闭包内属性窄化会失效，先用局部常量固定 snapshot。
    const snapshot = before.snapshot

    set(stateAtom, {
      ...before,
      snapshot: optimisticSnapshot(snapshot, input.action),
      pendingAction: input.action,
      error: null,
      preflight: input.action === 'preview' || input.action === 'finish' ? null : before.preflight,
    })

    let result: Awaited<ReturnType<typeof window.electronAPI.sessionCheckout.operate>> | null = null
    try {
      result = await invokeWithTimeout(() => window.electronAPI.sessionCheckout.operate(input.action === 'checkpoint'
        ? {
            sessionId,
            action: input.action,
            expectedRevision: snapshot.revision,
            commitMessage: input.commitMessage,
          }
        : input.action === 'finish' || input.action === 'finalize_preview'
          ? {
            sessionId,
            action: input.action,
            expectedRevision: snapshot.revision,
            commitMessage: input.commitMessage,
            retention: input.retention ?? 'cleanup',
          }
        : input.action === 'rollback_preview'
          ? {
              sessionId,
              action: input.action,
              expectedRevision: snapshot.revision,
              ...(input.resumeRevision === undefined ? {} : { resumeRevision: input.resumeRevision }),
            }
          : input.action === 'discard'
            ? {
                sessionId,
                action: input.action,
                expectedRevision: snapshot.revision,
                confirmDirty: input.confirmDirty,
              }
            : input.action === 'release_collaborator'
              ? {
                  sessionId,
                  action: input.action,
                  expectedRevision: snapshot.revision,
                  collaboratorSessionId: input.collaboratorSessionId,
                }
              : input.action === 'release_collaborators'
                ? {
                    sessionId,
                    action: input.action,
                    expectedRevision: snapshot.revision,
                  }
              : {
                  sessionId,
                  action: input.action,
                  expectedRevision: snapshot.revision,
                }))
    } catch (error) {
      if (error instanceof SessionCheckoutIpcTimeoutError) {
        // 超时 ≠ 失败：主进程可能在继续执行（Windows 上清理/提交可能超过 45s）。
        // 保留 pendingAction 让按钮保持处理中，自动轮询等待主进程收敛，
        // 避免用户手动重试叠加排队或造成重复操作。
        const settled = await waitForOperationSettlement(sessionId)
        if (settled) {
          set(stateAtom, {
            snapshot: settled,
            selectionRequired: false,
            loading: false,
            pendingAction: null,
            error: settlementError(input.action, settled),
          })
          return null
        }
        set(stateAtom, (state) => ({
          ...state,
          loading: false,
          pendingAction: null,
          error: {
            code: 'operate_failed',
            message: '主进程长时间未完成操作，请稍后重试；若持续出现请重启 Domi。',
          },
        }))
        return null
      }
      set(stateAtom, (state) => ({
        ...state,
        loading: false,
        pendingAction: null,
        error: {
          code: 'operate_failed',
          message: error instanceof Error ? error.message : 'Session Target 操作失败，请重试',
        },
      }))
      return null
    }
    const operationResult = result.ok ? result.value : null
    const operationError = result.ok ? getOperationError(result.value) : result.error
    const operationConflict = result.ok && result.value.status === 'conflict' ? result.value : null

    // Operation result 只表达动作结果；完成后始终重新 inspect 获取权威 SessionTargetView。
    let refreshed: Awaited<ReturnType<typeof window.electronAPI.sessionCheckout.inspect>> | null = null
    try {
      refreshed = await invokeWithTimeout(() => window.electronAPI.sessionCheckout.inspect({ sessionId }))
    } catch {
      refreshed = null
    }
    if (refreshed?.ok) {
      set(stateAtom, {
        snapshot: refreshed.value,
        selectionRequired: false,
        loading: false,
        pendingAction: null,
        error: operationError,
        ...(operationConflict && { conflict: operationConflict }),
      })
      return operationResult
    }
    set(stateAtom, {
      snapshot: before.snapshot,
      selectionRequired: before.selectionRequired,
      loading: false,
      pendingAction: null,
      error: operationError ?? (refreshed?.error ?? { code: 'inspect_failed', message: 'Session Target 刷新失败，请重试' }),
      ...(operationConflict && { conflict: operationConflict }),
    })
    return operationResult
  })
})

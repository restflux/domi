import type { WorktreeApplyPreflightView } from '@domi/shared'

export const WORKTREE_REVIEW_REGENERATION_EVENT = 'domi:worktree-review-regeneration'

const STORAGE_KEY = 'domi:pending-worktree-review-regenerations'
const queuedRegenerations = new Map<string, WorktreeReviewRegenerationDetail>()
let storageLoaded = false

export type StaleIsolatedPreflight = Extract<WorktreeApplyPreflightView, { status: 'blocked' }> & {
  reason: 'stale_isolated'
  reviewId: string
}

export interface WorktreeReviewRegenerationDetail {
  sessionId: string
  requestId: string
  checkoutId: string
  reviewId: string
  revision: number
}

export interface WorktreeReviewRegenerationSendState {
  streaming: boolean
  messagesRefreshing: boolean
  messagesRefreshingRef: boolean
  messagesLoaded: boolean
  hasAgentChannel: boolean
  hasAvailableModel: boolean
  requiresTargetChoice: boolean
  preparingInitialWorktree: boolean
  targetLoading: boolean
  checkoutKind: 'local' | 'isolated' | null
  checkoutId: string | null
}

function validDetail(candidate: unknown): candidate is WorktreeReviewRegenerationDetail {
  if (!candidate || typeof candidate !== 'object') return false
  const value = candidate as Partial<WorktreeReviewRegenerationDetail>
  return typeof value.sessionId === 'string'
    && value.sessionId.length > 0
    && value.sessionId.length <= 100
    && typeof value.requestId === 'string'
    && value.requestId.length > 0
    && value.requestId.length <= 400
    && typeof value.checkoutId === 'string'
    && value.checkoutId.length > 0
    && value.checkoutId.length <= 100
    && typeof value.reviewId === 'string'
    && value.reviewId.length > 0
    && value.reviewId.length <= 100
    && typeof value.revision === 'number'
    && Number.isSafeInteger(value.revision)
    && value.revision >= 0
}

function loadStoredRegenerations(): void {
  if (storageLoaded || typeof window === 'undefined') return
  storageLoaded = true
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return
    for (const candidate of parsed) {
      if (validDetail(candidate)) queuedRegenerations.set(candidate.sessionId, candidate)
    }
  } catch {
    // Corrupt or blocked storage degrades to the in-memory queue for this renderer lifetime.
  }
}

function persistQueuedRegenerations(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...queuedRegenerations.values()]))
  } catch {
    // Private or blocked storage leaves the in-memory queue available for this renderer lifetime.
  }
}

export function isStaleIsolatedPreflight(preflight: WorktreeApplyPreflightView | null | undefined): preflight is StaleIsolatedPreflight {
  return preflight?.status === 'blocked'
    && preflight.reason === 'stale_isolated'
    && typeof preflight.reviewId === 'string'
    && preflight.reviewId.length > 0
}

export function createWorktreeReviewRegenerationFromPreflight(
  sessionId: string,
  preflight: StaleIsolatedPreflight,
): WorktreeReviewRegenerationDetail {
  return {
    sessionId,
    requestId: `review-regeneration:${preflight.checkoutId}:${preflight.reviewId}:${preflight.revision}`,
    checkoutId: preflight.checkoutId,
    reviewId: preflight.reviewId,
    revision: preflight.revision,
  }
}

export function buildWorktreeReviewRegenerationPrompt(detail: WorktreeReviewRegenerationDetail): string {
  return `当前 Worktree 的验收快照已经过期：ReadyForReview 之后文件又发生了变化。用户已点击“重新生成验收结果”。

请保持 Read Only，只读复核当前 managed Worktree；不要修改任何文件，也不要直接修改 Local。

执行要求：
1. 先确认当前 checkout 与 review 身份仍为 ${detail.checkoutId} / ${detail.reviewId}，并检查是否仍有后台任务、子 Agent 或其他进程在写入 Worktree；
2. 如果 Worktree 仍在变化，明确告诉用户“后台写入尚未结束”，不要生成新的验收结果；
3. 如果写入已经停止，重新检查当前实际变更，并重新执行必要验证，使验证范围与当前内容匹配；不要沿用旧 fingerprint 或未经复核的旧测试结论；
4. 验证完成后重新调用 ReadyForReview，生成基于当前 Worktree fingerprint 的新验收卡；
5. 本次只允许读、验证和重新生成验收结果，不要修改任何文件，不要调用 ApplyWorktree 或 FinishWorktree。`
}

export function shouldDeferWorktreeReviewRegeneration(
  detail: WorktreeReviewRegenerationDetail,
  state: WorktreeReviewRegenerationSendState,
): boolean {
  return state.streaming
    || state.messagesRefreshing
    || state.messagesRefreshingRef
    || !state.messagesLoaded
    || !state.hasAgentChannel
    || !state.hasAvailableModel
    || state.requiresTargetChoice
    || state.preparingInitialWorktree
    || state.targetLoading
    || state.checkoutKind !== 'isolated'
    || state.checkoutId !== detail.checkoutId
}

export function getQueuedWorktreeReviewRegeneration(sessionId: string): WorktreeReviewRegenerationDetail | null {
  loadStoredRegenerations()
  return queuedRegenerations.get(sessionId) ?? null
}

export function consumeQueuedWorktreeReviewRegeneration(sessionId: string, requestId: string): void {
  loadStoredRegenerations()
  if (queuedRegenerations.get(sessionId)?.requestId !== requestId) return
  queuedRegenerations.delete(sessionId)
  persistQueuedRegenerations()
}

/** Persist first, then notify an already-mounted AgentView. A later mount can still pull the queue. */
export function dispatchWorktreeReviewRegeneration(detail: WorktreeReviewRegenerationDetail): void {
  loadStoredRegenerations()
  queuedRegenerations.set(detail.sessionId, detail)
  persistQueuedRegenerations()
  window.dispatchEvent(new CustomEvent<WorktreeReviewRegenerationDetail>(WORKTREE_REVIEW_REGENERATION_EVENT, { detail }))
}

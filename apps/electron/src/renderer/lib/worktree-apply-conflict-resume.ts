import type { PermissionResponseResult, WorktreeApplyPreflightView } from '@domi/shared'

export const WORKTREE_APPLY_CONFLICT_RESUME_EVENT = 'domi:worktree-apply-conflict-resume'

const STORAGE_KEY = 'domi:pending-worktree-apply-conflict-resumes'
const queuedResumes = new Map<string, WorktreeApplyConflictResumeDetail>()
/** Renderer-lifetime single-flight guard; localStorage stays pending so a full reload can retry safely. */
const claimedResumeKeys = new Set<string>()
let storageLoaded = false

export interface WorktreeApplyConflictResumeDetail {
  sessionId: string
  requestId: string
  checkoutId: string
  revision: number
  localHeadOid: string
  conflictingFiles: string[]
}

function validDetail(candidate: unknown): candidate is WorktreeApplyConflictResumeDetail {
  if (!candidate || typeof candidate !== 'object') return false
  const value = candidate as Partial<WorktreeApplyConflictResumeDetail>
  return typeof value.sessionId === 'string'
    && typeof value.requestId === 'string'
    && typeof value.checkoutId === 'string'
    && typeof value.revision === 'number'
    && Number.isSafeInteger(value.revision)
    && value.revision >= 0
    && typeof value.localHeadOid === 'string'
    && /^[0-9a-f]{40}$/i.test(value.localHeadOid)
    && Array.isArray(value.conflictingFiles)
    && value.conflictingFiles.length <= 500
    && value.conflictingFiles.every((file) => typeof file === 'string' && file.length > 0 && file.length <= 1000)
}

function loadStoredResumes(): void {
  if (storageLoaded || typeof window === 'undefined') return
  storageLoaded = true
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return
    for (const candidate of parsed) {
      if (validDetail(candidate)) queuedResumes.set(candidate.sessionId, candidate)
    }
  } catch {
    // Corrupt/blocked storage degrades to the in-memory queue for the current renderer lifetime.
  }
}

function persistQueuedResumes(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...queuedResumes.values()]))
  } catch {
    // Private/blocked storage leaves the in-memory queue available for the current renderer lifetime.
  }
}

type WorktreeApplyConflictContinuation = Extract<
  NonNullable<PermissionResponseResult['continuation']>,
  { kind: 'worktree_apply_conflict' }
>

export function createWorktreeApplyConflictResumeFromContinuation(
  sessionId: string,
  continuation: WorktreeApplyConflictContinuation,
): WorktreeApplyConflictResumeDetail {
  return {
    sessionId,
    requestId: continuation.requestId,
    checkoutId: continuation.checkoutId,
    revision: continuation.revision,
    localHeadOid: continuation.localHeadOid,
    conflictingFiles: continuation.conflictingFiles.slice(0, 500),
  }
}

export function createWorktreeApplyConflictResumeFromPreflight(
  sessionId: string,
  preflight: Extract<WorktreeApplyPreflightView, { status: 'conflict' }>,
): WorktreeApplyConflictResumeDetail {
  return {
    sessionId,
    requestId: `preflight:${preflight.checkoutId}:${preflight.reviewId}:${preflight.revision}:${preflight.localHeadOid}`,
    checkoutId: preflight.checkoutId,
    revision: preflight.revision,
    localHeadOid: preflight.localHeadOid,
    conflictingFiles: preflight.conflictingFiles.slice(0, 500),
  }
}

export function buildWorktreeApplyConflictContinuationPrompt(detail: WorktreeApplyConflictResumeDetail): string {
  const files = detail.conflictingFiles.length > 0
    ? detail.conflictingFiles.map((file) => `- ${file}`).join('\n')
    : '- 未提供冲突文件；请先重新运行只读预检确认'
  return `刚才用户批准的 Worktree Apply 在实时校验时检测到真实冲突。Local 当前未修改，旧批准已因快照变化安全消费。请立即在当前 managed Worktree 中解决冲突，不要要求用户再次转述“继续”。

需要同步的 Local HEAD：
${detail.localHeadOid}

冲突文件：
${files}

执行要求：
1. 只在当前 managed Worktree 内通过 merge 整合上述 Local HEAD；不要直接修改 Local，也不要切换到另一 checkout；
2. 若当前 Worktree 已有 Domi Checkpoint，不得 rebase、reset 或以其他方式改写已保存阶段，必须保留 checkpoint commit ancestry（通常让 checkpoint commit 继续作为新 HEAD 的祖先）；
3. 按仓库冲突解决规范理解双方意图，解决全部 conflict，不要用 ours/theirs 粗暴覆盖；
4. 运行与冲突文件相关的聚焦测试和受影响 workspace typecheck；
5. merge 完成后，把上述 Local HEAD 视为重新验收的有效交付基线：ReadyForReview 的 changed files、details、summary 和建议 Commit Message 只能描述“该 Local HEAD → 当前 Worktree 最终快照”的净增量；不得把已经存在于该 Local HEAD 的功能、文件或提交重新写进本次验收与 Commit Message。原始 Session Base 只用于 checkpoint ancestry 和完整历史校验；
6. 验证通过后重新调用 ReadyForReview，并将其作为本轮最后一个、单独的工具调用，生成基于当前 Worktree 新快照的验收卡；
7. 不要再次调用 ApplyWorktree，也不要调用 FinishWorktree。旧 Apply 批准已被安全消费，必须让用户从新的“同步到 Local 验收”卡重新发起；
8. 若无法无歧义解决，明确列出冲突意图和阻塞点，不要修改 Local。`
}

export function getQueuedWorktreeApplyConflictResume(sessionId: string): WorktreeApplyConflictResumeDetail | null {
  loadStoredResumes()
  const detail = queuedResumes.get(sessionId)
  if (!detail || claimedResumeKeys.has(claimKey(sessionId, detail.requestId))) return null
  return detail
}

function claimKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`
}

export function claimQueuedWorktreeApplyConflictResume(
  sessionId: string,
  requestId: string,
): WorktreeApplyConflictResumeDetail | null {
  loadStoredResumes()
  const key = claimKey(sessionId, requestId)
  if (claimedResumeKeys.has(key)) return null
  const detail = queuedResumes.get(sessionId)
  if (detail?.requestId !== requestId) return null
  claimedResumeKeys.add(key)
  return detail
}

export function releaseClaimedWorktreeApplyConflictResume(sessionId: string, requestId: string): void {
  loadStoredResumes()
  const key = claimKey(sessionId, requestId)
  if (!claimedResumeKeys.has(key)) return
  claimedResumeKeys.delete(key)
}

export function consumeQueuedWorktreeApplyConflictResume(sessionId: string, requestId: string): void {
  loadStoredResumes()
  claimedResumeKeys.delete(claimKey(sessionId, requestId))
  if (queuedResumes.get(sessionId)?.requestId !== requestId) return
  queuedResumes.delete(sessionId)
  persistQueuedResumes()
}

/** Persist first, then notify an already-mounted AgentView. A later mount can still pull the queue. */
export function dispatchWorktreeApplyConflictResume(detail: WorktreeApplyConflictResumeDetail): void {
  loadStoredResumes()
  queuedResumes.set(detail.sessionId, detail)
  persistQueuedResumes()
  window.dispatchEvent(new CustomEvent<WorktreeApplyConflictResumeDetail>(WORKTREE_APPLY_CONFLICT_RESUME_EVENT, { detail }))
}

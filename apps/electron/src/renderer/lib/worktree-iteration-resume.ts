export const WORKTREE_ITERATION_RESUME_EVENT = 'domi:worktree-iteration-resume'

const queuedResumes = new Map<string, WorktreeIterationResumeDetail>()
const claimedResumeKeys = new Set<string>()
const activeConsumers = new Map<string, (detail: WorktreeIterationResumeDetail) => void>()
const reservedConsumers = new Map<string, (detail: WorktreeIterationResumeDetail) => void>()

function claimKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`
}

export interface WorktreeIterationResumeDetail {
  sessionId: string
  requestId: string
  iteration: number
  detailsMarkdown: string
  summary: string
  task: string
  mode: 'next_iteration' | 'preview_revision'
  authorizationToken?: string
  continuationMessage?: string
}

export function getQueuedWorktreeIterationResume(sessionId: string): WorktreeIterationResumeDetail | null {
  return queuedResumes.get(sessionId) ?? null
}

export function registerWorktreeIterationResumeConsumer(
  sessionId: string,
  consumer: (detail: WorktreeIterationResumeDetail) => void,
): () => void {
  activeConsumers.set(sessionId, consumer)
  return () => {
    if (activeConsumers.get(sessionId) === consumer) activeConsumers.delete(sessionId)
  }
}

/** Capture the current AgentView before the async checkout operation can outlive that view. */
export function reserveWorktreeIterationResumeConsumer(sessionId: string, requestId: string): void {
  const consumer = activeConsumers.get(sessionId)
  if (consumer) reservedConsumers.set(claimKey(sessionId, requestId), consumer)
}

export function cancelReservedWorktreeIterationResumeConsumer(sessionId: string, requestId: string): void {
  reservedConsumers.delete(claimKey(sessionId, requestId))
}

export function claimQueuedWorktreeIterationResume(sessionId: string, requestId: string): boolean {
  if (queuedResumes.get(sessionId)?.requestId !== requestId) return false
  const key = claimKey(sessionId, requestId)
  if (claimedResumeKeys.has(key)) return false
  claimedResumeKeys.add(key)
  return true
}

export function releaseClaimedWorktreeIterationResume(sessionId: string, requestId: string): void {
  claimedResumeKeys.delete(claimKey(sessionId, requestId))
}

export function consumeQueuedWorktreeIterationResume(sessionId: string, requestId: string): void {
  claimedResumeKeys.delete(claimKey(sessionId, requestId))
  reservedConsumers.delete(claimKey(sessionId, requestId))
  if (queuedResumes.get(sessionId)?.requestId !== requestId) return
  queuedResumes.delete(sessionId)
}

/** Queue first, then notify the captured/current AgentView. A later mount can still pull the queue. */
export function dispatchWorktreeIterationResume(detail: WorktreeIterationResumeDetail): void {
  queuedResumes.set(detail.sessionId, detail)
  const key = claimKey(detail.sessionId, detail.requestId)
  const consumer = reservedConsumers.get(key) ?? activeConsumers.get(detail.sessionId)
  reservedConsumers.delete(key)
  if (consumer) consumer(detail)
  window.dispatchEvent(new CustomEvent<WorktreeIterationResumeDetail>(WORKTREE_ITERATION_RESUME_EVENT, { detail }))
}

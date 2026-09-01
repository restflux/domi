export const LOCAL_MAINTENANCE_RESUME_EVENT = 'domi:local-maintenance-resume'

const STORAGE_KEY = 'domi:pending-local-maintenance-resumes'
const queuedResumes = new Map<string, LocalMaintenanceResumeDetail>()
let storageLoaded = false

export interface LocalMaintenanceResumeDetail {
  sessionId: string
  requestId: string
  transactionId: string
  goal: string
}

function loadStoredResumes(): void {
  if (storageLoaded || typeof window === 'undefined') return
  storageLoaded = true
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return
    for (const candidate of parsed) {
      if (
        candidate
        && typeof candidate === 'object'
        && typeof candidate.sessionId === 'string'
        && typeof candidate.requestId === 'string'
        && typeof candidate.transactionId === 'string'
        && typeof candidate.goal === 'string'
      ) {
        queuedResumes.set(candidate.sessionId, candidate as LocalMaintenanceResumeDetail)
      }
    }
  } catch {
    // Corrupt/blocked storage must not break permission handling; the in-memory queue still works.
  }
}

function persistQueuedResumes(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...queuedResumes.values()]))
  } catch {
    // Private/blocked storage degrades to the in-memory queue for the current renderer lifetime.
  }
}

export function buildLocalMaintenanceContinuationPrompt(detail: LocalMaintenanceResumeDetail): string {
  return `Local 维修事务 ${detail.transactionId} 已由用户确认并开启。请立即继续执行刚才被权限边界中断的任务，不要再次请求开启维修事务，也不要只回复进度说明。

维修目标：
${detail.goal}

执行要求：
1. 先调用 LocalMaintenanceStatus 核对事务仍为 active；
2. 使用 LocalMaintenanceWrite / LocalMaintenanceEdit / LocalMaintenanceBash 完成实际 Local 修复和验证；
3. 完成后必须调用 CompleteLocalMaintenance 收口并报告结果；
4. 不要使用普通 Write/Edit/Bash 绕过维修事务。`
}

export function getQueuedLocalMaintenanceResume(sessionId: string): LocalMaintenanceResumeDetail | null {
  loadStoredResumes()
  return queuedResumes.get(sessionId) ?? null
}

export function consumeQueuedLocalMaintenanceResume(sessionId: string, requestId: string): void {
  loadStoredResumes()
  if (queuedResumes.get(sessionId)?.requestId !== requestId) return
  queuedResumes.delete(sessionId)
  persistQueuedResumes()
}

/** Persist first, then notify any already-mounted AgentView. A later mount can still pull the queue. */
export function dispatchLocalMaintenanceResume(detail: LocalMaintenanceResumeDetail): void {
  loadStoredResumes()
  queuedResumes.set(detail.sessionId, detail)
  persistQueuedResumes()
  window.dispatchEvent(new CustomEvent<LocalMaintenanceResumeDetail>(LOCAL_MAINTENANCE_RESUME_EVENT, { detail }))
}

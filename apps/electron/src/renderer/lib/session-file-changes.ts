import type { SessionTargetFileInspection } from '@domi/shared'

export type SessionFileChangeKind = 'created' | 'edited'

export interface SessionFileChange {
  path: string
  kind: SessionFileChangeKind
  runId: string
  updatedAt: number
}

interface RecordSuccessfulNonGitFileChangeInput {
  inspection: SessionTargetFileInspection | null
  toolName: string
  existedBefore: boolean | undefined
  runId: string
  updatedAt: number
  isError: boolean
}

function normalizeSessionFileChangePath(path: string): string | null {
  if (typeof path !== 'string' || !path) return null
  const segments = path.replace(/\\/g, '/').split('/').filter((segment) => segment && segment !== '.')
  if (segments.length === 0 || segments.includes('..')) return null
  return segments.join('/')
}

export function getSessionFileChangeKind(
  toolName: string,
  existedBefore: boolean | undefined,
): SessionFileChangeKind {
  if (toolName === 'Write' && existedBefore === false) return 'created'
  return 'edited'
}

export function upsertSessionFileChange(
  changes: readonly SessionFileChange[],
  next: SessionFileChange,
): SessionFileChange[] {
  const normalizedPath = normalizeSessionFileChangePath(next.path)
  if (!normalizedPath) return [...changes]
  const normalizedNext = { ...next, path: normalizedPath }
  const index = changes.findIndex((change) => normalizeSessionFileChangePath(change.path) === normalizedPath)
  if (index < 0) return [normalizedNext, ...changes]

  const current = changes[index]!
  if (current.updatedAt > normalizedNext.updatedAt) return [...changes]
  const updated: SessionFileChange = {
    ...normalizedNext,
    // 本会话内新建的文件在后续编辑后仍应保持“新建”标识。
    kind: current.kind === 'created' ? 'created' : normalizedNext.kind,
  }
  return changes.map((change, changeIndex) => changeIndex === index ? updated : change)
}

export function recordSuccessfulNonGitFileChange(
  changes: readonly SessionFileChange[],
  input: RecordSuccessfulNonGitFileChangeInput,
): SessionFileChange[] {
  if (input.isError || !input.inspection || input.inspection.isGitRepo) return [...changes]
  return upsertSessionFileChange(changes, {
    path: input.inspection.relativePath,
    kind: getSessionFileChangeKind(input.toolName, input.existedBefore),
    runId: input.runId,
    updatedAt: input.updatedAt,
  })
}

export function groupSessionFileChanges(
  changes: readonly SessionFileChange[],
  currentRunId: string | undefined,
): { current: SessionFileChange[]; earlier: SessionFileChange[] } {
  if (!currentRunId) return { current: [...changes], earlier: [] }
  return {
    current: changes.filter((change) => change.runId === currentRunId),
    earlier: changes.filter((change) => change.runId !== currentRunId),
  }
}

export function shouldShowNonGitFileChanges(
  isGitRepo: boolean,
  changes: readonly SessionFileChange[],
): boolean {
  return !isGitRepo && changes.length > 0
}

export function deleteSessionFileChanges<T>(
  state: ReadonlyMap<string, T>,
  sessionId: string,
): Map<string, T> {
  if (!state.has(sessionId)) return state as Map<string, T>
  const next = new Map(state)
  next.delete(sessionId)
  return next
}

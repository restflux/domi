import { atom } from 'jotai'
import type {
  AgentSessionMeta,
  WorktreeLocalFileOverwrite,
  WorktreeLocalFilesError,
  WorktreeLocalFilesView,
} from '@domi/shared'
import { inspectSessionTargetAtomFamily } from './session-target-atoms.ts'

export interface WorktreeLocalFilesDialogRequest {
  projectId: string
  sessionId?: string
}

/** 项目菜单不能把其他项目的当前会话当作补复制目标。 */
export function getWorktreeLocalFilesDialogRequest(
  projectId: string,
  sessionId: string | null,
  sessions: ReadonlyArray<Pick<AgentSessionMeta, 'id' | 'workspaceId'>>,
): WorktreeLocalFilesDialogRequest {
  return sessions.some((session) => session.id === sessionId && session.workspaceId === projectId)
    ? { projectId, sessionId: sessionId ?? undefined }
    : { projectId }
}

export interface WorktreeLocalFilesDialogState {
  request: WorktreeLocalFilesDialogRequest | null
  view: WorktreeLocalFilesView | null
  paths: string[]
  loading: boolean
  busy: 'select' | 'save' | 'confirm' | 'prepare' | null
  error: WorktreeLocalFilesError | null
  notice: string | null
  folderSelections: Record<string, string[]>
}

const EMPTY_STATE: WorktreeLocalFilesDialogState = {
  request: null, view: null, paths: [], loading: false, busy: null, error: null, notice: null,
  folderSelections: {},
}

export const worktreeLocalFilesDialogAtom = atom<WorktreeLocalFilesDialogState>(EMPTY_STATE)
const inspectGenerationAtom = atom(0)

export function hasWorktreeLocalFilesChanges(state: WorktreeLocalFilesDialogState): boolean {
  const savedPaths = state.view?.entries.map((entry) => entry.path) ?? []
  return savedPaths.length !== state.paths.length || savedPaths.some((path, index) => state.paths[index] !== path)
}

export function canPrepareWorktreeLocalFiles(state: WorktreeLocalFilesDialogState): boolean {
  return !state.loading && !state.busy && !!state.request?.sessionId
    && state.view?.target?.sessionId === state.request.sessionId
    && state.view.target.canPrepare
    && !hasWorktreeLocalFilesChanges(state)
    && state.view.entries.every((entry) => entry.status !== 'unapproved')
}

function requestError(error: unknown): WorktreeLocalFilesError {
  return { code: 'request_failed', message: error instanceof Error ? error.message : '请求失败，请重试' }
}

export const refreshWorktreeLocalFilesDialogAtom = atom(null, async (get, set): Promise<void> => {
  const state = get(worktreeLocalFilesDialogAtom)
  const request = state.request
  if (!request || state.busy) return
  const generation = get(inspectGenerationAtom) + 1
  set(inspectGenerationAtom, generation)
  set(worktreeLocalFilesDialogAtom, { ...state, loading: true, error: null })
  const isCurrent = (): boolean => get(worktreeLocalFilesDialogAtom).request === request
    && get(inspectGenerationAtom) === generation
  try {
    const result = await window.electronAPI.worktreeLocalFiles.inspect(request)
    if (!isCurrent()) return
    set(worktreeLocalFilesDialogAtom, (current) => result.ok
      ? { ...current, loading: false, view: result.value, paths: result.value.entries.map((entry) => entry.path), folderSelections: {} }
      : { ...current, loading: false, view: null, paths: [], error: result.error })
  } catch (error) {
    if (isCurrent()) set(worktreeLocalFilesDialogAtom, (current) => ({ ...current, loading: false, view: null, paths: [], error: requestError(error) }))
  }
})

/** 打开只执行 inspect；批准和复制必须由用户显式操作。 */
export const openWorktreeLocalFilesDialogAtom = atom(null, async (_get, set, request: WorktreeLocalFilesDialogRequest): Promise<void> => {
  set(worktreeLocalFilesDialogAtom, { ...EMPTY_STATE, request: { ...request } })
  await set(refreshWorktreeLocalFilesDialogAtom)
})

export const closeWorktreeLocalFilesDialogAtom = atom(null, (_get, set): void => {
  set(worktreeLocalFilesDialogAtom, EMPTY_STATE)
})

export const removeWorktreeLocalFileAtom = atom(null, (get, set, path: string): void => {
  const state = get(worktreeLocalFilesDialogAtom)
  if (!state.request || state.loading || state.busy) return
  set(worktreeLocalFilesDialogAtom, { ...state, paths: state.paths.filter((item) => item !== path), error: null, notice: null })
})

export const removeWorktreeLocalDirectoryAtom = atom(null, (get, set, directory: string): void => {
  const state = get(worktreeLocalFilesDialogAtom)
  if (!state.request || state.loading || state.busy) return
  set(worktreeLocalFilesDialogAtom, { ...state, paths: state.paths.filter(path => !path.startsWith(`${directory}/`)), error: null, notice: null })
})

export interface WorktreeLocalFilesSelectionRequest { path: string; directory?: boolean }

type WorktreeLocalFilesAction =
  | { kind: 'save' | 'confirm' }
  | { kind: 'select'; selection: WorktreeLocalFilesSelectionRequest }
  | { kind: 'prepare'; overwriteFiles?: WorktreeLocalFileOverwrite[] }

const runWorktreeLocalFilesActionAtom = atom(null, async (get, set, action: WorktreeLocalFilesAction): Promise<void> => {
  const state = get(worktreeLocalFilesDialogAtom)
  const { request, view } = state
  if (!request || !view || state.busy || state.loading) return
  if (action.kind === 'confirm' && hasWorktreeLocalFilesChanges(state)) return
  if (action.kind === 'prepare') {
    if (!canPrepareWorktreeLocalFiles(state)) return
    // 覆盖许可只能指向 inspect 给出的现存文件及其精确快照，不把勾选扩大为路径级永久许可。
    if (action.overwriteFiles?.some((overwrite) => !view.target?.files.some((file) =>
      file.exists && state.paths.includes(file.path) && file.path === overwrite.path && file.fingerprint === overwrite.expectedFingerprint,
    ))) {
      set(worktreeLocalFilesDialogAtom, { ...state, error: { code: 'target_changed', message: '文件状态已变化，请刷新后重新确认覆盖。' } })
      return
    }
  }
  const isCurrent = (): boolean => get(worktreeLocalFilesDialogAtom).request === request
  set(worktreeLocalFilesDialogAtom, { ...state, busy: action.kind, error: null, notice: null })
  try {
    const api = window.electronAPI.worktreeLocalFiles
    if (action.kind === 'select') {
      const result = await api.resolveSelection({ projectId: request.projectId, paths: [action.selection.path], existingPaths: state.paths })
      if (!isCurrent()) return
      set(worktreeLocalFilesDialogAtom, (current) => result.ok
        ? { ...current, paths: [...new Set([...current.paths, ...result.value.paths])],
          folderSelections: action.selection.directory
            ? { ...current.folderSelections, [action.selection.path]: result.value.paths }
            : current.folderSelections }
        : { ...current, error: result.error })
      return
    }
    if (action.kind === 'prepare') {
      const target = view.target
      if (!target) return
      const result = await api.prepare({
        sessionId: target.sessionId,
        expectedRevision: target.revision,
        ...(action.overwriteFiles?.length ? { overwriteFiles: action.overwriteFiles } : {}),
      })
      if (result.ok) {
        // 即使用户已关闭面板，原会话的 Target 仍需要更新；不发送或重发任何输入。
        await set(inspectSessionTargetAtomFamily(target.sessionId), { silent: true })
      }
      if (!isCurrent()) return
      set(worktreeLocalFilesDialogAtom, (current) => ({ ...current, busy: null }))
      await set(refreshWorktreeLocalFilesDialogAtom)
      if (!isCurrent()) return
      set(worktreeLocalFilesDialogAtom, (current) => result.ok
        ? { ...current, notice: `已复制 ${result.value.copied.length} 个文件，跳过 ${result.value.skipped.length} 个文件。` }
        : { ...current, error: result.error })
      return
    }
    const result = action.kind === 'save'
      ? await api.save({ projectId: request.projectId, expectedVersion: view.manifestVersion, paths: state.paths })
      : await api.confirm({ projectId: request.projectId, expectedVersion: view.manifestVersion })
    if (!isCurrent()) return
    if (!result.ok) {
      set(worktreeLocalFilesDialogAtom, (current) => ({ ...current, error: result.error }))
      return
    }
    set(worktreeLocalFilesDialogAtom, (current) => ({ ...current, busy: null }))
    await set(refreshWorktreeLocalFilesDialogAtom)
    if (isCurrent()) set(worktreeLocalFilesDialogAtom, (current) => ({ ...current, notice: action.kind === 'save' ? '清单已保存并批准。' : '当前清单已批准。' }))
  } catch (error) {
    if (isCurrent()) set(worktreeLocalFilesDialogAtom, (current) => ({ ...current, error: requestError(error) }))
  } finally {
    if (isCurrent()) set(worktreeLocalFilesDialogAtom, (current) => ({ ...current, busy: null }))
  }
})

export const selectWorktreeLocalFilesAtom = atom(null, (_get, set, selection: WorktreeLocalFilesSelectionRequest) =>
  set(runWorktreeLocalFilesActionAtom, { kind: 'select', selection }))
export const saveWorktreeLocalFilesAtom = atom(null, (_get, set) => set(runWorktreeLocalFilesActionAtom, { kind: 'save' }))
export const confirmWorktreeLocalFilesAtom = atom(null, (_get, set) => set(runWorktreeLocalFilesActionAtom, { kind: 'confirm' }))
export const prepareWorktreeLocalFilesAtom = atom(null, (_get, set, overwriteFiles?: WorktreeLocalFileOverwrite[]) =>
  set(runWorktreeLocalFilesActionAtom, { kind: 'prepare', overwriteFiles }))

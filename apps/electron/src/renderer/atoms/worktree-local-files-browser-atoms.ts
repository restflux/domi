import { atom } from 'jotai'
import type { WorktreeLocalFilesError, WorktreeLocalFilesNode } from '@domi/shared'
import { worktreeLocalFilesDialogAtom, type WorktreeLocalFilesDialogState } from './worktree-local-files-atoms.ts'

export interface LocalFilesDirectoryState {
  entries: WorktreeLocalFilesNode[] | null
  loading: boolean
  error: WorktreeLocalFilesError | null
  generation: number
}
export interface LocalFilesBrowserState {
  query: string
  expanded: string[]
  directories: Record<string, LocalFilesDirectoryState>
  search: LocalFilesDirectoryState
}

const EMPTY_DIRECTORY: LocalFilesDirectoryState = { entries: null, loading: false, error: null, generation: 0 }
const EMPTY_BROWSER: LocalFilesBrowserState = { query: '', expanded: [], directories: {}, search: EMPTY_DIRECTORY }
interface BrowserContext {
  request: WorktreeLocalFilesDialogState['request']
  view: WorktreeLocalFilesDialogState['view']
  state: LocalFilesBrowserState
}
const browserContextAtom = atom<BrowserContext>({ request: null, view: null, state: EMPTY_BROWSER })
const loadGenerationAtom = atom(0)

/** 项目/inspect 快照切换立即丢弃目录缓存，不把旧路径带入另一项目。 */
export const worktreeLocalFilesBrowserAtom = atom(
  get => {
    const dialog = get(worktreeLocalFilesDialogAtom)
    const context = get(browserContextAtom)
    return context.request === dialog.request && context.view === dialog.view ? context.state : EMPTY_BROWSER
  },
  (get, set, update: (current: LocalFilesBrowserState) => LocalFilesBrowserState): void => {
    const dialog = get(worktreeLocalFilesDialogAtom)
    set(browserContextAtom, { request: dialog.request, view: dialog.view, state: update(get(worktreeLocalFilesBrowserAtom)) })
  },
)

export const setWorktreeLocalFilesQueryAtom = atom(null, (_get, set, query: string): void => {
  set(worktreeLocalFilesBrowserAtom, current => ({ ...current, query, search: EMPTY_DIRECTORY }))
})

export const loadWorktreeLocalDirectoryAtom = atom(null, async (get, set, input: { directory: string; query?: string }): Promise<void> => {
  const dialog = get(worktreeLocalFilesDialogAtom)
  const { request, view } = dialog
  if (!request || !view || dialog.loading) return
  const searching = input.query !== undefined
  const browser = get(worktreeLocalFilesBrowserAtom)
  if (searching && input.query !== browser.query) return
  const previous = searching ? browser.search : browser.directories[input.directory]
  if (previous?.loading || (previous?.entries && !previous.error)) return
  const generation = get(loadGenerationAtom) + 1
  set(loadGenerationAtom, generation)
  const pending = { entries: null, loading: true, error: null, generation }
  set(worktreeLocalFilesBrowserAtom, current => searching
    ? { ...current, search: pending }
    : { ...current, directories: { ...current.directories, [input.directory]: pending } })
  const isCurrent = (): boolean => {
    const currentDialog = get(worktreeLocalFilesDialogAtom)
    const current = get(worktreeLocalFilesBrowserAtom)
    const entry = searching ? current.search : current.directories[input.directory]
    return currentDialog.request === request && currentDialog.view === view && entry?.generation === generation
      && (!searching || current.query === input.query)
  }
  const complete = (result: LocalFilesDirectoryState): void => {
    if (!isCurrent()) return
    set(worktreeLocalFilesBrowserAtom, current => searching
      ? { ...current, search: result }
      : { ...current, directories: { ...current.directories, [input.directory]: result } })
  }
  try {
    const result = await window.electronAPI.worktreeLocalFiles.listDirectory({ projectId: request.projectId, ...input })
    complete(result.ok
      ? { entries: result.value.entries, loading: false, error: null, generation }
      : { entries: null, loading: false, error: result.error, generation })
  } catch (error) {
    complete({ entries: null, loading: false, error: { code: 'request_failed', message: error instanceof Error ? error.message : '文件列表读取失败，请重试' }, generation })
  }
})

export const toggleWorktreeLocalDirectoryAtom = atom(null, async (get, set, directory: string): Promise<void> => {
  const browser = get(worktreeLocalFilesBrowserAtom)
  const open = !browser.expanded.includes(directory)
  set(worktreeLocalFilesBrowserAtom, current => ({ ...current, expanded: open
    ? [...current.expanded, directory] : current.expanded.filter(path => path !== directory) }))
  if (open) await set(loadWorktreeLocalDirectoryAtom, { directory })
})

/** 刷新文件树不刷新清单，保留用户尚未保存的跨目录选择。 */
export const refreshWorktreeLocalFilesBrowserAtom = atom(null, async (get, set): Promise<void> => {
  set(worktreeLocalFilesBrowserAtom, current => ({ ...current, directories: {}, search: EMPTY_DIRECTORY }))
  const dialog = get(worktreeLocalFilesDialogAtom)
  set(worktreeLocalFilesDialogAtom, { ...dialog, folderSelections: {} })
  const query = get(worktreeLocalFilesBrowserAtom).query
  await set(loadWorktreeLocalDirectoryAtom, query.trim() ? { directory: '', query } : { directory: '' })
})

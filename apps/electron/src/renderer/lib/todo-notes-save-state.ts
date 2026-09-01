export type TodoNotesSavePhase = 'saving' | 'saved' | 'failed'

export interface TodoNotesSaveStatus {
  state: TodoNotesSavePhase
  todoId: string
  generation: number
}

export interface TodoNotesSaveRequestToken {
  todoId: string
  selectionEpoch: number
  generation: number
}

export interface RecoverableTodoDetailDraft {
  todoId: string
  expectedUpdatedAt: number
  title: string
  savedTitle: string
  notes: string
  savedNotes: string
}

export interface TodoDraftStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

const TODO_DRAFT_STORAGE_PREFIX = 'domi:planning:todo-draft:'

function defaultTodoDraftStorage(): TodoDraftStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

export function saveRecoverableTodoDetailDraft(
  draft: RecoverableTodoDetailDraft,
  storage: TodoDraftStorage | undefined = defaultTodoDraftStorage(),
): void {
  if (!storage) return
  const key = `${TODO_DRAFT_STORAGE_PREFIX}${draft.todoId}`
  if (draft.title === draft.savedTitle && draft.notes === draft.savedNotes) {
    storage.removeItem(key)
    return
  }
  storage.setItem(key, JSON.stringify(draft))
}

export function loadRecoverableTodoDetailDraft(
  todoId: string,
  storage: TodoDraftStorage | undefined = defaultTodoDraftStorage(),
): RecoverableTodoDetailDraft | null {
  if (!storage) return null
  try {
    const parsed = JSON.parse(storage.getItem(`${TODO_DRAFT_STORAGE_PREFIX}${todoId}`) ?? 'null') as Partial<RecoverableTodoDetailDraft> | null
    if (!parsed || parsed.todoId !== todoId || typeof parsed.expectedUpdatedAt !== 'number') return null
    if (typeof parsed.title !== 'string' || typeof parsed.savedTitle !== 'string' || typeof parsed.notes !== 'string' || typeof parsed.savedNotes !== 'string') return null
    return parsed as RecoverableTodoDetailDraft
  } catch {
    return null
  }
}

export function clearRecoverableTodoDetailDraft(
  todoId: string,
  storage: TodoDraftStorage | undefined = defaultTodoDraftStorage(),
): void {
  storage?.removeItem(`${TODO_DRAFT_STORAGE_PREFIX}${todoId}`)
}

export interface KeyedSerialTaskQueue {
  enqueue: <T>(key: string, operation: () => Promise<T>) => Promise<T>
}

/** 同一个 Todo 的 mutation 串行执行；不同 Todo 仍可并行。失败不会阻断后续任务。 */
export function createKeyedSerialTaskQueue(): KeyedSerialTaskQueue {
  const tails = new Map<string, Promise<void>>()
  return {
    async enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve()
      const current = previous.catch(() => undefined).then(operation)
      const tail = current.then(() => undefined, () => undefined)
      tails.set(key, tail)
      try {
        return await current
      } finally {
        if (tails.get(key) === tail) tails.delete(key)
      }
    },
  }
}

export function getVisibleTodoNotesSaveState(
  status: TodoNotesSaveStatus | null,
  selectedTodoId: string | null | undefined,
): TodoNotesSavePhase | null {
  return status && status.todoId === selectedTodoId ? status.state : null
}

export function isCurrentTodoNotesSaveRequest(
  request: TodoNotesSaveRequestToken,
  selectedTodoId: string | null | undefined,
  selectionEpoch: number,
  latestGeneration: number | undefined,
): boolean {
  return request.todoId === selectedTodoId
    && request.selectionEpoch === selectionEpoch
    && request.generation === latestGeneration
}

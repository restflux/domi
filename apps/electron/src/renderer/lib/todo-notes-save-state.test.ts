import { describe, expect, test } from 'bun:test'
import {
  clearRecoverableTodoDetailDraft,
  createKeyedSerialTaskQueue,
  getVisibleTodoNotesSaveState,
  isCurrentTodoNotesSaveRequest,
  loadRecoverableTodoDetailDraft,
  saveRecoverableTodoDetailDraft,
  type TodoDraftStorage,
  type TodoNotesSaveRequestToken,
  type TodoNotesSaveStatus,
} from './todo-notes-save-state'

const status: TodoNotesSaveStatus = {
  state: 'saving',
  todoId: 'todo-a',
  generation: 2,
}

const request: TodoNotesSaveRequestToken = {
  todoId: 'todo-a',
  selectionEpoch: 4,
  generation: 2,
}

function createMemoryStorage(): TodoDraftStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
  }
}

describe('Todo notes save state', () => {
  test('shows saving, saved and failed state only for the selected Todo', () => {
    expect(getVisibleTodoNotesSaveState(status, 'todo-a')).toBe('saving')
    expect(getVisibleTodoNotesSaveState({ ...status, state: 'saved' }, 'todo-a')).toBe('saved')
    expect(getVisibleTodoNotesSaveState({ ...status, state: 'failed' }, 'todo-a')).toBe('failed')
  })

  test('hides state that belongs to a previously selected Todo', () => {
    expect(getVisibleTodoNotesSaveState(status, 'todo-b')).toBeNull()
    expect(getVisibleTodoNotesSaveState(status, null)).toBeNull()
    expect(getVisibleTodoNotesSaveState(null, 'todo-a')).toBeNull()
  })

  test('accepts only the current selection epoch and latest request generation', () => {
    expect(isCurrentTodoNotesSaveRequest(request, 'todo-a', 4, 2)).toBe(true)
    expect(isCurrentTodoNotesSaveRequest(request, 'todo-b', 4, 2)).toBe(false)
    expect(isCurrentTodoNotesSaveRequest(request, 'todo-a', 5, 2)).toBe(false)
    expect(isCurrentTodoNotesSaveRequest(request, 'todo-a', 4, 3)).toBe(false)
  })

  test('serializes mutations for one Todo while allowing another Todo to proceed', async () => {
    const queue = createKeyedSerialTaskQueue()
    const steps: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = queue.enqueue('todo-a', async () => {
      steps.push('a1:start')
      await firstGate
      steps.push('a1:end')
    })
    const second = queue.enqueue('todo-a', async () => {
      steps.push('a2')
    })
    const other = queue.enqueue('todo-b', async () => {
      steps.push('b1')
    })

    await Promise.resolve()
    await other
    expect(steps).toEqual(['a1:start', 'b1'])
    releaseFirst?.()
    await Promise.all([first, second])
    expect(steps).toEqual(['a1:start', 'b1', 'a1:end', 'a2'])
  })

  test('continues a Todo queue after an earlier mutation fails', async () => {
    const queue = createKeyedSerialTaskQueue()
    const first = queue.enqueue('todo-a', async () => { throw new Error('conflict') })
    const second = queue.enqueue('todo-a', async () => 'saved')

    await expect(first).rejects.toThrow('conflict')
    await expect(second).resolves.toBe('saved')
  })

  test('persists and clears a recoverable draft around an unmount save', () => {
    const storage = createMemoryStorage()
    const draft = {
      todoId: 'todo-a',
      expectedUpdatedAt: 10,
      title: 'Title',
      savedTitle: 'Title',
      notes: 'unsaved notes',
      savedNotes: 'saved notes',
    }

    saveRecoverableTodoDetailDraft(draft, storage)
    expect(loadRecoverableTodoDetailDraft('todo-a', storage)).toEqual(draft)
    clearRecoverableTodoDetailDraft('todo-a', storage)
    expect(loadRecoverableTodoDetailDraft('todo-a', storage)).toBeNull()
  })

  test('does not retain a clean draft or malformed storage data', () => {
    const storage = createMemoryStorage()
    const clean = {
      todoId: 'todo-a',
      expectedUpdatedAt: 10,
      title: 'Title',
      savedTitle: 'Title',
      notes: 'same',
      savedNotes: 'same',
    }

    saveRecoverableTodoDetailDraft(clean, storage)
    expect(loadRecoverableTodoDetailDraft('todo-a', storage)).toBeNull()
    storage.setItem('domi:planning:todo-draft:todo-a', '{bad json')
    expect(loadRecoverableTodoDetailDraft('todo-a', storage)).toBeNull()
  })
})

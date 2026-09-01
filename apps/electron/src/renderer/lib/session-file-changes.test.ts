import { describe, expect, test } from 'bun:test'
import type { SessionTargetFileInspection } from '@domi/shared'
import {
  deleteSessionFileChanges,
  getSessionFileChangeKind,
  groupSessionFileChanges,
  recordSuccessfulNonGitFileChange,
  shouldShowNonGitFileChanges,
  upsertSessionFileChange,
  type SessionFileChange,
} from './session-file-changes.ts'

const nonGitInspection: SessionTargetFileInspection = {
  relativePath: 'docs/report.md',
  exists: true,
  isGitRepo: false,
}

function change(overrides: Partial<SessionFileChange> = {}): SessionFileChange {
  return {
    path: 'docs/report.md',
    kind: 'edited',
    runId: 'run-1',
    updatedAt: 1,
    ...overrides,
  }
}

describe('session file changes', () => {
  test('classifies a new Write as created and every overwrite-style tool as edited', () => {
    expect(getSessionFileChangeKind('Write', false)).toBe('created')
    expect(getSessionFileChangeKind('Write', true)).toBe('edited')
    expect(getSessionFileChangeKind('Edit', false)).toBe('edited')
    expect(getSessionFileChangeKind('MultiEdit', false)).toBe('edited')
    expect(getSessionFileChangeKind('NotebookEdit', false)).toBe('edited')
    expect(getSessionFileChangeKind('Update', false)).toBe('edited')
  })

  test('deduplicates normalized paths while preserving created status after later edits', () => {
    const created = upsertSessionFileChange([], change({
      path: './docs\\report.md',
      kind: 'created',
    }))
    const edited = upsertSessionFileChange(created, change({
      path: 'docs/report.md',
      kind: 'edited',
      runId: 'run-2',
      updatedAt: 2,
    }))

    expect(edited).toEqual([{
      path: 'docs/report.md',
      kind: 'created',
      runId: 'run-2',
      updatedAt: 2,
    }])
  })

  test('ignores a delayed older completion for the same file', () => {
    const current = [change({ runId: 'run-2', updatedAt: 20 })]
    expect(upsertSessionFileChange(current, change({ runId: 'run-1', updatedAt: 10 })))
      .toEqual(current)
  })

  test('records only successful writes in non-Git targets', () => {
    expect(recordSuccessfulNonGitFileChange([], {
      inspection: nonGitInspection,
      toolName: 'Write',
      existedBefore: false,
      runId: 'run-1',
      updatedAt: 10,
      isError: false,
    })).toEqual([{
      path: 'docs/report.md',
      kind: 'created',
      runId: 'run-1',
      updatedAt: 10,
    }])

    expect(recordSuccessfulNonGitFileChange([], {
      inspection: { ...nonGitInspection, isGitRepo: true },
      toolName: 'Write',
      existedBefore: false,
      runId: 'run-1',
      updatedAt: 10,
      isError: false,
    })).toEqual([])
    expect(recordSuccessfulNonGitFileChange([], {
      inspection: nonGitInspection,
      toolName: 'Write',
      existedBefore: false,
      runId: 'run-1',
      updatedAt: 10,
      isError: true,
    })).toEqual([])
    expect(recordSuccessfulNonGitFileChange([], {
      inspection: null,
      toolName: 'Write',
      existedBefore: false,
      runId: 'run-1',
      updatedAt: 10,
      isError: false,
    })).toEqual([])
  })

  test('groups the current run separately without leaking another session state', () => {
    const changes = [
      change({ path: 'current.md', runId: 'run-2', updatedAt: 3 }),
      change({ path: 'earlier.md', runId: 'run-1', updatedAt: 2 }),
    ]

    expect(groupSessionFileChanges(changes, 'run-2')).toEqual({
      current: [changes[0]!],
      earlier: [changes[1]!],
    })
    expect(groupSessionFileChanges(changes, undefined)).toEqual({
      current: changes,
      earlier: [],
    })
  })

  test('shows the fallback list only for a confirmed non-Git target with entries', () => {
    expect(shouldShowNonGitFileChanges(false, [change()])).toBeTrue()
    expect(shouldShowNonGitFileChanges(true, [change()])).toBeFalse()
    expect(shouldShowNonGitFileChanges(false, [])).toBeFalse()
  })

  test('deletes only the requested session entry during terminal cleanup', () => {
    const state = new Map([
      ['session-a', [change()]],
      ['session-b', [change({ path: 'other.md' })]],
    ])
    const next = deleteSessionFileChanges(state, 'session-a')

    expect(next.has('session-a')).toBeFalse()
    expect(next.get('session-b')).toEqual([change({ path: 'other.md' })])
    expect(deleteSessionFileChanges(next, 'missing')).toBe(next)
  })
})

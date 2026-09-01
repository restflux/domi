import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKMessage } from '@domi/shared'
import {
  AgentFileCheckpointStore,
  resolveLaterCheckpointUserIds,
  type AgentFileRestorePhase,
} from './agent-file-checkpoint.ts'
import type { AgentRewindUndoHostState } from './agent-rewind-undo-types.ts'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(options: { maxFileBytes?: number; maxSessionBytes?: number; maxFilesPerCheckpoint?: number; beforeRestore?: (phase: AgentFileRestorePhase, path: string) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'domi-file-checkpoint-'))
  tempRoots.push(root)
  const targetRoot = join(root, 'checkout')
  const storageRoot = join(root, 'history')
  mkdirSync(targetRoot, { recursive: true })
  const store = new AgentFileCheckpointStore({
    storageRoot,
    maxFileBytes: options.maxFileBytes ?? 1024 * 1024,
    maxSessionBytes: options.maxSessionBytes ?? 8 * 1024 * 1024,
    maxCheckpoints: 10,
    maxFilesPerCheckpoint: options.maxFilesPerCheckpoint ?? 100,
    now: () => 1_000,
    createId: (() => {
      let next = 0
      return () => `id-${++next}`
    })(),
    beforeRestore: options.beforeRestore,
  })
  return { root, targetRoot, storageRoot, store }
}

const undoHostState: AgentRewindUndoHostState = {
  sourcePi: {
    sdkSessionId: 'pi-source',
    piSessionFile: 'C:/sessions/source.jsonl',
    piEntryBindings: { 'assistant-1': 'entry-1', 'assistant-2': 'entry-2' },
  },
  rewoundPi: {
    sdkSessionId: 'pi-rewound',
    piSessionFile: 'C:/sessions/rewound.jsonl',
    piEntryBindings: { 'assistant-1': 'entry-1' },
  },
  sourceTranscriptContent: '{"type":"user","uuid":"user-1"}\n{"type":"assistant","uuid":"assistant-1"}\n{"type":"user","uuid":"user-2"}\n',
  rewoundTranscriptContent: '{"type":"user","uuid":"user-1"}\n{"type":"assistant","uuid":"assistant-1"}\n',
}

function writeTrackedTurn(input: {
  store: AgentFileCheckpointStore
  sessionId: string
  userMessageUuid: string
  targetRoot: string
  relativePath: string
  content: string
}): void {
  input.store.beginCheckpoint({
    sessionId: input.sessionId,
    userMessageUuid: input.userMessageUuid,
    targetRoot: input.targetRoot,
  })
  input.store.trackFileBeforeMutation({
    sessionId: input.sessionId,
    userMessageUuid: input.userMessageUuid,
    targetRoot: input.targetRoot,
    filePath: input.relativePath,
  })
  writeFileSync(join(input.targetRoot, input.relativePath), input.content)
  input.store.recordFileAfterMutation({
    sessionId: input.sessionId,
    targetRoot: input.targetRoot,
    filePath: input.relativePath,
  })
}

describe('AgentFileCheckpointStore', () => {
  test('列出会话历次目标中被 Agent 修改过的项目相对路径', () => {
    const { store, targetRoot } = fixture()
    mkdirSync(join(targetRoot, 'src'), { recursive: true })

    writeTrackedTurn({
      store,
      sessionId: 'session-1',
      userMessageUuid: 'user-1',
      targetRoot,
      relativePath: 'src/a.ts',
      content: 'first\n',
    })
    writeTrackedTurn({
      store,
      sessionId: 'session-1',
      userMessageUuid: 'user-2',
      targetRoot,
      relativePath: 'src/b.ts',
      content: 'second\n',
    })

    expect(store.listTrackedPaths('session-1')).toEqual(['src/a.ts', 'src/b.ts'])
    expect(store.listTrackedPaths('missing-session')).toEqual([])
  })

  test('Given two controlled turns modify one file When rewinding after the first assistant Then restores the state captured before the later turn', () => {
    const { store, targetRoot } = fixture()
    const filePath = join(targetRoot, 'src', 'a.ts')
    mkdirSync(join(targetRoot, 'src'), { recursive: true })
    writeFileSync(filePath, 'base\n')

    writeTrackedTurn({ store, sessionId: 'session-1', userMessageUuid: 'user-1', targetRoot, relativePath: 'src/a.ts', content: 'turn one\n' })
    writeTrackedTurn({ store, sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, relativePath: 'src/a.ts', content: 'turn two\n' })

    const preview = store.previewRewind({
      sessionId: 'session-1',
      targetRoot,
      laterUserMessageUuids: ['user-2'],
    })

    expect(preview).toMatchObject({
      available: true,
      changes: [{ path: 'src/a.ts', action: 'restore' }],
      conflicts: [],
      unsupported: [],
    })

    const applied = store.applyRewind({
      sessionId: 'session-1',
      targetRoot,
      laterUserMessageUuids: ['user-2'],
    })
    expect(applied.result).toMatchObject({ canRewind: true, filesChanged: ['src/a.ts'] })
    expect(readFileSync(filePath, 'utf8')).toBe('turn one\n')
    applied.commit()
  })

  test('Given a later turn creates a file When rewinding before that turn Then deletes the file because its checkpoint state is missing', () => {
    const { store, targetRoot } = fixture()

    writeTrackedTurn({ store, sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, relativePath: 'new.txt', content: 'created later\n' })

    const preview = store.previewRewind({
      sessionId: 'session-1',
      targetRoot,
      laterUserMessageUuids: ['user-2'],
    })
    expect(preview.changes).toEqual([{ path: 'new.txt', action: 'delete' }])

    const applied = store.applyRewind({
      sessionId: 'session-1',
      targetRoot,
      laterUserMessageUuids: ['user-2'],
    })
    expect(applied.result).toMatchObject({ canRewind: true, filesChanged: ['new.txt'] })
    expect(() => readFileSync(join(targetRoot, 'new.txt'))).toThrow()
    applied.commit()
  })

  test('Given one turn writes the same file more than once When rewinding Then the first pre-write state remains authoritative', () => {
    const { store, targetRoot } = fixture()
    writeFileSync(join(targetRoot, 'repeat.txt'), 'original\n')
    store.beginCheckpoint({ sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot })

    for (const content of ['first write\n', 'second write\n']) {
      store.trackFileBeforeMutation({
        sessionId: 'session-1',
        userMessageUuid: 'user-2',
        targetRoot,
        filePath: 'repeat.txt',
      })
      writeFileSync(join(targetRoot, 'repeat.txt'), content)
      store.recordFileAfterMutation({ sessionId: 'session-1', targetRoot, filePath: 'repeat.txt' })
    }

    const applied = store.applyRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'] })
    expect(readFileSync(join(targetRoot, 'repeat.txt'), 'utf8')).toBe('original\n')
    applied.commit()
  })

  test('Given a user changes a tracked file after the Agent write When previewing rewind Then reports a conflict and refuses mutation', () => {
    const { store, targetRoot } = fixture()
    writeFileSync(join(targetRoot, 'manual.txt'), 'base\n')
    writeTrackedTurn({ store, sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, relativePath: 'manual.txt', content: 'agent\n' })
    writeFileSync(join(targetRoot, 'manual.txt'), 'human edit\n')

    const preview = store.previewRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'] })
    expect(preview.conflicts).toEqual(['manual.txt'])
    expect(() => store.applyRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'] }))
      .toThrow('人工修改冲突')
    expect(readFileSync(join(targetRoot, 'manual.txt'), 'utf8')).toBe('human edit\n')
  })

  test('Given files were restored before conversation rewind When the caller rolls back Then the latest working state is restored', () => {
    const { store, targetRoot } = fixture()
    writeFileSync(join(targetRoot, 'rollback.txt'), 'before\n')
    writeTrackedTurn({ store, sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, relativePath: 'rollback.txt', content: 'latest\n' })

    const applied = store.applyRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'] })
    expect(readFileSync(join(targetRoot, 'rollback.txt'), 'utf8')).toBe('before\n')
    applied.rollback()

    expect(readFileSync(join(targetRoot, 'rollback.txt'), 'utf8')).toBe('latest\n')
  })

  test('Given a rewind is committed When the removed future checkpoint is previewed again Then it is no longer reachable', () => {
    const { store, targetRoot } = fixture()
    writeFileSync(join(targetRoot, 'commit.txt'), 'before\n')
    writeTrackedTurn({ store, sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, relativePath: 'commit.txt', content: 'after\n' })

    const applied = store.applyRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'] })
    applied.commit()

    const preview = store.previewRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'] })
    expect(preview.available).toBe(false)
    expect(preview.unsupported).toEqual([{ path: 'user-2', reason: 'checkpoint_missing' }])
  })

  test('Given an undoable rewind is committed When the store restarts Then the latest files and future checkpoints can be restored once', () => {
    const { storageRoot, store, targetRoot } = fixture()
    writeFileSync(join(targetRoot, 'undo.txt'), 'before\n')
    writeTrackedTurn({ store, sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, relativePath: 'undo.txt', content: 'latest\n' })

    const applied = store.applyRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'], undoHostState })
    expect(readFileSync(join(targetRoot, 'undo.txt'), 'utf8')).toBe('before\n')
    applied.commitUndoable(undoHostState)

    const restarted = new AgentFileCheckpointStore({ storageRoot })
    expect(restarted.getRewindUndoState({ sessionId: 'session-1', targetRoot })).toMatchObject({
      available: true,
      filesChanged: ['undo.txt'],
      conflicts: [],
    })

    const undo = restarted.prepareUndoRewind({ sessionId: 'session-1', targetRoot })
    expect(undo.hostState).toEqual(undoHostState)
    expect(undo.result).toMatchObject({ canUndo: true, filesChanged: ['undo.txt'] })
    expect(readFileSync(join(targetRoot, 'undo.txt'), 'utf8')).toBe('latest\n')
    undo.commit()

    expect(restarted.getRewindUndoState({ sessionId: 'session-1', targetRoot }).available).toBe(false)
    expect(restarted.previewRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'] })).toMatchObject({
      available: true,
      changes: [{ path: 'undo.txt', action: 'restore' }],
    })
  })

  test('Given the process stops after files rewind but before host commit When a new store recovers Then it rolls files back to the source state', () => {
    const { storageRoot, store, targetRoot } = fixture()
    writeFileSync(join(targetRoot, 'crash-rewind.txt'), 'before\n')
    writeTrackedTurn({ store, sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, relativePath: 'crash-rewind.txt', content: 'latest\n' })

    store.applyRewind({
      sessionId: 'session-1',
      targetRoot,
      laterUserMessageUuids: ['user-2'],
      undoHostState,
    })
    expect(readFileSync(join(targetRoot, 'crash-rewind.txt'), 'utf8')).toBe('before\n')

    const restarted = new AgentFileCheckpointStore({ storageRoot })
    expect(restarted.getRewindRecoveryState('session-1')).toMatchObject({ needed: true, phase: 'rewind_in_progress' })
    const recovery = restarted.prepareRewindRecovery({ sessionId: 'session-1', targetRoot })
    expect(recovery.target).toBe('source')
    expect(readFileSync(join(targetRoot, 'crash-rewind.txt'), 'utf8')).toBe('latest\n')
    recovery.commit()
    expect(restarted.getRewindRecoveryState('session-1').needed).toBe(false)
    expect(restarted.getRewindUndoState({ sessionId: 'session-1', targetRoot }).exists).toBe(false)
  })

  test('Given the process stops after undo writes files When a new store recovers Then it cancels the partial undo and keeps one retry', () => {
    const { storageRoot, store, targetRoot } = fixture()
    writeFileSync(join(targetRoot, 'crash-undo.txt'), 'before\n')
    writeTrackedTurn({ store, sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, relativePath: 'crash-undo.txt', content: 'latest\n' })
    const rewind = store.applyRewind({
      sessionId: 'session-1',
      targetRoot,
      laterUserMessageUuids: ['user-2'],
      undoHostState,
    })
    rewind.commitUndoable(undoHostState)
    store.prepareUndoRewind({ sessionId: 'session-1', targetRoot })
    expect(readFileSync(join(targetRoot, 'crash-undo.txt'), 'utf8')).toBe('latest\n')

    const restarted = new AgentFileCheckpointStore({ storageRoot })
    expect(restarted.getRewindRecoveryState('session-1')).toMatchObject({ needed: true, phase: 'undo_in_progress' })
    const recovery = restarted.prepareRewindRecovery({ sessionId: 'session-1', targetRoot })
    expect(recovery.target).toBe('rewound')
    expect(readFileSync(join(targetRoot, 'crash-undo.txt'), 'utf8')).toBe('before\n')
    recovery.commit()
    expect(restarted.getRewindUndoState({ sessionId: 'session-1', targetRoot })).toMatchObject({ exists: true, available: true })
  })

  test('Given a rewound file is manually edited When undo is requested Then reports a conflict and performs no mutation', () => {
    const { store, targetRoot } = fixture()
    writeFileSync(join(targetRoot, 'undo-conflict.txt'), 'before\n')
    writeTrackedTurn({ store, sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, relativePath: 'undo-conflict.txt', content: 'latest\n' })
    const applied = store.applyRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'], undoHostState })
    applied.commitUndoable(undoHostState)
    writeFileSync(join(targetRoot, 'undo-conflict.txt'), 'human after rewind\n')

    expect(store.getRewindUndoState({ sessionId: 'session-1', targetRoot })).toMatchObject({
      available: false,
      conflicts: ['undo-conflict.txt'],
    })
    expect(() => store.prepareUndoRewind({ sessionId: 'session-1', targetRoot })).toThrow('人工修改冲突')
    expect(readFileSync(join(targetRoot, 'undo-conflict.txt'), 'utf8')).toBe('human after rewind\n')
  })

  test('Given an undoable rewind is finalized When previewing the old future checkpoint Then it is permanently unreachable', () => {
    const { store, targetRoot } = fixture()
    writeFileSync(join(targetRoot, 'finalize.txt'), 'before\n')
    writeTrackedTurn({ store, sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, relativePath: 'finalize.txt', content: 'latest\n' })
    const applied = store.applyRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'], undoHostState })
    applied.commitUndoable(undoHostState)

    store.finalizeRewindUndo('session-1')

    expect(store.getRewindUndoState({ sessionId: 'session-1', targetRoot }).available).toBe(false)
    expect(store.previewRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'] })).toMatchObject({
      available: false,
      unsupported: [{ path: 'user-2', reason: 'checkpoint_missing' }],
    })
  })

  test('Given a conversation-only rewind When committed undoable Then restart can recover its host state without touching files', () => {
    const { storageRoot, store, targetRoot } = fixture()
    const prepared = store.prepareConversationOnlyRewind({ sessionId: 'session-1', targetRoot, undoHostState })
    prepared.commitUndoable(undoHostState)

    const restarted = new AgentFileCheckpointStore({ storageRoot })
    const undo = restarted.prepareUndoRewind({ sessionId: 'session-1', targetRoot })
    expect(undo.hostState).toEqual(undoHostState)
    expect(undo.result).toMatchObject({ canUndo: true, filesChanged: [] })
    undo.commit()
  })

  test('Given undo apply and compensation both fail When undoing a rewind Then retains the transaction and reports every affected file', () => {
    const { store, targetRoot, storageRoot } = fixture({
      beforeRestore: (phase, path) => {
        if (phase === 'undo' && path === 'two.txt') throw new Error('undo two failed')
        if (phase === 'undo_rollback' && path === 'one.txt') throw new Error('undo rollback one failed')
      },
    })
    for (const path of ['one.txt', 'two.txt']) writeFileSync(join(targetRoot, path), 'before\n')
    store.beginCheckpoint({ sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot })
    for (const path of ['one.txt', 'two.txt']) {
      store.trackFileBeforeMutation({ sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, filePath: path })
      writeFileSync(join(targetRoot, path), 'latest\n')
      store.recordFileAfterMutation({ sessionId: 'session-1', targetRoot, filePath: path })
    }
    const rewind = store.applyRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'], undoHostState })
    rewind.commitUndoable(undoHostState)

    const undo = store.prepareUndoRewind({ sessionId: 'session-1', targetRoot })

    expect(undo.result).toMatchObject({ canUndo: false, rollbackIncomplete: true })
    expect(undo.result.failedFiles).toEqual([
      { path: 'two.txt', error: 'undo two failed' },
      { path: 'one.txt', error: 'undo rollback one failed' },
    ])
    expect(readFileSync(join(targetRoot, 'one.txt'), 'utf8')).toBe('latest\n')
    expect(readFileSync(join(targetRoot, 'two.txt'), 'utf8')).toBe('before\n')
    expect(readdirSync(join(storageRoot, 'session-1', 'transactions')).length).toBe(1)
  })

  test('Given multi-file apply and rollback both fail When rewinding Then retains the recovery transaction and reports every affected file', () => {
    const fixtureState = fixture({
      beforeRestore: (phase, path) => {
        if (phase === 'apply' && path === 'two.txt') throw new Error('apply two failed')
        if (phase === 'rollback' && path === 'one.txt') throw new Error('rollback one failed')
      },
    })
    const { store, targetRoot, storageRoot } = fixtureState
    for (const path of ['one.txt', 'two.txt']) writeFileSync(join(targetRoot, path), 'before\n')
    store.beginCheckpoint({ sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot })
    for (const path of ['one.txt', 'two.txt']) {
      store.trackFileBeforeMutation({ sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, filePath: path })
      writeFileSync(join(targetRoot, path), 'latest\n')
      store.recordFileAfterMutation({ sessionId: 'session-1', targetRoot, filePath: path })
    }

    const applied = store.applyRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'] })

    expect(applied.result).toMatchObject({ canRewind: false, rollbackIncomplete: true })
    expect(applied.result.failedFiles).toEqual([
      { path: 'two.txt', error: 'apply two failed' },
      { path: 'one.txt', error: 'rollback one failed' },
    ])
    expect(readFileSync(join(targetRoot, 'one.txt'), 'utf8')).toBe('before\n')
    expect(readFileSync(join(targetRoot, 'two.txt'), 'utf8')).toBe('latest\n')
    const [transactionId] = readdirSync(join(storageRoot, 'session-1', 'transactions'))
    const transaction = JSON.parse(readFileSync(
      join(storageRoot, 'session-1', 'transactions', transactionId!, 'transaction.json'),
      'utf8',
    )) as { files: Array<{ path: string }> }
    expect(transaction.files.map((file) => file.path)).toEqual(['one.txt', 'two.txt'])
  })

  test('Given a backup disappears after preview When preview runs Then marks the plan unavailable before touching files', () => {
    const { storageRoot, store, targetRoot } = fixture()
    writeFileSync(join(targetRoot, 'missing-backup.txt'), 'before\n')
    writeTrackedTurn({ store, sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, relativePath: 'missing-backup.txt', content: 'latest\n' })
    const backupRoot = join(storageRoot, 'session-1', 'backups')
    const checkpointDir = join(backupRoot, readdirSync(backupRoot)[0]!)
    unlinkSync(join(checkpointDir, readdirSync(checkpointDir)[0]!))

    const preview = store.previewRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'] })

    expect(preview.available).toBe(false)
    expect(preview.unsupported).toEqual([{ path: 'missing-backup.txt', reason: 'io_error' }])
    expect(readFileSync(join(targetRoot, 'missing-backup.txt'), 'utf8')).toBe('latest\n')
  })

  test('Given a preflight-only user turn is marked no-mutation When rewinding across it Then it does not poison otherwise safe coverage', () => {
    const { store, targetRoot } = fixture()
    store.markNoMutation('session-1', 'user-preflight-error')

    const preview = store.previewRewind({
      sessionId: 'session-1',
      targetRoot,
      laterUserMessageUuids: ['user-preflight-error'],
    })

    expect(preview).toMatchObject({ available: true, changes: [], conflicts: [], unsupported: [] })
  })

  test('Given checkpoint state was persisted When a new store instance previews rewind Then it can restore without Pi artifacts', () => {
    const { storageRoot, store, targetRoot } = fixture()
    writeFileSync(join(targetRoot, 'resume.txt'), 'before\n')
    writeTrackedTurn({ store, sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, relativePath: 'resume.txt', content: 'after\n' })

    const restarted = new AgentFileCheckpointStore({ storageRoot })
    const applied = restarted.applyRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'] })

    expect(readFileSync(join(targetRoot, 'resume.txt'), 'utf8')).toBe('before\n')
    applied.commit()
  })

  test('Given a path escapes through a directory junction or symlink When tracking Then records unsupported coverage instead of copying outside content', () => {
    const { root, store, targetRoot } = fixture()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'outside\n')
    symlinkSync(outside, join(targetRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    store.beginCheckpoint({ sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot })

    store.trackFileBeforeMutation({
      sessionId: 'session-1',
      userMessageUuid: 'user-2',
      targetRoot,
      filePath: 'linked/secret.txt',
    })

    const preview = store.previewRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'] })
    expect(preview.unsupported).toEqual([{ path: 'linked/secret.txt', reason: 'path_outside_target' }])
  })

  test('Given one turn exceeds the bounded tracked-file count When tracking Then stops growing the manifest and marks coverage incomplete', () => {
    const { store, targetRoot } = fixture({ maxFilesPerCheckpoint: 1 })
    store.beginCheckpoint({ sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot })
    store.trackFileBeforeMutation({ sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, filePath: 'one.txt' })
    store.trackFileBeforeMutation({ sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, filePath: 'two.txt' })

    const preview = store.previewRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'] })
    expect(preview.available).toBe(false)
    expect(preview.unsupported).toContainEqual({ path: '<checkpoint-file-limit>', reason: 'session_limit_exceeded' })
  })

  test('Given checkpoint tracking fails around a write When marked incomplete Then preview never claims the file is safely restorable', () => {
    const { store, targetRoot } = fixture()
    writeFileSync(join(targetRoot, 'uncertain.txt'), 'before\n')
    store.beginCheckpoint({ sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot })
    store.trackFileBeforeMutation({ sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, filePath: 'uncertain.txt' })
    writeFileSync(join(targetRoot, 'uncertain.txt'), 'after\n')
    store.markCheckpointIncomplete({ sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, filePath: 'uncertain.txt' })

    const preview = store.previewRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'] })
    expect(preview.available).toBe(false)
    expect(preview.unsupported).toContainEqual({ path: 'uncertain.txt', reason: 'io_error' })
    expect(preview.changes).toEqual([])
  })

  test('Given a file exceeds the initial checkpoint limit When tracking Then leaves the write usable but marks rewind coverage incomplete', () => {
    const { store, targetRoot } = fixture({ maxFileBytes: 4 })
    writeFileSync(join(targetRoot, 'large.txt'), '12345')
    store.beginCheckpoint({ sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot })
    store.trackFileBeforeMutation({ sessionId: 'session-1', userMessageUuid: 'user-2', targetRoot, filePath: 'large.txt' })

    const preview = store.previewRewind({ sessionId: 'session-1', targetRoot, laterUserMessageUuids: ['user-2'] })
    expect(preview.available).toBe(false)
    expect(preview.unsupported).toEqual([{ path: 'large.txt', reason: 'file_too_large' }])
  })
})

describe('resolveLaterCheckpointUserIds', () => {
  test('Given a stored assistant target When resolving file rewind boundaries Then returns later real user UUIDs and ignores tool results', () => {
    const messages = [
      { type: 'user', uuid: 'user-1', message: { content: [{ type: 'text', text: 'one' }] } },
      { type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'user', uuid: 'tool-result', message: { content: [{ type: 'tool_result' }] } },
      { type: 'user', uuid: 'user-2', message: { content: [{ type: 'text', text: 'two' }] } },
      { type: 'assistant', uuid: 'assistant-2', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'user', uuid: 'user-3', message: { content: [{ type: 'text', text: 'three' }] } },
    ] as unknown as SDKMessage[]

    expect(resolveLaterCheckpointUserIds(messages, 'assistant-1')).toEqual({
      laterUserMessageUuids: ['user-2', 'user-3'],
      missingUserMessageUuid: false,
    })
  })

  test('Given a later historical user message has no UUID When resolving Then marks checkpoint coverage incomplete', () => {
    const messages = [
      { type: 'assistant', uuid: 'assistant-1', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'user', message: { content: [{ type: 'text', text: 'legacy' }] } },
    ] as unknown as SDKMessage[]

    expect(resolveLaterCheckpointUserIds(messages, 'assistant-1')).toEqual({
      laterUserMessageUuids: [],
      missingUserMessageUuid: true,
    })
  })
})

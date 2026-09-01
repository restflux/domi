import { describe, expect, test } from 'bun:test'
import type { SessionTargetView, UnstagedChangesResult } from '@domi/shared'
import { SessionProjectArtifactService } from './session-project-artifact-service.ts'

const workingTarget = {
  checkout: { kind: 'isolated', id: 'checkout-1', phase: 'ready' },
  source: { ref: 'refs/heads/main', oid: 'base' },
  current: { branch: null, oid: 'head' },
  ownership: 'owner',
  dirty: true,
  revision: 1,
  delivery: { state: 'working', iteration: 1 },
} as SessionTargetView

const currentChanges: UnstagedChangesResult = {
  isGitRepo: true,
  files: [
    { filePath: 'src/current.ts', status: 'modified', additions: 1, deletions: 0, source: 'workspace', gitRoot: '/target' },
    { filePath: 'docs/deleted.md', status: 'deleted', additions: 0, deletions: 1, source: 'workspace', gitRoot: '/target' },
  ],
  untrackedFiles: [{ filePath: 'docs/new.md', gitRoot: '/target' }],
  gitRootNames: [],
}

describe('SessionProjectArtifactService', () => {
  test('工作中的会话合并当前改动与历史产物，只返回目标中仍存在的文件', async () => {
    const resolved = new Map([
      ['docs/history.html', '/target/docs/history.html'],
      ['docs/new.md', '/target/docs/new.md'],
      ['src/current.ts', '/target/src/current.ts'],
    ])
    const service = new SessionProjectArtifactService({
      inspectTarget: async () => workingTarget,
      readPersistedChangedFiles: () => ['docs/history.html', 'docs/deleted.md'],
      readCheckpointPaths: () => ['src/current.ts'],
      getCurrentChanges: async () => currentChanges,
      resolveExistingFiles: async (_sessionId, relativePaths) => new Map(
        relativePaths.flatMap((path) => resolved.has(path) ? [[path, resolved.get(path)!]] : []),
      ),
      statFile: () => ({ isFile: () => true, size: 12, mtimeMs: 34 }),
    })

    expect(await service.list('session-1')).toEqual([
      { relativePath: 'docs/history.html', name: 'history.html', size: 12, mtime: 34 },
      { relativePath: 'docs/new.md', name: 'new.md', size: 12, mtime: 34 },
      { relativePath: 'src/current.ts', name: 'current.ts', size: 12, mtime: 34 },
    ])
  })

  test('已交付会话不把后来 Local 的无关脏文件误认为本会话产物', async () => {
    let currentChangesRead = false
    const service = new SessionProjectArtifactService({
      inspectTarget: async () => ({
        ...workingTarget,
        delivery: { state: 'delivered', iteration: 1, commitOid: 'commit', deliveredAt: 100 },
      }),
      readPersistedChangedFiles: () => ['docs/delivered.html'],
      readCheckpointPaths: () => [],
      getCurrentChanges: async () => {
        currentChangesRead = true
        return currentChanges
      },
      resolveExistingFiles: async () => new Map([['docs/delivered.html', '/local/docs/delivered.html']]),
      statFile: () => ({ isFile: () => true, size: 20, mtimeMs: 50 }),
    })

    expect(await service.list('session-1')).toEqual([
      { relativePath: 'docs/delivered.html', name: 'delivered.html', size: 20, mtime: 50 },
    ])
    expect(currentChangesRead).toBeFalse()
  })
})

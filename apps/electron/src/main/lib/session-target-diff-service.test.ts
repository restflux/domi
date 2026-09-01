import { describe, expect, test } from 'bun:test'
import type { UnstagedChangesResult } from '@domi/shared'
import { SessionTargetDiffService } from './session-target-diff-service.ts'

const managedRoot = 'D:/managed/repo/apps/project'
const managedGitRoot = 'D:/managed/repo'
const rawChanges: UnstagedChangesResult = {
  isGitRepo: true,
  files: [
    {
      filePath: 'apps/project/src/file.ts',
      status: 'modified',
      additions: 2,
      deletions: 1,
      source: 'none',
      gitRoot: managedGitRoot,
    },
    {
      filePath: 'apps/sibling/private.ts',
      status: 'modified',
      additions: 1,
      deletions: 0,
      source: 'none',
      gitRoot: managedGitRoot,
    },
  ],
  untrackedFiles: [{ filePath: 'apps/project/isolated-only.txt', gitRoot: managedGitRoot }],
  gitRootNames: ['repo'],
}

function createService(
  calls: string[],
  targetRoot = managedRoot,
  changes = rawChanges,
) {
  return new SessionTargetDiffService({
    access: {
      isActivePiSession: (options): options is NonNullable<typeof options> & { sessionId: string } => (
        options?.sessionId === 'session-a'
      ),
      resolveActiveDiffTarget: async () => ({
        root: targetRoot,
        gitRoot: managedGitRoot,
        baseOid: 'base-oid',
        kind: 'isolated',
      }),
      authorizeDiffRequest: async (input: { sessionId?: string; relativePath: string }) => {
        if (input.relativePath !== 'src/file.ts') return null
        return {
          dirPath: managedRoot,
          filePath: 'apps/project/src/file.ts',
          gitRoot: managedGitRoot,
          baseOid: 'base-oid',
        }
      },
    },
    getUnstagedChanges: async () => changes,
    getWorktreeChanges: async (root, baseOid) => {
      calls.push(`isolated-changes:${root}:${baseOid}`)
      return changes
    },
    getFileDiff: async (root, filePath, gitRoot) => {
      calls.push(`file-diff:${root}:${filePath}:${gitRoot}`)
      return 'diff'
    },
    getUntrackedContent: async () => '',
    revertFile: async (root, filePath, gitRoot, sourceRef) => {
      calls.push(`revert:${root}:${filePath}:${gitRoot}:${sourceRef}`)
    },
    getDiffContents: async () => null,
    listWorktrees: async () => [],
  })
}

describe('SessionTargetDiffService active Pi routing seam', () => {
  test('Given a project is a repository subdirectory When changes are projected Then paths are session-relative and no managed path is returned', async () => {
    const calls: string[] = []
    const listed = await createService(calls).getChanges('session-a')

    expect(listed).toEqual({
      handled: true,
      value: {
        isGitRepo: true,
        files: [{
          filePath: 'src/file.ts',
          status: 'modified',
          additions: 2,
          deletions: 1,
          source: 'none',
          gitRoot: 'session-target',
        }],
        untrackedFiles: [{ filePath: 'isolated-only.txt', gitRoot: 'session-target' }],
        gitRootNames: ['Session Target'],
      },
    })
    expect(JSON.stringify(listed)).not.toContain('D:/managed')
    expect(calls).toEqual([`isolated-changes:${managedRoot}:base-oid`])
  })

  test('Given Git already scopes a repository-subdirectory project When changes are projected Then valid project-relative entries remain visible', async () => {
    const scopedChanges: UnstagedChangesResult = {
      isGitRepo: true,
      files: [{
        filePath: 'src/file.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        source: 'none',
        gitRoot: managedRoot,
      }],
      untrackedFiles: [{ filePath: 'isolated-only.txt', gitRoot: managedRoot }],
      gitRootNames: ['project'],
    }

    await expect(createService([], managedRoot, scopedChanges).getChanges('session-a')).resolves.toEqual({
      handled: true,
      value: {
        isGitRepo: true,
        files: [{ ...scopedChanges.files[0]!, gitRoot: 'session-target' }],
        untrackedFiles: [{ filePath: 'isolated-only.txt', gitRoot: 'session-target' }],
        gitRootNames: ['Session Target'],
      },
    })
  })

  test('Given Git unexpectedly reports absolute or parent paths When the repository root is projected Then unsafe entries are omitted', async () => {
    const unsafeChanges: UnstagedChangesResult = {
      isGitRepo: true,
      files: [
        { ...rawChanges.files[0]!, filePath: 'D:/managed/repo/private.ts' },
        { ...rawChanges.files[0]!, filePath: '../private.ts' },
      ],
      untrackedFiles: [{ filePath: '../private.txt', gitRoot: managedGitRoot }],
      gitRootNames: ['repo'],
    }

    await expect(createService([], managedGitRoot, unsafeChanges).getChanges('session-a')).resolves.toEqual({
      handled: true,
      value: {
        isGitRepo: true,
        files: [],
        untrackedFiles: [],
        gitRootNames: ['Session Target'],
      },
    })
  })

  test('Given active Pi requests one file When preview and Diff load Then renderer supplies only sessionId plus a relative path', async () => {
    const calls: string[] = []
    const service = createService(calls)
    const request = { sessionId: 'session-a', relativePath: 'src/file.ts' }
    const diffed = await service.getFileDiff(request)
    await service.revertFile(request)

    expect(diffed).toEqual({ handled: true, value: 'diff' })
    expect(calls).toEqual([
      `file-diff:${managedRoot}:apps/project/src/file.ts:${managedGitRoot}`,
      `revert:${managedRoot}:apps/project/src/file.ts:${managedGitRoot}:base-oid`,
    ])
  })

  test('Given active Pi receives an absolute or sibling path When a file operation is requested Then it fails closed', async () => {
    const service = createService([])

    await expect(service.getFileDiff({ sessionId: 'session-a', relativePath: 'D:/managed/repo/apps/sibling/private.ts' }))
      .resolves.toEqual({ handled: true, value: '' })
    await expect(service.getFileDiff({ sessionId: 'session-a', relativePath: '../sibling/private.ts' }))
      .resolves.toEqual({ handled: true, value: '' })
  })
})

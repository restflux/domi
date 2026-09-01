import { describe, expect, test } from 'bun:test'
import type {
  GitWorkspaceSnapshot,
  GitWorkspaceLogEntry,
  GitWorkspaceHistoryResult,
  GitWorkspaceBranchesResult,
  GitWorkspaceOperationResult,
  GitWorkspaceCommitFilesResult,
  GitWorkspaceCommitFileEntry,
} from '@domi/shared'

function createLogEntry(): GitWorkspaceLogEntry {
  return {
    oid: 'a'.repeat(40),
    shortOid: 'aaaaaaa',
    subject: 'fix: x',
    authorName: 'n',
    authorEmail: 'e',
    authorDate: 1_700_000_000,
    refs: [{ kind: 'tag', name: 'v1.0.0' }],
    parents: ['b'.repeat(40)],
    onRemote: false,
  }
}

function createSnapshot(): GitWorkspaceSnapshot {
  return {
    target: { kind: 'isolated' },
    scannedAt: 1_786_000_000_000,
    repositories: [{
      repositoryId: 'repo-a1b2c3d4',
      displayName: 'domi',
      branch: null,
      detached: true,
      unborn: false,
      headOid: 'abcdef0123456789',
      upstream: null,
      ahead: 0,
      behind: 0,
      conflicts: [{
        relativePath: 'src/conflict.ts',
        layer: 'conflict',
        status: 'conflicted',
        additions: 0,
        deletions: 0,
      }],
      staged: [{
        relativePath: 'src/staged.ts',
        layer: 'staged',
        status: 'modified',
        additions: 2,
        deletions: 1,
      }],
      unstaged: [{
        relativePath: 'src/unstaged.ts',
        layer: 'unstaged',
        status: 'modified',
        additions: 1,
        deletions: 0,
      }],
      untracked: [{
        relativePath: 'src/new.ts',
        layer: 'untracked',
        status: 'untracked',
        additions: 0,
        deletions: 0,
      }],
      stateToken: 'state-token',
    }],
  }
}

describe('Git Workspace shared contract', () => {
  test('exposes read-only status without physical checkout paths', () => {
    const value = createSnapshot()
    const serialized = JSON.stringify(value)

    expect(value.repositories[0]?.detached).toBeTrue()
    expect(value.repositories[0]?.conflicts).toHaveLength(1)
    expect(value.repositories[0]?.staged).toHaveLength(1)
    expect(value.repositories[0]?.unstaged).toHaveLength(1)
    expect(value.repositories[0]?.untracked).toHaveLength(1)
    expect(serialized).not.toContain('D:/')
    expect(serialized).not.toContain('C:/')
    expect(serialized).not.toContain('/Users/')
    expect(serialized).not.toContain('gitRoot')
    expect(serialized).not.toContain('worktreePath')
    expect(serialized).not.toContain('cwd')
  })

  test('GitWorkspaceLogEntry 契约字段齐全且无物理路径', () => {
    const entry = createLogEntry()
    const serialized = JSON.stringify(entry)
    expect(entry.oid).toHaveLength(40)
    expect(entry.shortOid).toBe('aaaaaaa')
    expect(entry.refs[0]).toEqual({ kind: 'tag', name: 'v1.0.0' })
    expect(serialized).not.toContain('/')
  })

  test('历史/分支/写操作结果契约字段齐全', () => {
    const history: GitWorkspaceHistoryResult = { entries: [createLogEntry()] }
    const branches: GitWorkspaceBranchesResult = { current: 'main', local: ['main', 'dev'] }
    const operation: GitWorkspaceOperationResult = { ok: true }
    const failed: GitWorkspaceOperationResult = { ok: false, message: 'git 命令失败' }
    const files: GitWorkspaceCommitFilesResult = {
      files: [{ relativePath: 'src/a.ts', status: 'modified' } satisfies GitWorkspaceCommitFileEntry],
    }
    expect(history.entries[0]!.subject).toBe('fix: x')
    expect(branches.local).toContain('dev')
    expect(operation.ok).toBeTrue()
    expect(failed.message).toBe('git 命令失败')
    expect(files.files[0]!.status).toBe('modified')
  })
})

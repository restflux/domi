import { describe, expect, test } from 'bun:test'
import type { GitRepositorySnapshot, GitWorkspaceLogEntry, GitWorkspaceSnapshot } from '@domi/shared'
import { buildGitWorkspaceView, getGitChangeStatusMarker, getRepositoryBranchLabel, gitWorkspaceDiscardablePaths, gitWorkspaceTotalChanges, relativeTime, tagBadges } from './git-workspace-view-model.ts'

function logEntry(overrides: Partial<GitWorkspaceLogEntry> = {}): GitWorkspaceLogEntry {
  return {
    oid: 'a'.repeat(40),
    shortOid: 'aaaaaaa',
    subject: 'fix: x',
    authorName: 'n',
    authorEmail: 'e',
    authorDate: 1_700_000_000,
    refs: [],
    parents: [],
    onRemote: false,
    ...overrides,
  }
}

function repository(overrides: Partial<GitRepositorySnapshot> = {}): GitRepositorySnapshot {
  return {
    repositoryId: 'repo-1234567890abcdef',
    displayName: 'domi',
    branch: 'workbench',
    detached: false,
    unborn: false,
    headOid: 'abcdef0123456789',
    upstream: 'origin/workbench',
    ahead: 2,
    behind: 1,
    conflicts: [{ relativePath: 'src/conflict.ts', layer: 'conflict', status: 'conflicted', additions: 0, deletions: 0 }],
    staged: [{ relativePath: 'src/shared.ts', layer: 'staged', status: 'modified', additions: 2, deletions: 1 }],
    unstaged: [
      { relativePath: 'src/shared.ts', layer: 'unstaged', status: 'modified', additions: 1, deletions: 0 },
      { relativePath: 'src/other.ts', layer: 'unstaged', status: 'modified', additions: 1, deletions: 1 },
    ],
    untracked: [{ relativePath: 'docs/new.md', layer: 'untracked', status: 'untracked', additions: 0, deletions: 0 }],
    stateToken: 'token',
    ...overrides,
  }
}

function snapshot(repositories = [repository()]): GitWorkspaceSnapshot {
  return { target: { kind: 'local' }, repositories, scannedAt: 1 }
}

describe('git workspace view model', () => {
  test('uses the actual Git file status for row markers instead of the staging layer', () => {
    expect(getGitChangeStatusMarker('added')).toBe('A')
    expect(getGitChangeStatusMarker('modified')).toBe('M')
    expect(getGitChangeStatusMarker('deleted')).toBe('D')
    expect(getGitChangeStatusMarker('renamed')).toBe('R')
    expect(getGitChangeStatusMarker('copied')).toBe('C')
    expect(getGitChangeStatusMarker('type-changed')).toBe('T')
    expect(getGitChangeStatusMarker('conflicted')).toBe('!')
    expect(getGitChangeStatusMarker('untracked')).toBe('U')
  })

  test('bulk discard targets every unstaged tracked path without deleting untracked files', () => {
    expect(gitWorkspaceDiscardablePaths(repository({
      unstaged: [
        { relativePath: 'src/modified.ts', layer: 'unstaged', status: 'modified', additions: 1, deletions: 1 },
        { relativePath: 'src/deleted.ts', layer: 'unstaged', status: 'deleted', additions: 0, deletions: 5 },
      ],
      untracked: [
        { relativePath: 'src/new.ts', layer: 'untracked', status: 'untracked', additions: 0, deletions: 0 },
      ],
    }))).toEqual(['src/modified.ts', 'src/deleted.ts'])
  })

  test('orders groups and preserves staged/unstaged identity for one path', () => {
    const view = buildGitWorkspaceView(snapshot())

    expect(view[0]?.groups.map((group) => group.layer)).toEqual(['conflict', 'staged', 'unstaged', 'untracked'])
    expect(view[0]?.groups[1]?.files[0]?.relativePath).toBe('src/shared.ts')
    expect(view[0]?.groups[2]?.files[0]?.relativePath).toBe('src/shared.ts')
    expect(view[0]?.totalChanges).toBe(5)
    expect(gitWorkspaceTotalChanges(snapshot())).toBe(5)
  })

  test('filters only file rows while retaining repository status', () => {
    const view = buildGitWorkspaceView(snapshot(), 'other')

    expect(view).toHaveLength(1)
    expect(view[0]?.branchLabel).toBe('workbench')
    expect(view[0]?.groups).toEqual([expect.objectContaining({
      layer: 'unstaged',
      files: [expect.objectContaining({ relativePath: 'src/other.ts' })],
    })])
  })

  test('labels detached and unborn repositories explicitly', () => {
    expect(getRepositoryBranchLabel(repository({ branch: null, detached: true }))).toBe('Detached HEAD')
    expect(getRepositoryBranchLabel(repository({ unborn: true, headOid: null }))).toBe('workbench · 尚无提交')
  })

  test('keeps multiple repositories as separate sections', () => {
    const view = buildGitWorkspaceView(snapshot([
      repository({ displayName: 'root' }),
      repository({ repositoryId: 'repo-fedcba0987654321', displayName: 'packages/nested', staged: [], conflicts: [], untracked: [] }),
    ]))

    expect(view.map((item) => item.repository.displayName)).toEqual(['root', 'packages/nested'])
  })
})

describe('git history view helpers', () => {
  test('tagBadges 只取 log 中的 tag refs', () => {
    expect(tagBadges(logEntry({ refs: [
      { kind: 'tag', name: 'v1.0.0' },
      { kind: 'branch', name: 'main' },
      { kind: 'remote', name: 'origin/main' },
    ] }))).toEqual(['v1.0.0'])
    expect(tagBadges(logEntry({ refs: [] }))).toEqual([])
  })

  test('relativeTime 分层输出', () => {
    const now = Date.now()
    const base = Math.floor(now / 1000)
    expect(relativeTime(base, now)).toBe('刚刚')
    expect(relativeTime(base - 120, now)).toBe('2 分钟前')
    expect(relativeTime(base - 7200, now)).toBe('2 小时前')
    expect(relativeTime(base - 172800, now)).toBe('2 天前')
  })
})

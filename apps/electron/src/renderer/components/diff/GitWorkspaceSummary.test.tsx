import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { GitRepositorySnapshot, GitWorkspaceBranchesResult } from '@domi/shared'
import { GitWorkspaceSummary, requestBranchesWhenOpen } from './GitWorkspaceSummary.tsx'

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
    conflicts: [],
    staged: [],
    unstaged: [],
    untracked: [],
    stateToken: 'token',
    ...overrides,
  }
}

describe('GitWorkspaceSummary', () => {
  test('renders branch, short HEAD and tracking status without physical paths', () => {
    const html = renderToStaticMarkup(
      <GitWorkspaceSummary repository={repository()} loading={false} onRefresh={() => undefined} />,
    )

    expect(html).toContain('workbench')
    expect(html).toContain('abcdef0')
    expect(html).toContain('origin/workbench')
    expect(html).toContain('↑2 ↓1')
    expect(html).not.toContain('D:/')
  })

  test('labels detached and unborn states', () => {
    expect(renderToStaticMarkup(
      <GitWorkspaceSummary repository={repository({ branch: null, detached: true })} loading={false} onRefresh={() => undefined} />,
    )).toContain('Detached HEAD')
    expect(renderToStaticMarkup(
      <GitWorkspaceSummary repository={repository({ unborn: true, headOid: null })} loading={false} onRefresh={() => undefined} />,
    )).toContain('尚无提交')
  })

  test('loads local branches when the branch popover opens', async () => {
    const expected: GitWorkspaceBranchesResult = {
      current: 'workbench',
      local: ['main', 'workbench'],
    }
    let calls = 0

    const result = await requestBranchesWhenOpen(true, async () => {
      calls += 1
      return expected
    })

    expect(calls).toBe(1)
    expect(result).toEqual(expected)
  })

  test('does not load local branches when the branch popover closes', async () => {
    let calls = 0

    const result = await requestBranchesWhenOpen(false, async () => {
      calls += 1
      return { current: null, local: [] }
    })

    expect(calls).toBe(0)
    expect(result).toBeNull()
  })
})

describe('GitWorkspaceSummary sync button', () => {
  test('renders a single sync button instead of separate pull/push buttons', () => {
    const html = renderToStaticMarkup(
      <GitWorkspaceSummary
        repository={repository()}
        loading={false}
        onRefresh={() => undefined}
        onSync={() => undefined}
      />,
    )

    expect(html).toContain('aria-label="同步"')
    expect(html).not.toContain('aria-label="拉取"')
    expect(html).not.toContain('aria-label="推送"')
    expect(html).toContain('同步（拉取后推送）')
    expect(html).toContain('aria-label="刷新 Git 状态"')
    expect(html).toContain('获取远端更新并刷新状态')
  })
})

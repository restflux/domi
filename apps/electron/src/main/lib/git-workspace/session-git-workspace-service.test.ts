import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionGitWorkspaceService } from './session-git-workspace-service.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function createRepo(): string {
  const fixture = mkdtempSync(join(tmpdir(), 'domi-session-git-'))
  roots.push(fixture)
  const repo = join(fixture, 'repo')
  git(fixture, 'init', '-b', 'main', repo)
  git(repo, 'config', 'user.email', 'tests@example.com')
  git(repo, 'config', 'user.name', 'Domi Tests')
  writeFileSync(join(repo, 'file.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'base')
  return repo
}

describe('SessionGitWorkspaceService', () => {
  test('resolves the authoritative target and hides its physical path', async () => {
    const repo = createRepo()
    writeFileSync(join(repo, 'file.txt'), 'changed\n')
    const service = new SessionGitWorkspaceService({
      resolveTarget: async (sessionId) => {
        expect(sessionId).toBe('session-a')
        return { root: repo, kind: 'isolated' }
      },
    })

    const snapshot = await service.inspect({ sessionId: 'session-a', force: true })

    expect(snapshot.target.kind).toBe('isolated')
    expect(snapshot.repositories[0]?.unstaged[0]?.relativePath).toBe('file.txt')
    expect(JSON.stringify(snapshot)).not.toContain(repo.replace(/\\/g, '/'))
  })

  test('returns a stable empty snapshot for a non-Git target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'domi-session-non-git-'))
    roots.push(root)
    const service = new SessionGitWorkspaceService({
      resolveTarget: async () => ({ root, kind: 'local' }),
    })

    await expect(service.inspect({ sessionId: 'session-a' })).resolves.toEqual({
      target: { kind: 'local' },
      repositories: [],
      scannedAt: expect.any(Number),
    })
  })

  test('fails closed for invalid targets, repository ids and traversal paths', async () => {
    const repo = createRepo()
    writeFileSync(join(repo, 'file.txt'), 'changed\n')
    const service = new SessionGitWorkspaceService({
      resolveTarget: async (sessionId) => {
        if (sessionId === 'missing') throw new Error('missing')
        return { root: repo, kind: 'local' }
      },
    })
    const snapshot = await service.inspect({ sessionId: 'session-a', force: true })
    const repositoryId = snapshot.repositories[0]!.repositoryId

    await expect(service.getDiff({
      sessionId: 'session-a',
      repositoryId: 'repo-forged',
      relativePath: 'file.txt',
      layer: 'unstaged',
    })).resolves.toBeNull()
    await expect(service.getDiff({
      sessionId: 'session-a',
      repositoryId,
      relativePath: '../private.txt',
      layer: 'unstaged',
    })).resolves.toBeNull()
    await expect(service.inspect({ sessionId: 'missing' })).resolves.toMatchObject({
      repositories: [],
      error: { code: 'target-unavailable' },
    })
  })

  test('checkout 需要恢复时返回可操作的恢复提示', async () => {
    const service = new SessionGitWorkspaceService({
      resolveTarget: async () => {
        throw Object.assign(new Error('Isolated Checkout 需要恢复后才能租用'), { code: 'recovery_required' })
      },
    })

    const snapshot = await service.inspect({ sessionId: 'session-a' })

    expect(snapshot.error?.message).toContain('需要恢复')
  })

  test('returns layer-specific contents only for a currently listed change', async () => {
    const repo = createRepo()
    writeFileSync(join(repo, 'file.txt'), 'staged\n')
    git(repo, 'add', 'file.txt')
    writeFileSync(join(repo, 'file.txt'), 'staged\nworking\n')
    const service = new SessionGitWorkspaceService({
      resolveTarget: async () => ({ root: repo, kind: 'local' }),
    })
    const snapshot = await service.inspect({ sessionId: 'session-a', force: true })
    const repositoryId = snapshot.repositories[0]!.repositoryId

    await expect(service.getDiff({ sessionId: 'session-a', repositoryId, relativePath: 'file.txt', layer: 'staged' }))
      .resolves.toEqual({ oldContent: 'base\n', newContent: 'staged\n' })
    await expect(service.getDiff({ sessionId: 'session-a', repositoryId, relativePath: 'file.txt', layer: 'unstaged' }))
      .resolves.toEqual({ oldContent: 'staged\n', newContent: 'staged\nworking\n' })
    git(repo, 'restore', '--worktree', 'file.txt')
    await expect(service.getDiff({ sessionId: 'session-a', repositoryId, relativePath: 'file.txt', layer: 'unstaged' }))
      .resolves.toBeNull()
  }, 30_000)
})

describe('SessionGitWorkspaceService read-only extensions', () => {
  function serviceFor(repo: string): SessionGitWorkspaceService {
    return new SessionGitWorkspaceService({
      resolveTarget: async () => ({ root: repo, kind: 'local' }),
    })
  }

  test('getHistory 返回条目且校验 repositoryId', async () => {
    const repo = createRepo()
    writeFileSync(join(repo, 'file.txt'), 'changed\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'second')
    const service = serviceFor(repo)
    const snapshot = await service.inspect({ sessionId: 'session-a', force: true })
    const repositoryId = snapshot.repositories[0]!.repositoryId

    const result = await service.getHistory({ sessionId: 'session-a', repositoryId, limit: 10 })
    expect(result.entries.map((e) => e.subject)).toEqual(['second', 'base'])

    await expect(service.getHistory({ sessionId: 'session-a', repositoryId: 'repo-forged', limit: 10 }))
      .resolves.toEqual({ entries: [] })
  }, 30_000)

  test('discard unstaged changes preserves staged contents', async () => {
    const repo = createRepo()
    writeFileSync(join(repo, 'file.txt'), 'staged\n')
    git(repo, 'add', 'file.txt')
    writeFileSync(join(repo, 'file.txt'), 'unstaged\n')
    const service = serviceFor(repo)
    const snapshot = await service.inspect({ sessionId: 'session-a', force: true })
    const repository = snapshot.repositories[0]!
    const repositoryId = repository.repositoryId
    expect(repository.staged.map((change) => change.relativePath)).toContain('file.txt')
    expect(repository.unstaged.map((change) => change.relativePath)).toContain('file.txt')

    await expect(service.discard({
      sessionId: 'session-a',
      repositoryId,
      relativePaths: ['file.txt'],
      layer: 'unstaged',
    })).resolves.toEqual({ ok: true })

    expect(readFileSync(join(repo, 'file.txt'), 'utf8').trim()).toBe('staged')
    expect(git(repo, 'diff', '--name-only')).toBe('')
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('file.txt')
  }, 30_000)

  test('getBranches 返回本地分支与当前分支', async () => {
    const repo = createRepo()
    git(repo, 'branch', 'feature')
    const service = serviceFor(repo)
    const snapshot = await service.inspect({ sessionId: 'session-a', force: true })
    const repositoryId = snapshot.repositories[0]!.repositoryId

    const result = await service.getBranches({ sessionId: 'session-a', repositoryId })
    expect(result.current).toBe('main')
    expect(result.local.sort()).toEqual(['feature', 'main'])
  }, 30_000)

  test('getCommitFiles/getCommitDiff 校验 oid 与路径', async () => {
    const repo = createRepo()
    writeFileSync(join(repo, 'file.txt'), 'changed\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'second')
    const oid = git(repo, 'rev-parse', 'HEAD')
    const service = serviceFor(repo)
    const snapshot = await service.inspect({ sessionId: 'session-a', force: true })
    const repositoryId = snapshot.repositories[0]!.repositoryId

    const files = await service.getCommitFiles({ sessionId: 'session-a', repositoryId, oid })
    expect(files.files).toEqual([{ relativePath: 'file.txt', status: 'modified' }])

    const diff = await service.getCommitDiff({ sessionId: 'session-a', repositoryId, oid, relativePath: 'file.txt' })
    expect(diff).toEqual({ oldContent: 'base\n', newContent: 'changed\n' })

    await expect(service.getCommitDiff({ sessionId: 'session-a', repositoryId, oid, relativePath: '../evil' }))
      .resolves.toBeNull()
    await expect(service.getCommitFiles({ sessionId: 'session-a', repositoryId, oid: 'not-a-hex' }))
      .resolves.toEqual({ files: [] })
  }, 30_000)
})

describe('SessionGitWorkspaceService write operations', () => {
  test('stage/discard/commit/checkout/pullPush 透传 module 并刷新', async () => {
    const repo = createRepo()
    writeFileSync(join(repo, 'file.txt'), 'changed\n')
    const service = new SessionGitWorkspaceService({
      resolveTarget: async () => ({ root: repo, kind: 'local' }),
    })
    const snapshot = await service.inspect({ sessionId: 'session-a', force: true })
    const repositoryId = snapshot.repositories[0]!.repositoryId

    const staged = await service.stage({ sessionId: 'session-a', repositoryId, relativePaths: ['file.txt'], action: 'stage' })
    expect(staged.ok).toBeTrue()
    const afterStage = await service.inspect({ sessionId: 'session-a', force: true })
    expect(afterStage.repositories[0]!.staged.map((c) => c.relativePath)).toContain('file.txt')

    const committed = await service.commit({ sessionId: 'session-a', repositoryId, message: 'commit via service', push: false })
    expect(committed.ok).toBeTrue()
    const afterCommit = await service.inspect({ sessionId: 'session-a', force: true })
    expect(afterCommit.repositories[0]!.staged).toHaveLength(0)
    expect(afterCommit.repositories[0]!.unstaged).toHaveLength(0)

    const history = await service.getHistory({ sessionId: 'session-a', repositoryId, limit: 5 })
    expect(history.entries[0]!.subject).toBe('commit via service')
  }, 30_000)

  test('非法请求安全失败（坏仓库/坏路径/坏消息/坏分支）', async () => {
    const repo = createRepo()
    const service = new SessionGitWorkspaceService({
      resolveTarget: async () => ({ root: repo, kind: 'local' }),
    })
    const snapshot = await service.inspect({ sessionId: 'session-a', force: true })
    const repositoryId = snapshot.repositories[0]!.repositoryId

    await expect(service.stage({ sessionId: 'session-a', repositoryId: 'repo-forged', relativePaths: [], action: 'stage' }))
      .resolves.toEqual(expect.objectContaining({ ok: false }))
    await expect(service.stage({ sessionId: 'session-a', repositoryId, relativePaths: ['../evil'], action: 'stage' }))
      .resolves.toEqual(expect.objectContaining({ ok: false }))
    await expect(service.commit({ sessionId: 'session-a', repositoryId, message: '  ', push: false }))
      .resolves.toEqual(expect.objectContaining({ ok: false }))
    await expect(service.checkout({ sessionId: 'session-a', repositoryId, branch: '../evil' }))
      .resolves.toEqual(expect.objectContaining({ ok: false }))
    await expect(service.pullPush({ sessionId: 'session-a', repositoryId, action: 'rebase' as never }))
      .resolves.toEqual(expect.objectContaining({ ok: false }))
    await expect(service.discard({ sessionId: 'session-a', repositoryId, relativePaths: [], layer: 'unstaged' }))
      .resolves.toEqual(expect.objectContaining({ ok: false }))
  }, 30_000)
})

import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitWorkspaceModule } from './git-workspace-module.ts'
import { runGitCommand } from './git-command-runner.ts'

const roots: string[] = []

afterEach(() => {
  delete process.env.GIT_TRACE
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function createRepo(name = 'repo'): string {
  const fixture = mkdtempSync(join(tmpdir(), 'domi-git-workspace-'))
  roots.push(fixture)
  const repo = join(fixture, name)
  git(fixture, 'init', '-b', 'main', repo)
  git(repo, 'config', 'user.email', 'tests@example.com')
  git(repo, 'config', 'user.name', 'Domi Tests')
  return repo
}

function commitFile(repo: string, path: string, content: string, message = 'base'): void {
  const absolute = join(repo, path)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content)
  git(repo, 'add', path)
  git(repo, 'commit', '-m', message)
}

describe('GitWorkspaceModule status inspection', () => {
  test('splits staged, unstaged and untracked while keeping one file in both layers', async () => {
    const repo = createRepo()
    commitFile(repo, 'src/file.ts', 'base\n')
    writeFileSync(join(repo, 'src/file.ts'), 'staged\n')
    git(repo, 'add', 'src/file.ts')
    writeFileSync(join(repo, 'src/file.ts'), 'staged\nworking\n')
    writeFileSync(join(repo, '新文件.md'), 'new\n')

    const snapshot = await new GitWorkspaceModule().inspect(repo, 'local', true)
    const repository = snapshot.repositories[0]!

    expect(repository.branch).toBe('main')
    expect(repository.detached).toBeFalse()
    expect(repository.staged.map((file) => file.relativePath)).toEqual(['src/file.ts'])
    expect(repository.unstaged.map((file) => file.relativePath)).toEqual(['src/file.ts'])
    expect(repository.untracked.map((file) => file.relativePath)).toEqual(['新文件.md'])
    expect(repository.staged[0]).toMatchObject({ additions: 1, deletions: 1 })
    expect(repository.unstaged[0]).toMatchObject({ additions: 1, deletions: 0 })
    expect(JSON.stringify(snapshot)).not.toContain(repo.replace(/\\/g, '/'))
  }, 30_000)

  test('reports conflict records separately', async () => {
    const repo = createRepo()
    commitFile(repo, 'conflict.txt', 'base\n')
    git(repo, 'switch', '-c', 'feature')
    writeFileSync(join(repo, 'conflict.txt'), 'feature\n')
    git(repo, 'commit', '-am', 'feature')
    git(repo, 'switch', 'main')
    writeFileSync(join(repo, 'conflict.txt'), 'main\n')
    git(repo, 'commit', '-am', 'main')
    try { git(repo, 'merge', 'feature') } catch { /* expected conflict */ }

    const repository = (await new GitWorkspaceModule().inspect(repo, 'local', true)).repositories[0]!

    expect(repository.conflicts).toEqual([expect.objectContaining({
      relativePath: 'conflict.txt',
      layer: 'conflict',
      status: 'conflicted',
    })])
    expect(repository.staged).toEqual([])
    expect(repository.unstaged).toEqual([])
  }, 30_000)

  test('supports unborn and detached repositories', async () => {
    const unborn = createRepo('unborn')
    const unbornRepository = (await new GitWorkspaceModule().inspect(unborn, 'local', true)).repositories[0]!
    expect(unbornRepository.unborn).toBeTrue()
    expect(unbornRepository.headOid).toBeNull()
    expect(unbornRepository.branch).toBe('main')

    const detached = createRepo('detached')
    commitFile(detached, 'file.txt', 'base\n')
    git(detached, 'switch', '--detach', 'HEAD')
    const detachedRepository = (await new GitWorkspaceModule().inspect(detached, 'isolated', true)).repositories[0]!
    expect(detachedRepository.detached).toBeTrue()
    expect(detachedRepository.branch).toBeNull()
    expect(detachedRepository.headOid).toHaveLength(40)
  }, 30_000)

  test('reads ahead and behind only from local tracking refs without fetching', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'domi-git-tracking-'))
    roots.push(fixture)
    const remote = join(fixture, 'remote.git')
    const repo = join(fixture, 'repo')
    const other = join(fixture, 'other')
    git(fixture, 'init', '--bare', remote)
    git(fixture, 'clone', remote, repo)
    git(repo, 'config', 'user.email', 'tests@example.com')
    git(repo, 'config', 'user.name', 'Domi Tests')
    git(repo, 'switch', '-c', 'main')
    commitFile(repo, 'base.txt', 'base\n')
    git(repo, 'push', '-u', 'origin', 'main')
    git(fixture, 'clone', remote, other)
    git(other, 'config', 'user.email', 'tests@example.com')
    git(other, 'config', 'user.name', 'Domi Tests')
    git(other, 'switch', 'main')
    commitFile(other, 'remote.txt', 'remote\n', 'remote')
    git(other, 'push')
    commitFile(repo, 'local.txt', 'local\n', 'local')
    git(repo, 'fetch', 'origin')
    const tracePath = join(fixture, 'trace.log')
    process.env.GIT_TRACE = tracePath

    const repository = (await new GitWorkspaceModule().inspect(repo, 'local', true)).repositories[0]!
    const trace = existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : ''

    expect(repository.upstream).toBe('origin/main')
    expect(repository.ahead).toBe(1)
    expect(repository.behind).toBe(1)
    expect(trace).not.toContain(' fetch ')
  }, 30_000)

  test('projects a repository subdirectory and nested repositories to target-relative paths', async () => {
    const repo = createRepo()
    const project = join(repo, 'packages', 'app')
    mkdirSync(project, { recursive: true })
    commitFile(repo, 'packages/app/project.txt', 'base\n')
    commitFile(repo, 'outside.txt', 'base\n', 'outside')
    writeFileSync(join(project, 'project.txt'), 'changed\n')
    writeFileSync(join(repo, 'outside.txt'), 'changed outside\n')

    const nested = join(project, 'vendor', 'nested')
    mkdirSync(join(project, 'vendor'), { recursive: true })
    git(join(project, 'vendor'), 'init', '-b', 'main', nested)
    git(nested, 'config', 'user.email', 'tests@example.com')
    git(nested, 'config', 'user.name', 'Domi Tests')
    commitFile(nested, 'nested.txt', 'base\n')
    writeFileSync(join(nested, 'nested.txt'), 'changed\n')

    const snapshot = await new GitWorkspaceModule().inspect(project, 'local', true)

    expect(snapshot.repositories).toHaveLength(2)
    expect(snapshot.repositories.flatMap((entry) => entry.unstaged.map((file) => file.relativePath)).sort())
      .toEqual(['project.txt', 'vendor/nested/nested.txt'])
    expect(JSON.stringify(snapshot)).not.toContain('outside.txt')
  }, 30_000)

  test('returns a stable path-free error when Git status fails', async () => {
    const repo = createRepo()
    const module = new GitWorkspaceModule({
      findRoots: async () => [repo],
      runGit: async () => ({ ok: false, stdout: '', stderr: `private ${repo}`, exitCode: 1, timedOut: false }),
    })

    const snapshot = await module.inspect(repo, 'local', true)

    expect(snapshot).toMatchObject({
      repositories: [],
      error: { code: 'scan-failed', message: '无法读取 Git 工作区状态，请稍后重试。' },
    })
    expect(JSON.stringify(snapshot)).not.toContain(repo.replace(/\\/g, '/'))
  })

  test('supports linked worktrees and deduplicates concurrent scans for the same target', async () => {
    const repo = createRepo()
    commitFile(repo, 'file.txt', 'base\n')
    const linked = join(join(repo, '..'), 'linked')
    git(repo, 'worktree', 'add', '--detach', linked, 'HEAD')
    writeFileSync(join(linked, 'file.txt'), 'changed\n')
    let statusCalls = 0
    const module = new GitWorkspaceModule({
      runGit: async (args, cwd, options) => {
        if (args[0] === 'status') statusCalls += 1
        return runGitCommand(args, cwd, options)
      },
    })

    const [first, second] = await Promise.all([
      module.inspect(linked, 'isolated', true),
      module.inspect(linked, 'isolated', true),
    ])

    expect(first).toEqual(second)
    expect(first.repositories[0]?.unstaged.map((file) => file.relativePath)).toEqual(['file.txt'])
    expect(statusCalls).toBe(1)
  }, 30_000)
})

describe('GitWorkspaceModule layer contents', () => {
  test('returns HEAD-to-index, index-to-worktree and empty-to-untracked contents', async () => {
    const repo = createRepo()
    commitFile(repo, 'file.txt', 'base\n')
    writeFileSync(join(repo, 'file.txt'), 'staged\n')
    git(repo, 'add', 'file.txt')
    writeFileSync(join(repo, 'file.txt'), 'staged\nworking\n')
    writeFileSync(join(repo, 'new.txt'), 'untracked\n')
    const module = new GitWorkspaceModule()
    const repository = (await module.inspect(repo, 'local', true)).repositories[0]!

    await expect(module.getDiffContents(repo, 'local', {
      repositoryId: repository.repositoryId,
      relativePath: 'file.txt',
      layer: 'staged',
    })).resolves.toEqual({ oldContent: 'base\n', newContent: 'staged\n' })
    await expect(module.getDiffContents(repo, 'local', {
      repositoryId: repository.repositoryId,
      relativePath: 'file.txt',
      layer: 'unstaged',
    })).resolves.toEqual({ oldContent: 'staged\n', newContent: 'staged\nworking\n' })
    await expect(module.getDiffContents(repo, 'local', {
      repositoryId: repository.repositoryId,
      relativePath: 'new.txt',
      layer: 'untracked',
    })).resolves.toEqual({ oldContent: '', newContent: 'untracked\n' })
    await expect(module.getDiffContents(repo, 'local', {
      repositoryId: 'forged',
      relativePath: '../private.txt',
      layer: 'unstaged',
    })).resolves.toBeNull()
  }, 30_000)
})

describe('GitWorkspaceModule history inspection', () => {
  test('inspectHistory 返回 log 条目并解析 tag 徽章', async () => {
    const repo = createRepo()
    commitFile(repo, 'a.txt', '1\n', 'first')
    git(repo, 'tag', 'v1.0.0')
    commitFile(repo, 'a.txt', '2\n', 'second')

    const module = new GitWorkspaceModule()
    const snapshot = await module.inspect(repo, 'local', true)
    const repositoryId = snapshot.repositories[0]!.repositoryId
    const result = await module.inspectHistory(repo, { repositoryId, limit: 30 })

    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]!.subject).toBe('second')
    // 当前 HEAD 提交的 %D 输出 `HEAD -> main`
    expect(result.entries[0]!.refs).toEqual([{ kind: 'head', name: 'main' }])
    expect(result.entries[1]!.subject).toBe('first')
    expect(result.entries[1]!.refs).toEqual([{ kind: 'tag', name: 'v1.0.0' }])
    expect(result.entries[0]!.authorName).toBe('Domi Tests')
    expect(result.entries[0]!.parents).toHaveLength(1)
    expect(result.entries[0]!.authorDate).toBeGreaterThan(0)
  }, 30_000)

  test('inspectHistory 尊重 limit 且未知仓库返回空', async () => {
    const repo = createRepo()
    commitFile(repo, 'a.txt', '1\n', 'one')
    commitFile(repo, 'a.txt', '2\n', 'two')
    commitFile(repo, 'a.txt', '3\n', 'three')

    const module = new GitWorkspaceModule()
    const result = await module.inspectHistory(repo, { repositoryId: 'repo-unknown', limit: 2 })
    expect(result.entries).toEqual([])

    const snapshot = await module.inspect(repo, 'local', true)
    const repositoryId = snapshot.repositories[0]!.repositoryId
    const limited = await module.inspectHistory(repo, { repositoryId, limit: 2 })
    expect(limited.entries).toHaveLength(2)
    expect(limited.entries[0]!.subject).toBe('three')
  }, 30_000)
})

describe('GitWorkspaceModule branches and commit contents', () => {
  test('listLocalBranches 标记当前分支', async () => {
    const repo = createRepo()
    commitFile(repo, 'a.txt', '1\n', 'init')
    git(repo, 'branch', 'feature/x')

    const module = new GitWorkspaceModule()
    const snapshot = await module.inspect(repo, 'local', true)
    const repositoryId = snapshot.repositories[0]!.repositoryId
    const branches = await module.listLocalBranches(repo, repositoryId)

    expect(branches.current).toBe('main')
    expect(branches.local.sort()).toEqual(['feature/x', 'main'])
  }, 30_000)

  test('getCommitFiles 与 getCommitDiffContents 返回提交内容', async () => {
    const repo = createRepo()
    commitFile(repo, 'a.txt', '1\n', 'init')
    const firstOid = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(join(repo, 'a.txt'), '2\n')
    writeFileSync(join(repo, 'b.txt'), 'new\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'second')
    const secondOid = git(repo, 'rev-parse', 'HEAD')

    const module = new GitWorkspaceModule()
    const snapshot = await module.inspect(repo, 'local', true)
    const repositoryId = snapshot.repositories[0]!.repositoryId

    const files = await module.getCommitFiles(repo, { repositoryId, oid: secondOid })
    expect(files.files.map((f) => f.relativePath).sort()).toEqual(['a.txt', 'b.txt'])

    const diff = await module.getCommitDiffContents(repo, { repositoryId, oid: secondOid, relativePath: 'a.txt' })
    expect(diff).not.toBeNull()
    expect(diff!.oldContent).toBe('1\n')
    expect(diff!.newContent).toBe('2\n')

    // 根提交：无父，oldContent 为空
    const rootDiff = await module.getCommitDiffContents(repo, { repositoryId, oid: firstOid, relativePath: 'a.txt' })
    expect(rootDiff).not.toBeNull()
    expect(rootDiff!.oldContent).toBe('')
    expect(rootDiff!.newContent).toBe('1\n')

    // 未知仓库/非法路径安全失败
    const badRepo = await module.getCommitFiles(repo, { repositoryId: 'repo-nope', oid: secondOid })
    expect(badRepo.files).toEqual([])
    const traversal = await module.getCommitDiffContents(repo, { repositoryId, oid: secondOid, relativePath: '../evil' })
    expect(traversal).toBeNull()
  }, 30_000)
})

describe('GitWorkspaceModule write operations', () => {
  test('stage/unstage 移动文件并失效缓存', async () => {
    const repo = createRepo()
    commitFile(repo, 'a.txt', '1\n', 'init')
    writeFileSync(join(repo, 'a.txt'), '2\n')

    const module = new GitWorkspaceModule()
    const snapshot = await module.inspect(repo, 'local', true)
    const repositoryId = snapshot.repositories[0]!.repositoryId

    const staged = await module.stageFiles(repo, { repositoryId, relativePaths: ['a.txt'], action: 'stage' })
    expect(staged.ok).toBeTrue()
    const afterStage = (await module.inspect(repo, 'local', true)).repositories[0]!
    expect(afterStage.staged.map((c) => c.relativePath)).toContain('a.txt')
    expect(afterStage.unstaged).toHaveLength(0)

    const unstaged = await module.stageFiles(repo, { repositoryId, relativePaths: ['a.txt'], action: 'unstage' })
    expect(unstaged.ok).toBeTrue()
    const afterUnstage = (await module.inspect(repo, 'local', true)).repositories[0]!
    expect(afterUnstage.staged).toHaveLength(0)
    expect(afterUnstage.unstaged.map((c) => c.relativePath)).toContain('a.txt')
  }, 30_000)

  test('stage 全部（空路径列表）与未知仓库安全失败', async () => {
    const repo = createRepo()
    commitFile(repo, 'a.txt', '1\n', 'init')
    writeFileSync(join(repo, 'a.txt'), '2\n')
    writeFileSync(join(repo, 'new.txt'), 'x\n')

    const module = new GitWorkspaceModule()
    const snapshot = await module.inspect(repo, 'local', true)
    const repositoryId = snapshot.repositories[0]!.repositoryId

    const all = await module.stageFiles(repo, { repositoryId, relativePaths: [], action: 'stage' })
    expect(all.ok).toBeTrue()
    const after = (await module.inspect(repo, 'local', true)).repositories[0]!
    expect(after.staged.map((c) => c.relativePath).sort()).toEqual(['a.txt', 'new.txt'])

    const unknown = await module.stageFiles(repo, { repositoryId: 'repo-nope', relativePaths: [], action: 'stage' })
    expect(unknown.ok).toBeFalse()
    expect(unknown.message).toBeTruthy()
  }, 30_000)

  test('discard 还原已追踪改动并删除未追踪文件', async () => {
    const repo = createRepo()
    commitFile(repo, 'a.txt', '1\n', 'init')
    writeFileSync(join(repo, 'a.txt'), '2\n')
    writeFileSync(join(repo, 'draft.txt'), 'draft\n')

    const module = new GitWorkspaceModule()
    const snapshot = await module.inspect(repo, 'local', true)
    const repositoryId = snapshot.repositories[0]!.repositoryId

    const discardedTracked = await module.discardFiles(repo, {
      repositoryId,
      relativePaths: ['a.txt'],
      layer: 'unstaged',
    })
    const discardedUntracked = await module.discardFiles(repo, {
      repositoryId,
      relativePaths: ['draft.txt'],
      layer: 'untracked',
    })
    expect(discardedTracked.ok).toBeTrue()
    expect(discardedUntracked.ok).toBeTrue()
    // autocrlf 可能把 LF 检出为 CRLF，用 trim 断言内容
    expect(readFileSync(join(repo, 'a.txt'), 'utf8').trim()).toBe('1')
    expect(existsSync(join(repo, 'draft.txt'))).toBeFalse()
  }, 30_000)
})

describe('GitWorkspaceModule commit and sync operations', () => {
  test('commit 经 stdin 创建提交并支持 push', async () => {
    const repo = createRepo()
    commitFile(repo, 'a.txt', '1\n', 'init')
    const remote = mkdtempSync(join(tmpdir(), 'domi-remote-'))
    roots.push(remote)
    git(remote, 'init', '-q', '--bare', '-b', 'main')
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-u', 'origin', 'main')

    writeFileSync(join(repo, 'a.txt'), '2\n')
    git(repo, 'add', '.')
    const module = new GitWorkspaceModule()
    const snapshot = await module.inspect(repo, 'local', true)
    const repositoryId = snapshot.repositories[0]!.repositoryId

    const committed = await module.commitFiles(repo, {
      repositoryId, message: 'msg with body\n\nsecond line', push: true,
    })
    expect(committed.ok).toBeTrue()

    const history = await module.inspectHistory(repo, { repositoryId, limit: 3 })
    expect(history.entries[0]!.subject).toBe('msg with body')
    const remoteLog = git(remote, 'log', '--oneline', '-1')
    expect(remoteLog).toContain('msg with body')
  }, 60_000)

  test('空消息提交失败且不产生提交', async () => {
    const repo = createRepo()
    commitFile(repo, 'a.txt', '1\n', 'init')
    writeFileSync(join(repo, 'a.txt'), '2\n')
    git(repo, 'add', '.')
    const module = new GitWorkspaceModule()
    const snapshot = await module.inspect(repo, 'local', true)
    const repositoryId = snapshot.repositories[0]!.repositoryId

    const result = await module.commitFiles(repo, { repositoryId, message: '   ', push: false })
    expect(result.ok).toBeFalse()
    expect(result.message).toBeTruthy()
    const history = await module.inspectHistory(repo, { repositoryId, limit: 5 })
    expect(history.entries).toHaveLength(1)
  }, 30_000)

  test('checkout 切换本地分支，pull --ff-only 与 push 同步', async () => {
    const repo = createRepo()
    commitFile(repo, 'a.txt', '1\n', 'init')
    const remote = mkdtempSync(join(tmpdir(), 'domi-remote2-'))
    roots.push(remote)
    git(remote, 'init', '-q', '--bare', '-b', 'main')
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-u', 'origin', 'main')
    git(repo, 'checkout', '-b', 'dev')

    const module = new GitWorkspaceModule()
    const snapshot = await module.inspect(repo, 'local', true)
    const repositoryId = snapshot.repositories[0]!.repositoryId

    const switched = await module.checkoutBranch(repo, { repositoryId, branch: 'main' })
    expect(switched.ok).toBeTrue()
    expect((await module.inspect(repo, 'local', true)).repositories[0]!.branch).toBe('main')

    const pushed = await module.pullPush(repo, { repositoryId, action: 'push' })
    expect(pushed.ok).toBeTrue()
    const pulled = await module.pullPush(repo, { repositoryId, action: 'pull' })
    expect(pulled.ok).toBeTrue()

    const bad = await module.checkoutBranch(repo, { repositoryId, branch: 'no-such-branch' })
    expect(bad.ok).toBeFalse()
    expect(bad.message).toBeTruthy()
  }, 60_000)
})

describe('GitWorkspaceModule multi-device remote synchronization', () => {
  test('fetch 刷新 tracking ref，历史显示尚未 pull 的其他设备提交', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'domi-git-multi-device-'))
    roots.push(fixture)
    const remote = join(fixture, 'remote.git')
    const first = join(fixture, 'first')
    const second = join(fixture, 'second')
    git(fixture, 'init', '--bare', '-b', 'main', remote)
    git(fixture, 'clone', remote, first)
    git(first, 'config', 'user.email', 'tests@example.com')
    git(first, 'config', 'user.name', 'Domi Tests')
    git(first, 'switch', '-c', 'main')
    commitFile(first, 'base.txt', 'base\n', 'base')
    git(first, 'push', '-u', 'origin', 'main')
    git(fixture, 'clone', remote, second)
    git(second, 'config', 'user.email', 'tests@example.com')
    git(second, 'config', 'user.name', 'Other Device')

    const module = new GitWorkspaceModule()
    const initial = (await module.inspect(first, 'local', true)).repositories[0]!
    expect(initial.behind).toBe(0)

    commitFile(second, 'remote.txt', 'from second device\n', 'from another device')
    git(second, 'push')

    const fetched = await module.pullPush(first, {
      repositoryId: initial.repositoryId,
      action: 'fetch',
    })
    expect(fetched.ok).toBeTrue()
    const refreshed = (await module.inspect(first, 'local', true)).repositories[0]!
    expect(refreshed.behind).toBe(1)

    const history = await module.inspectHistory(first, {
      repositoryId: refreshed.repositoryId,
      limit: 10,
    })
    expect(history.entries.map((entry) => entry.subject)).toContain('from another device')
    expect(history.entries.find((entry) => entry.subject === 'from another device')?.onRemote).toBeTrue()
    expect(git(first, 'log', '-1', '--format=%s')).toBe('base')
  }, 60_000)

  test('fetch 失败也失效旧快照缓存，避免继续展示过期远端状态', async () => {
    const repo = createRepo()
    commitFile(repo, 'a.txt', '1\n', 'init')
    git(repo, 'remote', 'add', 'origin', 'https://example.invalid/repo.git')
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    git(repo, 'branch', '--set-upstream-to=origin/main', 'main')
    let statusCalls = 0
    const module = new GitWorkspaceModule({
      runGit: async (args, cwd, options) => {
        if (args[0] === 'status') statusCalls += 1
        if (args[0] === 'fetch') {
          return { ok: false, stdout: '', stderr: 'fatal: fetch failed', exitCode: 1, timedOut: false }
        }
        return runGitCommand(args, cwd, options)
      },
    })
    const snapshot = await module.inspect(repo, 'local', true)
    const repositoryId = snapshot.repositories[0]!.repositoryId
    expect(statusCalls).toBe(1)

    const fetched = await module.pullPush(repo, { repositoryId, action: 'fetch' })
    expect(fetched.ok).toBeFalse()
    await module.inspect(repo, 'local', false)
    expect(statusCalls).toBe(3)
  }, 30_000)

  test('sync 不依赖旧 ahead/behind，其他设备推送后仍会 pull --ff-only 再 push', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'domi-git-sync-stale-'))
    roots.push(fixture)
    const remote = join(fixture, 'remote.git')
    const first = join(fixture, 'first')
    const second = join(fixture, 'second')
    git(fixture, 'init', '--bare', '-b', 'main', remote)
    git(fixture, 'clone', remote, first)
    git(first, 'config', 'user.email', 'tests@example.com')
    git(first, 'config', 'user.name', 'Domi Tests')
    git(first, 'switch', '-c', 'main')
    commitFile(first, 'base.txt', 'base\n', 'base')
    git(first, 'push', '-u', 'origin', 'main')
    git(fixture, 'clone', remote, second)
    git(second, 'config', 'user.email', 'tests@example.com')
    git(second, 'config', 'user.name', 'Other Device')

    const module = new GitWorkspaceModule()
    const stale = (await module.inspect(first, 'local', true)).repositories[0]!
    expect(stale.ahead).toBe(0)
    expect(stale.behind).toBe(0)

    commitFile(second, 'remote.txt', 'new version\n', 'new version from second device')
    git(second, 'push')
    const remoteHead = git(second, 'rev-parse', 'HEAD')

    const synced = await module.pullPush(first, {
      repositoryId: stale.repositoryId,
      action: 'sync',
    })
    expect(synced.ok).toBeTrue()
    expect(git(first, 'rev-parse', 'HEAD')).toBe(remoteHead)
    const refreshed = (await module.inspect(first, 'local', true)).repositories[0]!
    expect(refreshed.ahead).toBe(0)
    expect(refreshed.behind).toBe(0)
  }, 60_000)
})

describe('GitWorkspaceModule history remote/body enrichment', () => {
  test('已推送提交 onRemote=true，未推送提交 onRemote=false', async () => {
    const repo = createRepo()
    commitFile(repo, 'a.txt', '1\n', 'init')
    const remote = mkdtempSync(join(tmpdir(), 'domi-remote-onremote-'))
    roots.push(remote)
    git(remote, 'init', '-q', '--bare', '-b', 'main')
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    commitFile(repo, 'a.txt', '2\n', 'local-only')

    const module = new GitWorkspaceModule()
    const snapshot = await module.inspect(repo, 'local', true)
    const repositoryId = snapshot.repositories[0]!.repositoryId
    const result = await module.inspectHistory(repo, { repositoryId, limit: 10 })

    expect(result.entries.map((e) => e.onRemote)).toEqual([false, true])
  }, 30_000)

  test('无 upstream 仓库全部 onRemote=false', async () => {
    const repo = createRepo()
    commitFile(repo, 'a.txt', '1\n', 'init')
    commitFile(repo, 'a.txt', '2\n', 'second')

    const module = new GitWorkspaceModule()
    const snapshot = await module.inspect(repo, 'local', true)
    const repositoryId = snapshot.repositories[0]!.repositoryId
    const result = await module.inspectHistory(repo, { repositoryId, limit: 10 })

    expect(result.entries.map((e) => e.onRemote)).toEqual([false, false])
    expect(snapshot.repositories[0]!.upstream).toBeNull()
  }, 30_000)

  test('多行 body 解析且无 body 时省略字段', async () => {
    const repo = createRepo()
    commitFile(repo, 'a.txt', '1\n', 'subject only')
    writeFileSync(join(repo, 'a.txt'), '2\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'subject line', '-m', 'body line one\n\nbody line two')

    const module = new GitWorkspaceModule()
    const snapshot = await module.inspect(repo, 'local', true)
    const repositoryId = snapshot.repositories[0]!.repositoryId
    const result = await module.inspectHistory(repo, { repositoryId, limit: 10 })

    expect(result.entries[0]!.subject).toBe('subject line')
    expect(result.entries[0]!.body).toBe('body line one\n\nbody line two')
    expect(result.entries[1]!.subject).toBe('subject only')
    expect(result.entries[1]!.body).toBeUndefined()
  }, 30_000)
})

describe('GitWorkspaceModule pull fallback on divergence', () => {
  /** 在 bare remote 上制造一个远程新提交（经独立 clone 工作副本 push）。 */
  function pushRemoteCommit(repo: string, remote: string, path: string, content: string, message: string): string {
    const workCopy = mkdtempSync(join(tmpdir(), 'domi-clone-'))
    roots.push(workCopy)
    git(repo, 'clone', '-q', remote, workCopy)
    git(workCopy, 'config', 'user.email', 'tests@example.com')
    git(workCopy, 'config', 'user.name', 'Domi Tests')
    writeFileSync(join(workCopy, path), content)
    git(workCopy, 'add', '.')
    git(workCopy, 'commit', '-m', message)
    git(workCopy, 'push', '-q')
    return git(workCopy, 'rev-parse', 'HEAD')
  }

  test('分叉但改动不重叠时自动合并，不报冲突', async () => {
    const repo = createRepo()
    commitFile(repo, 'a.txt', '1\n', 'base')
    const remote = mkdtempSync(join(tmpdir(), 'domi-remote-diverged-'))
    roots.push(remote)
    git(remote, 'init', '-q', '--bare', '-b', 'main')
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main')

    pushRemoteCommit(repo, remote, 'b.txt', 'remote\n', 'remote change')
    commitFile(repo, 'c.txt', 'local\n', 'local change')

    const module = new GitWorkspaceModule()
    const snapshot = await module.inspect(repo, 'local', true)
    const repositoryId = snapshot.repositories[0]!.repositoryId

    const result = await module.pullPush(repo, { repositoryId, action: 'pull' })
    expect(result.ok).toBeTrue()

    const history = await module.inspectHistory(repo, { repositoryId, limit: 5 })
    expect(history.entries[0]!.parents).toHaveLength(2)
    expect(existsSync(join(repo, 'b.txt'))).toBeTrue()
    expect(existsSync(join(repo, 'c.txt'))).toBeTrue()
  }, 60_000)

  test('同文件真冲突时返回 CONFLICT 且快照出现冲突层', async () => {
    const repo = createRepo()
    commitFile(repo, 'a.txt', 'base\n', 'base')
    const remote = mkdtempSync(join(tmpdir(), 'domi-remote-conflict-'))
    roots.push(remote)
    git(remote, 'init', '-q', '--bare', '-b', 'main')
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main')

    pushRemoteCommit(repo, remote, 'a.txt', 'remote version\n', 'remote edit')
    writeFileSync(join(repo, 'a.txt'), 'local version\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'local edit')

    const module = new GitWorkspaceModule()
    const snapshot = await module.inspect(repo, 'local', true)
    const repositoryId = snapshot.repositories[0]!.repositoryId

    const result = await module.pullPush(repo, { repositoryId, action: 'pull' })
    expect(result.ok).toBeFalse()
    expect(result.message).toContain('CONFLICT')

    const after = await module.inspect(repo, 'local', true)
    expect(after.repositories[0]!.conflicts.map((c) => c.relativePath)).toContain('a.txt')
  }, 60_000)

  test('可快进时不产生合并提交（回归）', async () => {
    const repo = createRepo()
    commitFile(repo, 'a.txt', '1\n', 'base')
    const remote = mkdtempSync(join(tmpdir(), 'domi-remote-ff-'))
    roots.push(remote)
    git(remote, 'init', '-q', '--bare', '-b', 'main')
    git(repo, 'remote', 'add', 'origin', remote)
    git(repo, 'push', '-q', '-u', 'origin', 'main')

    pushRemoteCommit(repo, remote, 'b.txt', 'remote\n', 'remote only')

    const module = new GitWorkspaceModule()
    const snapshot = await module.inspect(repo, 'local', true)
    const repositoryId = snapshot.repositories[0]!.repositoryId

    const result = await module.pullPush(repo, { repositoryId, action: 'pull' })
    expect(result.ok).toBeTrue()

    const history = await module.inspectHistory(repo, { repositoryId, limit: 5 })
    expect(history.entries[0]!.parents).toHaveLength(1)
  }, 60_000)
})

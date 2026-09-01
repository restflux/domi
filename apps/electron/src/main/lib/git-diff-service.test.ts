import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getUnstagedChanges, getWorktreeChanges, normalizeGitRoot, revertFile } from './git-diff-service.ts'

const roots: string[] = []

afterEach(() => {
  delete process.env.GIT_TRACE
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

describe('getWorktreeChanges Git semantics', () => {
  test('Given Session Base advanced on another branch When Isolated still has the earlier tree Then the rollback is shown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'domi-worktree-tree-diff-'))
    roots.push(root)
    const repo = join(root, 'repo')
    git(root, 'init', '-b', 'main', repo)
    git(repo, 'config', 'user.email', 'tests@example.com')
    git(repo, 'config', 'user.name', 'Domi Tests')
    writeFileSync(join(repo, 'file.txt'), 'earlier\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'earlier')
    git(repo, 'branch', 'isolated')
    writeFileSync(join(repo, 'file.txt'), 'session base\n')
    git(repo, 'commit', '-am', 'advance base')
    const baseOid = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'switch', 'isolated')

    const result = await getWorktreeChanges(repo, baseOid)

    expect(result.files.map((file) => file.filePath)).toEqual(['file.txt'])
    expect(result.files[0]).toMatchObject({ status: 'modified', additions: 1, deletions: 1 })
  }, 30_000)

  test('Given HEAD changed a file but the final working tree restores Session Base When Changes are read and reverted Then net Diff stays empty and Revert uses Session Base', async () => {
    const root = mkdtempSync(join(tmpdir(), 'domi-worktree-net-diff-'))
    roots.push(root)
    const repo = join(root, 'repo')
    git(root, 'init', '-b', 'main', repo)
    git(repo, 'config', 'user.email', 'tests@example.com')
    git(repo, 'config', 'user.name', 'Domi Tests')
    writeFileSync(join(repo, 'file.txt'), 'base\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'base')
    const baseOid = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(join(repo, 'file.txt'), 'committed change\n')
    git(repo, 'commit', '-am', 'change')
    writeFileSync(join(repo, 'file.txt'), 'base\n')

    expect((await getWorktreeChanges(repo, baseOid)).files).toEqual([])

    writeFileSync(join(repo, 'file.txt'), 'another final state\n')
    expect((await getWorktreeChanges(repo, baseOid)).files.map((file) => file.filePath)).toEqual(['file.txt'])
    await revertFile(repo, 'file.txt', undefined, baseOid)

    expect(readFileSync(join(repo, 'file.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('base\n')
    expect((await getWorktreeChanges(repo, baseOid)).files).toEqual([])
  }, 30_000)

  test('Given the project is a repository subdirectory When Changes are read Then only project files use project-relative paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'domi-worktree-subdir-'))
    roots.push(root)
    const repo = join(root, 'repo')
    const project = join(repo, 'packages', 'app')
    git(root, 'init', '-b', 'main', repo)
    git(repo, 'config', 'user.email', 'tests@example.com')
    git(repo, 'config', 'user.name', 'Domi Tests')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'staged.txt'), 'base staged\n')
    writeFileSync(join(project, 'unstaged.txt'), 'base unstaged\n')
    writeFileSync(join(repo, 'outside.txt'), 'base outside\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'base')
    const baseOid = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(join(project, 'staged.txt'), 'changed staged\n')
    git(repo, 'add', 'packages/app/staged.txt')
    writeFileSync(join(project, 'unstaged.txt'), 'changed unstaged\n')
    writeFileSync(join(project, 'untracked.txt'), 'new\n')
    writeFileSync(join(repo, 'outside.txt'), 'changed outside\n')

    const isolated = await getWorktreeChanges(project, baseOid)
    const local = await getUnstagedChanges(project)

    for (const result of [isolated, local]) {
      expect(result.files.map((file) => file.filePath).sort()).toEqual(['staged.txt', 'unstaged.txt'])
      expect(result.untrackedFiles.map((file) => file.filePath)).toEqual(['untracked.txt'])
      expect(result.files.every((file) => normalizeGitRoot(file.gitRoot) === normalizeGitRoot(project))).toBeTrue()
      expect(result.untrackedFiles.every((file) => normalizeGitRoot(file.gitRoot) === normalizeGitRoot(project))).toBeTrue()
    }
  }, 30_000)
})

describe('getWorktreeChanges network policy', () => {
  test('Given an active Session Base OID When changes are read Then diff inspection does not fetch origin implicitly', async () => {
    const root = mkdtempSync(join(tmpdir(), 'domi-worktree-diff-'))
    roots.push(root)
    const repo = join(root, 'repo')
    const tracePath = join(root, 'git-trace.log')
    git(root, 'init', '-b', 'main', repo)
    git(repo, 'config', 'user.email', 'tests@example.com')
    git(repo, 'config', 'user.name', 'Domi Tests')
    writeFileSync(join(repo, 'file.txt'), 'base\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'base')
    const baseOid = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(join(repo, 'file.txt'), 'changed\n')
    process.env.GIT_TRACE = tracePath

    const result = await getWorktreeChanges(repo, baseOid)

    const trace = existsSync(tracePath) ? readFileSync(tracePath, 'utf8') : ''
    expect(result.isGitRepo).toBeTrue()
    expect(trace).not.toContain('fetch origin main')
  }, 15_000)
})

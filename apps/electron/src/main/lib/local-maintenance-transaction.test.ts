import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { SessionTargetView } from '@domi/shared'
import { LocalMaintenanceTransactionService } from './local-maintenance-transaction.ts'

const roots: string[] = []
const services: LocalMaintenanceTransactionService[] = []

afterEach(() => {
  for (const service of services.splice(0)) service.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function harness(): {
  root: string
  localRoot: string
  worktreeRoot: string
  service: LocalMaintenanceTransactionService
  target: SessionTargetView
} {
  const root = mkdtempSync(join(tmpdir(), 'domi-local-maintenance-'))
  roots.push(root)
  const localRoot = join(root, 'local')
  const worktreeRoot = join(root, 'worktree')
  git(root, 'init', '-b', 'main', localRoot)
  git(localRoot, 'config', 'user.email', 'test@example.com')
  git(localRoot, 'config', 'user.name', 'Domi Test')
  writeFileSync(join(localRoot, 'tracked.txt'), 'base\n')
  git(localRoot, 'add', 'tracked.txt')
  git(localRoot, 'commit', '-m', 'base')
  git(localRoot, 'worktree', 'add', '--detach', worktreeRoot, 'HEAD')
  const oid = git(worktreeRoot, 'rev-parse', 'HEAD')
  const target: SessionTargetView = {
    project: { id: 'project-1', name: 'Project' },
    checkout: { id: 'checkout-1', kind: 'isolated', label: 'Worktree', phase: 'ready' },
    source: { ref: 'refs/heads/main', oid },
    current: { branch: null, oid },
    ownership: 'owner', dirty: false, revision: 4,
    delivery: { state: 'working', iteration: 1 },
  }
  const service = new LocalMaintenanceTransactionService({
    inspect: async () => target,
    lease: async () => ({ cwd: worktreeRoot, localRoot }),
  }, join(root, 'transactions.json'), join(root, 'artifacts'))
  services.push(service)
  return { root, localRoot, worktreeRoot, service, target }
}

describe('LocalMaintenanceTransactionService', () => {
  test('Given dirty Local When transaction starts Then recoverable artifacts are captured without stash/reset and bounded tools can commit then sync a clean Worktree', async () => {
    const { localRoot, worktreeRoot, service } = harness()
    writeFileSync(join(localRoot, 'tracked.txt'), 'dirty before transaction\n')
    writeFileSync(join(localRoot, 'untracked.txt'), 'preexisting untracked\n')
    const statusBefore = git(localRoot, 'status', '--porcelain=v1')
    const headBefore = git(localRoot, 'rev-parse', 'HEAD')

    const snapshot = await service.captureRequestSnapshot('session-1')
    const transaction = await service.start('session-1', 'repair local', snapshot)

    expect(git(localRoot, 'rev-parse', 'HEAD')).toBe(headBefore)
    expect(git(localRoot, 'status', '--porcelain=v1')).toBe(statusBefore)
    expect(existsSync(join(transaction.snapshotDir, 'working-tree.patch'))).toBeTrue()
    expect(existsSync(join(transaction.snapshotDir, 'untracked', 'untracked.txt'))).toBeTrue()

    await service.editFile('session-1', 'tracked.txt', 'dirty before transaction', 'repaired locally')
    await service.writeFile('session-1', 'new-local.txt', 'new\n')
    expect((await service.runCommand('session-1', 'git add -A')).exitCode).toBe(0)
    expect((await service.runCommand('session-1', 'git commit -m "repair local"')).exitCode).toBe(0)
    const localHead = git(localRoot, 'rev-parse', 'HEAD')

    const completed = await service.complete('session-1')
    expect(completed).toMatchObject({ state: 'completed', worktreeSync: 'fast_forwarded_to_local', changedSinceStart: true })
    expect(git(worktreeRoot, 'rev-parse', 'HEAD')).toBe(localHead)
    expect(readFileSync(join(worktreeRoot, 'new-local.txt'), 'utf8').trim()).toBe('new')
  }, 30_000)

  test('Given an active transaction When an already-dirty Local file changes outside managed tools Then content fingerprint pauses before overwriting anything', async () => {
    const { localRoot, service } = harness()
    writeFileSync(join(localRoot, 'tracked.txt'), 'dirty version one\n')
    const snapshot = await service.captureRequestSnapshot('session-1')
    await service.start('session-1', 'repair local', snapshot)
    // Porcelain status remains "M tracked.txt"; only content-aware fingerprint can detect this.
    writeFileSync(join(localRoot, 'tracked.txt'), 'dirty version two with external change\n')

    await expect(service.writeFile('session-1', 'managed.txt', 'must not write\n')).rejects.toThrow('事务外 Local')
    expect(existsSync(join(localRoot, 'managed.txt'))).toBeFalse()
    expect(service.getActive('session-1')).toBeNull()
  })

  test('Given maintenance leaves uncommitted Local changes When completing Then Worktree stays unchanged and a non-blocking follow-up is required', async () => {
    const { localRoot, worktreeRoot, service } = harness()
    const originalWorktreeHead = git(worktreeRoot, 'rev-parse', 'HEAD')
    const snapshot = await service.captureRequestSnapshot('session-1')
    await service.start('session-1', 'repair local', snapshot)
    await service.writeFile('session-1', 'local-only.txt', 'not committed\n')

    const result = await service.complete('session-1')
    expect(result).toMatchObject({ state: 'paused', worktreeSync: 'local_dirty', changedSinceStart: true })
    expect(git(worktreeRoot, 'rev-parse', 'HEAD')).toBe(originalWorktreeHead)
    expect(existsSync(join(localRoot, 'local-only.txt'))).toBeTrue()
    expect(existsSync(join(worktreeRoot, 'local-only.txt'))).toBeFalse()
  }, 30_000)

  test('Given an active transaction When command or path is destructive/outside Local Then host rejects it', async () => {
    const { root, service } = harness()
    const snapshot = await service.captureRequestSnapshot('session-1')
    await service.start('session-1', 'repair local', snapshot)

    await expect(service.runCommand('session-1', 'git reset --hard HEAD')).rejects.toThrow('仅允许')
    await expect(service.runCommand('session-1', 'npm test &')).rejects.toThrow('仅允许')
    await expect(service.writeFile('session-1', join('..', 'outside.txt'), 'no')).rejects.toThrow('项目目录外')
    expect(existsSync(join(root, 'outside.txt'))).toBeFalse()
  }, 30_000)
})

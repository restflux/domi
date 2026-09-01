import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  createNodeSessionCheckoutDependencies,
  getSessionCheckoutGitTimeoutMs,
} from './production-adapters.ts'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

describe('production Session Checkout Git adapter', () => {
  test('Given a dependency-heavy managed Worktree When selecting Git timeout Then removal receives the bounded long timeout only', () => {
    expect(getSessionCheckoutGitTimeoutMs(['worktree', 'remove', '--force', 'D:/managed'])).toBe(5 * 60_000)
    expect(getSessionCheckoutGitTimeoutMs(['worktree', 'add', '--detach', 'D:/managed', 'HEAD'])).toBe(10_000)
    expect(getSessionCheckoutGitTimeoutMs(['status', '--porcelain'])).toBe(10_000)
  })

  test('Given a v2 registry contains optional Worktree checkpoints When reloaded Then old records remain compatible and checkpoint metadata is preserved', () => {
    const root = mkdtempSync(join(tmpdir(), 'domi-checkout-registry-checkpoint-'))
    temporaryRoots.push(root)
    const configDir = join(root, 'config')
    const dependencies = createNodeSessionCheckoutDependencies({
      configDir,
      lookup: {
        getSession: () => undefined,
        getProject: () => undefined,
        isSessionActive: () => false,
        markDelegationCheckoutReleased: () => undefined,
        markInheritedCheckoutReleased: () => undefined,
        getUnboundTargetPolicy: () => 'unselected',
      },
    })
    dependencies.registry.write({
      version: 2,
      revision: 1,
      sessionBindings: {},
      managedCheckouts: {
        'checkout-1': {
          checkoutId: 'checkout-1', projectId: 'project-1', projectName: 'Domi', ownerSessionId: 'session-1',
          localRoot: 'D:/local', managedRoot: 'D:/managed/project', managedGitRoot: 'D:/managed',
          gitCommonDir: 'D:/local/.git', gitDir: 'D:/local/.git/worktrees/managed', baseOid: 'a'.repeat(40),
          sourceRef: 'refs/heads/main', phase: 'ready', delivery: { state: 'working', iteration: 1 }, journal: null,
          previousReview: {
            reviewId: 'review-1', iteration: 1, summary: '完成主要增量',
            changedFiles: ['src/a.ts'], suggestedCommitMessage: 'feat: 完成主要增量',
          },
          checkpoints: [{
            checkpointId: 'checkpoint-1', sequence: 1, reviewId: 'review-1', iteration: 1, createdAt: 1,
            commitOid: 'b'.repeat(40), parentOid: 'a'.repeat(40), summary: '阶段 A', commitMessage: 'feat: A',
            validationStatus: 'passed', changedFiles: ['src/a.ts'],
          }],
          revision: 1,
        },
        'checkout-legacy': {
          checkoutId: 'checkout-legacy', projectId: 'project-1', projectName: 'Domi', ownerSessionId: 'session-2',
          localRoot: 'D:/local', managedRoot: 'D:/legacy/project', managedGitRoot: 'D:/legacy',
          gitCommonDir: 'D:/local/.git', gitDir: 'D:/local/.git/worktrees/legacy', baseOid: 'a'.repeat(40),
          sourceRef: 'refs/heads/main', phase: 'ready', delivery: { state: 'working', iteration: 1 }, journal: null, revision: 1,
        },
      },
    })

    const reloaded = dependencies.registry.read()

    expect(reloaded.managedCheckouts['checkout-1']?.previousReview).toMatchObject({ reviewId: 'review-1', summary: '完成主要增量' })
    expect(reloaded.managedCheckouts['checkout-1']?.checkpoints?.[0]).toMatchObject({ checkpointId: 'checkpoint-1', sequence: 1 })
    expect(reloaded.managedCheckouts['checkout-legacy']?.previousReview).toBeUndefined()
    expect(reloaded.managedCheckouts['checkout-legacy']?.checkpoints).toBeUndefined()
  })

  test('Given repository config installs a core.fsmonitor command When Domi inspects status Then configured code is never executed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'domi-checkout-git-hardening-'))
    temporaryRoots.push(root)
    const repositoryRoot = join(root, 'repository')
    const configDir = join(root, 'config')
    git(root, 'init', repositoryRoot)
    git(repositoryRoot, 'config', 'user.name', 'Domi Test')
    git(repositoryRoot, 'config', 'user.email', 'domi@example.test')
    writeFileSync(join(repositoryRoot, 'tracked.txt'), 'base\n')
    git(repositoryRoot, 'add', 'tracked.txt')
    git(repositoryRoot, 'commit', '-m', 'base')

    const markerPath = join(root, 'fsmonitor-executed.txt')
    const hookPath = join(root, 'fsmonitor-hook.sh')
    writeFileSync(hookPath, `#!/bin/sh\nprintf executed > ${shellQuote(markerPath.replaceAll('\\', '/'))}\nexit 0\n`)
    chmodSync(hookPath, 0o755)
    git(repositoryRoot, 'config', 'core.fsmonitor', hookPath.replaceAll('\\', '/'))

    const dependencies = createNodeSessionCheckoutDependencies({
      configDir,
      lookup: {
        getSession: () => undefined,
        getProject: () => undefined,
        isSessionActive: () => false,
        markDelegationCheckoutReleased: () => undefined,
        markInheritedCheckoutReleased: () => undefined,
        getUnboundTargetPolicy: () => 'unselected',
      },
    })

    await dependencies.git.status(repositoryRoot)

    expect(existsSync(markerPath)).toBeFalse()
  })
})

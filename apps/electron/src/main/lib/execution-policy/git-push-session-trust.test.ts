import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitPushSessionTrustService } from './git-push-session-trust.ts'

const roots: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

function createRepository(): {
  root: string
  remote: string
  context: { sessionId: string; checkoutId: string; repositoryRoot: string; sourceRef: string }
} {
  const root = mkdtempSync(join(tmpdir(), 'domi-push-trust-'))
  roots.push(root)
  const repository = join(root, 'repository')
  const remote = join(root, 'remote.git')
  git(root, 'init', '-b', 'main', repository)
  git(repository, 'config', 'user.name', 'Domi Test')
  git(repository, 'config', 'user.email', 'domi@example.test')
  writeFileSync(join(repository, 'tracked.txt'), 'initial\n')
  git(repository, 'add', 'tracked.txt')
  git(repository, 'commit', '-m', 'initial')
  git(root, 'init', '--bare', remote)
  git(repository, 'remote', 'add', 'origin', 'https://example.com/org/repo.git')
  git(repository, 'config', 'branch.main.remote', 'origin')
  git(repository, 'config', 'branch.main.merge', 'refs/heads/main')
  return {
    root: repository,
    remote,
    context: {
      sessionId: 'session-1',
      checkoutId: 'checkout-1',
      repositoryRoot: repository,
      sourceRef: 'refs/heads/main',
    },
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('GitPushSessionTrustService', () => {
  test('prepares a credential-safe session grant and executes only the host-owned hardened push argv', async () => {
    const { context } = createRepository()
    const calls: Array<{ args: readonly string[]; cwd: string }> = []
    const service = new GitPushSessionTrustService(async (args, cwd) => {
      calls.push({ args, cwd })
      return { ok: true, stdout: '', stderr: '', exitCode: 0, timedOut: false }
    })

    const proposal = await service.prepare(context)
    expect(proposal.view).toMatchObject({
      kind: 'git_push_current_source',
      sessionId: 'session-1',
      remoteName: 'origin',
      targetBranch: 'main',
      recommendedCommand: 'git push --no-verify --no-follow-tags --no-push-option origin HEAD:main',
    })
    expect(proposal.view.remoteDisplay).not.toContain(context.repositoryRoot)

    await service.grant(proposal)
    expect(await service.execute(context)).toMatchObject({ ok: true, grant: proposal.view })
    expect(calls).toEqual([{
      cwd: realpathSync.native(context.repositoryRoot),
      args: [
        'push',
        '--no-verify',
        '--no-follow-tags',
        '--no-push-option',
        'origin',
        'HEAD:refs/heads/main',
      ],
    }])
  })

  test('rejects a pending proposal after policy downgrade or another clear invalidates its generation', async () => {
    const { context } = createRepository()
    const service = new GitPushSessionTrustService()
    const proposal = await service.prepare(context)

    service.clear(context.sessionId)

    await expect(service.grant(proposal)).rejects.toThrow('已失效')
    expect(service.list(context.sessionId)).toEqual([])
  })

  test('revokes the grant when the configured push URL changes', async () => {
    const { context, root } = createRepository()
    const service = new GitPushSessionTrustService()
    const changes: number[] = []
    service.subscribe((event) => changes.push(event.grants.length))
    await service.grant(await service.prepare(context))

    git(root, 'remote', 'set-url', '--push', 'origin', 'https://example.com/other.git')

    expect(await service.reconcile(context)).toBe(false)
    expect(service.list('session-1')).toEqual([])
    expect(changes).toEqual([1, 0])
  })

  test('does not reuse a grant for another checkout, repository, source ref, or session', async () => {
    const { context } = createRepository()
    const service = new GitPushSessionTrustService()
    await service.grant(await service.prepare(context))

    expect(await service.reconcile({ ...context, checkoutId: 'checkout-2' })).toBe(false)
    expect(service.list('session-1')).toEqual([])
    expect(await service.reconcile({ ...context, sessionId: 'session-2' })).toBe(false)

    await service.grant(await service.prepare(context))
    expect(await service.reconcile({ ...context, sourceRef: 'refs/heads/other' })).toBe(false)
    expect(service.list('session-1')).toEqual([])
  })

  test('rejects mirror or custom receive-pack remotes that can widen the external effect', async () => {
    const { context, root } = createRepository()
    const service = new GitPushSessionTrustService()

    git(root, 'config', 'remote.origin.mirror', 'true')
    await expect(service.prepare(context)).rejects.toThrow('mirror/receivepack')
    git(root, 'config', '--unset', 'remote.origin.mirror')
    git(root, 'config', 'remote.origin.receivepack', 'custom-receive-pack')
    await expect(service.prepare(context)).rejects.toThrow('mirror/receivepack')
  })

  test('rejects remotes with multiple push URLs because Git would write to more than the displayed target', async () => {
    const { context, root } = createRepository()
    const service = new GitPushSessionTrustService()

    git(root, 'remote', 'set-url', '--add', '--push', 'origin', 'https://example.com/one.git')
    git(root, 'remote', 'set-url', '--add', '--push', 'origin', 'https://example.com/two.git')

    await expect(service.prepare(context)).rejects.toThrow('唯一 push URL')
  })

  test('rejects local/file remotes and source refs that are not branches', async () => {
    const { context, root, remote } = createRepository()
    const service = new GitPushSessionTrustService()

    git(root, 'remote', 'set-url', 'origin', remote)
    await expect(service.prepare(context)).rejects.toThrow('远程地址')
    git(root, 'remote', 'set-url', 'origin', 'https://user:secret@example.com/org/repo.git')
    const proposal = await service.prepare(context)
    expect(proposal.view.remoteDisplay).toBe('example.com/org/repo')
    expect(JSON.stringify(proposal.view)).not.toContain('secret')
    await expect(service.prepare({ ...context, sourceRef: 'HEAD' })).rejects.toThrow('来源分支')
  })
})

import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionTargetFileAccessService } from './session-target-file-access-service.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'domi-target-access-'))
  roots.push(root)
  const local = join(root, 'local')
  const leased = join(root, 'leased')
  const sibling = join(root, 'sibling')
  const attached = join(root, 'attached')
  const workbench = join(root, 'workbench')
  git(root, 'init', '-b', 'main', local)
  git(local, 'config', 'user.email', 'tests@example.com')
  git(local, 'config', 'user.name', 'Domi Tests')
  writeFileSync(join(local, 'file.txt'), 'base\n')
  git(local, 'add', '.')
  git(local, 'commit', '-m', 'base')
  git(local, 'worktree', 'add', '--detach', leased, 'HEAD')
  git(local, 'worktree', 'add', '--detach', sibling, 'HEAD')
  mkdirSync(attached)
  writeFileSync(join(attached, 'note.txt'), 'note\n')
  mkdirSync(workbench)
  writeFileSync(join(workbench, 'session-note.md'), 'session note\n')
  let unselectedSessionTarget: 'unselected' | 'local' | 'isolated' = 'unselected'
  let resolvedGitRoot: string | null = leased
  let resolveTargetRootCalls = 0

  const service = new SessionTargetFileAccessService({
    getSession: (sessionId) => sessionId === 'session-isolated'
      ? {
          workspaceId: 'workspace-a',
          sessionTarget: { kind: 'isolated' },
          attachedDirectories: [attached],
          attachedFiles: [],
        }
      : sessionId === 'session-unselected'
        ? {
              workspaceId: 'workspace-a',
            sessionTarget: { kind: unselectedSessionTarget },
            attachedDirectories: [attached],
            attachedFiles: [],
          }
        : undefined,
    getWorkspace: (workspaceId) => workspaceId === 'workspace-a' ? { slug: 'workspace-a' } : undefined,
    getProjectRoot: () => local,
    getSessionWorkbenchRoot: (sessionId) => sessionId === 'session-isolated' ? workbench : null,
    getWorkspaceAttachedDirectories: () => [],
    getWorkspaceAttachedFiles: () => [],
    resolveTargetRoot: async () => {
      resolveTargetRootCalls += 1
      return leased
    },
    inspectTarget: async (sessionId) => {
      if (sessionId === 'session-unselected' && unselectedSessionTarget === 'unselected') {
        throw Object.assign(new Error('会话尚未选择 Session Target'), { code: 'target_unselected' })
      }
      return {
        baseOid: 'base-oid',
        kind: unselectedSessionTarget === 'local' ? 'local' : 'isolated',
      }
    },
    resolveGitRoot: async () => resolvedGitRoot,
  })

  return {
    root,
    local,
    leased,
    sibling,
    attached,
    workbench,
    service,
    setUnselectedSessionTarget: (kind: 'unselected' | 'local' | 'isolated') => {
      unselectedSessionTarget = kind
    },
    setResolvedGitRoot: (gitRoot: string | null) => {
      resolvedGitRoot = gitRoot
    },
    getResolveTargetRootCalls: () => resolveTargetRootCalls,
  }
}

describe('SessionTargetFileAccessService IPC authorization seam', () => {
  test('批量解析会话产物时只获取一次 target root，并拒绝越界与不存在路径', async () => {
    const { service, getResolveTargetRootCalls } = createFixture()

    const resolved = await service.resolveExistingRelativeFiles('session-isolated', [
      'file.txt',
      'missing.txt',
      '../sibling/file.txt',
      'file.txt',
    ])

    expect([...resolved.keys()]).toEqual(['file.txt'])
    expect(getResolveTargetRootCalls()).toBe(1)
  })

  test('Given a real sibling worktree sharing one common-dir When session-relative file access uses traversal or an absolute sibling path Then both are rejected', async () => {
    const { sibling, service } = createFixture()

    await expect(service.resolveRelative('session-isolated', '../sibling/file.txt'))
      .resolves.toBeNull()
    await expect(service.resolveRelative('session-isolated', join(sibling, 'file.txt')))
      .resolves.toBeNull()
  })

  test('Given a file exists only in the isolated checkout When session-relative access resolves it Then main receives the lease path without exposing it to the caller', async () => {
    const { leased, service } = createFixture()

    await expect(service.resolveRelative('session-isolated', 'file.txt'))
      .resolves.toBe(join(leased, 'file.txt'))
  })

  test('Given a Session Target directory contains many entries When main projects the listing Then the checkout lease is resolved only once', async () => {
    const { leased, sibling, service, getResolveTargetRootCalls } = createFixture()
    mkdirSync(join(leased, 'src'))
    writeFileSync(join(leased, 'src', 'a.ts'), 'a\n')
    writeFileSync(join(leased, 'src', 'b.ts'), 'b\n')
    symlinkSync(sibling, join(leased, 'src', 'sibling-link'), 'junction')

    const resolved = await service.resolveRelativeDirectory('session-isolated', 'src')
    expect(resolved).toEqual({
      rootPath: leased,
      directoryPath: join(leased, 'src'),
    })
    expect(service.projectRelativePathFromRoot(resolved!.rootPath, join(resolved!.directoryPath, 'a.ts'))).toBe('src/a.ts')
    expect(service.projectRelativePathFromRoot(resolved!.rootPath, join(resolved!.directoryPath, 'b.ts'))).toBe('src/b.ts')
    expect(service.projectRelativePathFromRoot(resolved!.rootPath, join(resolved!.directoryPath, 'sibling-link'))).toBeNull()
    expect(getResolveTargetRootCalls()).toBe(1)
  })

  test('Given a historical bare filename When preview search finds one target file Then only a unique in-lease match is returned', async () => {
    const { leased, service } = createFixture()
    const docsDir = join(leased, 'docs', 'requirements')
    const sourceDir = join(leased, 'src')
    mkdirSync(docsDir, { recursive: true })
    mkdirSync(sourceDir, { recursive: true })
    const target = join(docsDir, '需求文档.md')
    writeFileSync(target, 'requirements\n')

    await expect(service.resolveUniquePreviewBasename('session-isolated', '需求文档.md'))
      .resolves.toBe(target)
    await expect(service.resolveUniquePreviewBasename('session-isolated', '../需求文档.md'))
      .resolves.toBeNull()

    writeFileSync(join(sourceDir, '需求文档.md'), 'duplicate\n')
    await expect(service.resolveUniquePreviewBasename('session-isolated', '需求文档.md'))
      .resolves.toBeNull()
  })

  test('Given an Agent write path When main inspects it Then only the current Session Target is projected and Git capability is reported', async () => {
    const { leased, sibling, service, setResolvedGitRoot } = createFixture()
    mkdirSync(join(leased, 'nested'))
    writeFileSync(join(leased, 'nested', 'edited.md'), 'edited\n')

    await expect(service.inspectTargetFile('session-isolated', 'nested\\edited.md'))
      .resolves.toEqual({
        relativePath: 'nested/edited.md',
        exists: true,
        isGitRepo: true,
      })
    await expect(service.inspectTargetFile('session-isolated', join(leased, 'nested', 'edited.md')))
      .resolves.toEqual({
        relativePath: 'nested/edited.md',
        exists: true,
        isGitRepo: true,
      })
    await expect(service.inspectTargetFile('session-isolated', 'nested/new.md', true))
      .resolves.toEqual({
        relativePath: 'nested/new.md',
        exists: false,
        isGitRepo: true,
      })

    setResolvedGitRoot(null)
    await expect(service.inspectTargetFile('session-isolated', 'nested/edited.md'))
      .resolves.toEqual({
        relativePath: 'nested/edited.md',
        exists: true,
        isGitRepo: false,
      })

    await expect(service.inspectTargetFile('session-isolated', '../sibling/file.txt', true))
      .resolves.toBeNull()
    await expect(service.inspectTargetFile('session-isolated', join(sibling, 'file.txt')))
      .resolves.toBeNull()
    await expect(service.inspectTargetFile('missing-session', 'nested/edited.md'))
      .resolves.toBeNull()
  })

  test('Given a session-scoped file IPC When session context is omitted or replaced by workspace alias Then Local access is rejected', async () => {
    const { local, service } = createFixture()

    await expect(service.authorizeSessionFileRequest(join(local, 'file.txt'), undefined))
      .resolves.toBeFalse()
    await expect(service.authorizeSessionFileRequest(join(local, 'file.txt'), {
      workspaceSlug: 'workspace-a',
    })).resolves.toBeFalse()
  })

  test('Given an attached root and a missing file below a canonical existing parent When session file IPC authorizes paths Then attached access and safe creation remain available', async () => {
    const { attached, leased, service } = createFixture()

    await expect(service.authorizeSessionFileRequest(join(attached, 'note.txt'), {
      sessionId: 'session-isolated',
    })).resolves.toBeTrue()
    await expect(service.authorizeSessionFileRequest(join(leased, 'new-file.md'), {
      sessionId: 'session-isolated',
    }, { allowMissingLeaf: true })).resolves.toBeTrue()
  })

  test('Given a Pi session workbench When the UI selects session files Then only that exact managed root is accepted and authorized', async () => {
    const { sibling, attached, leased, workbench, service } = createFixture()
    const workbenchAccess = {
      sessionId: 'session-isolated',
      pathSpace: 'session-workbench' as const,
    }

    expect(service.usesSessionTargetPathSpace({ sessionId: 'session-isolated' })).toBeTrue()
    expect(service.usesSessionTargetPathSpace(workbenchAccess)).toBeFalse()
    expect(service.resolveSessionWorkbenchRoot('session-isolated', workbench)).toBe(workbench)
    expect(service.resolveSessionWorkbenchRoot('session-isolated', sibling)).toBeNull()
    expect(service.isSessionWorkbenchRoot('session-isolated', workbench)).toBeTrue()
    await expect(service.authorizeFileRequest(join(workbench, 'session-note.md'), workbenchAccess))
      .resolves.toBeTrue()
    await expect(service.authorizeFileRequest(join(leased, 'file.txt'), workbenchAccess))
      .resolves.toBeFalse()
    await expect(service.authorizeFileRequest(join(attached, 'note.txt'), workbenchAccess))
      .resolves.toBeFalse()
    await expect(service.authorizeFileRequest(join(sibling, 'file.txt'), workbenchAccess))
      .resolves.toBeFalse()
  })

  test('Given legacy preview entries persist absolute paths When the preview is read Then only current session roots are resolved', async () => {
    const { local, leased, sibling, attached, workbench, service } = createFixture()
    const access = { sessionId: 'session-isolated' }

    await expect(service.resolveLegacyAbsolutePreviewPath(join(workbench, 'session-note.md'), access))
      .resolves.toBe(join(workbench, 'session-note.md'))
    await expect(service.resolveLegacyAbsolutePreviewPath(join(leased, 'file.txt'), access))
      .resolves.toBe(join(leased, 'file.txt'))
    await expect(service.resolveLegacyAbsolutePreviewPath(join(attached, 'note.txt'), access))
      .resolves.toBe(join(attached, 'note.txt'))
    await expect(service.resolveLegacyAbsolutePreviewPath(join(sibling, 'file.txt'), access))
      .resolves.toBeNull()
    await expect(service.resolveLegacyAbsolutePreviewPath(join(local, 'file.txt'), access))
      .resolves.toBeNull()
    await expect(service.resolveLegacyAbsolutePreviewPath(join(workbench, 'session-note.md'), {
      ...access,
      pathSpace: 'session-target',
    })).resolves.toBeNull()
    await expect(service.resolveLegacyAbsolutePreviewPath('file.txt', access))
      .resolves.toBeNull()
  })

  test('Given a new unbound Pi session When project files browse Local Then only its exact project root is authorized until target binding', async () => {
    const { local, leased, sibling, attached, service, setUnselectedSessionTarget } = createFixture()
    const localProjectAccess = {
      sessionId: 'session-unselected',
      pathSpace: 'session-local-project' as const,
    }

    expect(service.usesSessionTargetPathSpace(localProjectAccess)).toBeFalse()
    await expect(service.resolveSessionLocalProjectRoot('session-unselected', local)).resolves.toBe(local)
    await expect(service.resolveSessionLocalProjectRoot('session-unselected', sibling)).resolves.toBeNull()
    await expect(service.resolveSessionLocalProjectRoot('session-isolated', local)).resolves.toBeNull()
    await expect(service.authorizeFileRequest(join(local, 'file.txt'), localProjectAccess))
      .resolves.toBeTrue()
    await expect(service.resolveLegacyAbsolutePreviewPath(join(local, 'file.txt'), {
      sessionId: 'session-unselected',
    })).resolves.toBe(join(local, 'file.txt'))
    await expect(service.authorizeFileRequest(join(leased, 'file.txt'), localProjectAccess))
      .resolves.toBeFalse()
    await expect(service.authorizeFileRequest(join(sibling, 'file.txt'), localProjectAccess))
      .resolves.toBeFalse()
    await expect(service.authorizeFileRequest(join(attached, 'note.txt'), localProjectAccess))
      .resolves.toBeFalse()
    await expect(service.authorizeFileRequest(join(local, 'file.txt'), {
      sessionId: 'session-isolated',
      pathSpace: 'session-local-project',
    })).resolves.toBeFalse()

    setUnselectedSessionTarget('isolated')
    await expect(service.authorizeFileRequest(join(local, 'file.txt'), localProjectAccess))
      .resolves.toBeFalse()
    await expect(service.resolveSessionLocalProjectRoot('session-unselected', local))
      .resolves.toBeNull()
    await expect(service.resolveLegacyAbsolutePreviewPath(join(local, 'file.txt'), {
      sessionId: 'session-unselected',
    })).resolves.toBeNull()
    await expect(service.authorizeFileRequest(join(leased, 'file.txt'), {
      sessionId: 'session-unselected',
    })).resolves.toBeTrue()
  })

  test('Given a junction inside the lease points at a sibling worktree When a file IPC resolves it Then canonical traversal fails closed', async () => {
    const { leased, sibling, service } = createFixture()
    const junction = join(leased, 'sibling-link')
    symlinkSync(sibling, junction, 'junction')

    await expect(service.authorizeSessionFileRequest(join(junction, 'file.txt'), {
      sessionId: 'session-isolated',
    })).resolves.toBeFalse()
  })

  test('Given the Agent UI submits its Local project-root alias When listing or searching files Then main resolves the exact lease and ignores renderer search roots', async () => {
    const { local, leased, service } = createFixture()

    await expect(service.resolveDirectoryRequest(local, {
      sessionId: 'session-isolated',
    })).resolves.toBe(leased)
    await expect(service.resolveActiveSearchTarget('session-isolated', local))
      .resolves.toMatchObject({ root: leased })
  })
})

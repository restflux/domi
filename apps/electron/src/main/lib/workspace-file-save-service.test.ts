import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentSessionMeta, AgentWorkspace } from '@domi/shared'
import { saveWorkspaceFiles } from './workspace-file-save-service.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'domi-workspace-files-'))
  roots.push(root)
  const localRoot = join(root, 'local')
  const isolatedRoot = join(root, 'isolated')
  mkdirSync(localRoot)
  mkdirSync(isolatedRoot)
  const workspace: AgentWorkspace = {
    id: 'workspace-a',
    name: 'Project A',
    slug: 'project-a',
    projectRootPath: localRoot,
    createdAt: 1,
    updatedAt: 1,
  }
  const session: AgentSessionMeta = {
    id: 'session-a',
    title: 'Session A',
    workspaceId: workspace.id,
    createdAt: 1,
    updatedAt: 1,
  }
  return {
    localRoot,
    isolatedRoot,
    workspace,
    session,
    dependencies: {
      getSession: (sessionId: string) => sessionId === session.id ? session : undefined,
      getWorkspaceBySlug: (slug: string) => slug === workspace.slug ? workspace : undefined,
      getLocalProjectRootStatus: () => 'available' as const,
      getProjectFilesPath: () => localRoot,
      resolveTargetRoot: async () => isolatedRoot,
    },
  }
}

function encoded(content: string): string {
  return Buffer.from(content).toString('base64')
}

describe('workspace file save service', () => {
  test('Given a Pi session owns an Isolated Checkout When a project file is uploaded Then it is written only to the lease and renderer receives a relative path', async () => {
    const context = fixture()

    const saved = await saveWorkspaceFiles({
      sessionId: context.session.id,
      workspaceSlug: context.workspace.slug,
      files: [{ filename: 'notes/result.txt', data: encoded('isolated only') }],
    }, context.dependencies)

    expect(readFileSync(join(context.isolatedRoot, 'notes', 'result.txt'), 'utf8')).toBe('isolated only')
    expect(existsSync(join(context.localRoot, 'notes', 'result.txt'))).toBeFalse()
    expect(saved[0]?.targetPath).toBe('notes/result.txt')
  })

  test('Given a junction inside the checkout lease points outside When a nested project file is uploaded Then the outside file is never created', async () => {
    const context = fixture()
    const outside = join(context.isolatedRoot, '..', 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(context.isolatedRoot, 'escape'), 'junction')

    await expect(saveWorkspaceFiles({
      sessionId: context.session.id,
      workspaceSlug: context.workspace.slug,
      files: [{ filename: 'escape/owned.txt', data: encoded('outside write') }],
    }, context.dependencies)).rejects.toThrow('项目文件名不安全')

    expect(existsSync(join(outside, 'owned.txt'))).toBeFalse()
  })

  test('Given a session belongs to another workspace When a project file is uploaded Then the request is rejected before resolving a target', async () => {
    const context = fixture()
    let resolverCalls = 0
    const dependencies = {
      ...context.dependencies,
      getSession: () => ({ ...context.session, workspaceId: 'workspace-b' }),
      resolveTargetRoot: async () => {
        resolverCalls += 1
        return context.isolatedRoot
      },
    }

    await expect(saveWorkspaceFiles({
      sessionId: context.session.id,
      workspaceSlug: context.workspace.slug,
      files: [{ filename: 'forged.txt', data: encoded('forged') }],
    }, dependencies)).rejects.toThrow('Agent 会话与项目不匹配')
    expect(resolverCalls).toBe(0)
    expect(existsSync(join(context.isolatedRoot, 'forged.txt'))).toBeFalse()
  })


})

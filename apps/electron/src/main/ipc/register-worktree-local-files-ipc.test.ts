import { describe, expect, test } from 'bun:test'
import { WORKTREE_LOCAL_FILES_IPC_CHANNELS as C } from '@domi/shared'
import { registerWorktreeLocalFilesIpc, type WorktreeLocalFilesIpcOptions } from './register-worktree-local-files-ipc.ts'

function fixture() {
  const calls: string[] = []
  const handlers = new Map<string, (event: { sender: { id: number } }, input: unknown) => unknown>()
  const view = { projectId: 'project', manifestVersion: 'version', entries: [{ path: '.env.local', status: 'unapproved' as const }] }
  const options: WorktreeLocalFilesIpcOptions = {
    service: {
      inspect: async () => { calls.push('inspect'); return view },
      save: async (_project, paths) => { calls.push(`save:${paths.join(',')}`); return view },
      confirm: async () => { calls.push('confirm'); return view },
      listDirectory: async (_project, directory, query) => { calls.push(`list:${directory}:${query}`); return { directory, entries: [] } },
      resolveSelection: async (_project, paths, existing) => { calls.push(`select:${paths.join(',')}:${existing.join(',')}`); return { paths, skipped: [] } },
    },
    checkout: {
      runExclusiveProjectConfiguration: async (_projectId, action) => { calls.push('lock'); return action() },
      inspectLocalFilesTarget: async (_sessionId, projectId) => projectId === 'project' ? { sessionId: 'owner', revision: 4, canPrepare: true, files: [] } : undefined,
      prepareLocalFiles: async (sessionId, revision, overwrites) => { calls.push(`prepare:${sessionId}:${revision}:${overwrites?.length ?? 0}`); return { copied: [], skipped: [] } },
    },
    resolveProject: (id) => { if (id !== 'project') throw new Error('未知项目'); return { id, root: '/host-owned-project' } },
    assertSender: (event) => { if (event.sender.id !== 42) throw new Error('仅应用主窗口可以管理本地配置') },
    assertProjectIdle: () => { calls.push('idle') },
  }
  registerWorktreeLocalFilesIpc({ handle: (channel, handler) => { handlers.set(channel, handler) } }, options)
  const invoke = (channel: string, input: unknown, senderId = 42) => handlers.get(channel)!({ sender: { id: senderId } }, input)
  return { invoke, calls, options }
}

describe('Worktree 本地配置 IPC', () => {
  test('非主窗口不能读取、批准或复制，拒绝发生在解析项目之前', async () => {
    const context = fixture()
    for (const channel of Object.values(C)) expect(await context.invoke(channel, { projectId: 'project' }, 7)).toMatchObject({ ok: false })
    expect(context.calls).toEqual([])
  })
  test('打开清单只检查状态，不确认或复制文件', async () => {
    const context = fixture()
    expect(await context.invoke(C.INSPECT, { projectId: 'project', sessionId: 'owner' })).toMatchObject({ ok: true, value: { target: { revision: 4 } } })
    expect(context.calls).toEqual(['inspect'])
  })
  test('枚举与文件夹展开只接收项目相对请求，不允许伪造根且不批准或复制', async () => {
    const context = fixture()
    expect(await context.invoke(C.LIST_DIRECTORY, { projectId: 'project', directory: '', query: '.env' })).toMatchObject({ ok: true })
    expect(await context.invoke(C.RESOLVE_SELECTION, { projectId: 'project', paths: ['config'], existingPaths: ['.env.local'] })).toMatchObject({ ok: true })
    expect(context.calls).toEqual(['list::.env', 'select:config:.env.local'])
    context.calls.length = 0
    for (const [channel, input] of [
      [C.LIST_DIRECTORY, { projectId: 'project', directory: '', root: '/outside' }],
      [C.LIST_DIRECTORY, { projectId: 'project', directory: 1 }],
      [C.LIST_DIRECTORY, { projectId: 'project', directory: '', query: 'a'.repeat(129) }],
      [C.RESOLVE_SELECTION, { projectId: 'project', paths: ['config'], existingPaths: [], root: '/outside' }],
      [C.RESOLVE_SELECTION, { projectId: 'project', paths: 'config', existingPaths: [] }],
    ] as const) expect(await context.invoke(channel, input)).toMatchObject({ ok: false })
    expect(context.calls).toEqual([])
  })
  test('保存和确认由项目锁与活跃检查保护，不接受任意源或目标根', async () => {
    const context = fixture()
    expect(await context.invoke(C.SAVE, { projectId: 'project', expectedVersion: 'v1', paths: ['.env.local'] })).toMatchObject({ ok: true })
    expect(context.calls).toEqual(['lock', 'idle', 'save:.env.local'])
    context.calls.length = 0
    expect(await context.invoke(C.CONFIRM, { projectId: 'project', expectedVersion: 'v1', root: '/outside' })).toMatchObject({ ok: false })
    expect(context.calls).toEqual([])
    context.options.assertProjectIdle = () => { throw new Error('会话正在运行') }
    expect(await context.invoke(C.CONFIRM, { projectId: 'project', expectedVersion: 'v1' })).toMatchObject({ ok: false })
    expect(context.calls).toEqual(['lock'])
  })
  test('补复制保留 session/revision/覆盖指纹，不接受路径替换目标或畸形 revision', async () => {
    const context = fixture()
    expect(await context.invoke(C.PREPARE, { sessionId: 'owner', expectedRevision: 4, overwriteFiles: [{ path: '.env.local', expectedFingerprint: 'version' }] })).toMatchObject({ ok: true })
    expect(context.calls).toEqual(['prepare:owner:4:1'])
    context.calls.length = 0
    for (const input of [
      { sessionId: 'owner', expectedRevision: 4, targetRoot: '/outside' },
      { sessionId: 'owner', expectedRevision: -1 },
      { sessionId: 'owner', expectedRevision: Number.NaN },
      { sessionId: 'owner', expectedRevision: 4, overwriteFiles: [{ path: '.env.local' }] },
    ]) expect(await context.invoke(C.PREPARE, input)).toMatchObject({ ok: false })
    expect(context.calls).toEqual([])
  })
})

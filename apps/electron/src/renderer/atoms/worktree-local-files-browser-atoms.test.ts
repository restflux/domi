import { afterEach, describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { WorktreeLocalFilesRendererApi, WorktreeLocalFilesNode } from '@domi/shared'
import { openWorktreeLocalFilesDialogAtom, closeWorktreeLocalFilesDialogAtom, selectWorktreeLocalFilesAtom, removeWorktreeLocalDirectoryAtom, worktreeLocalFilesDialogAtom } from './worktree-local-files-atoms.ts'
import { loadWorktreeLocalDirectoryAtom, refreshWorktreeLocalFilesBrowserAtom, setWorktreeLocalFilesQueryAtom, toggleWorktreeLocalDirectoryAtom, worktreeLocalFilesBrowserAtom } from './worktree-local-files-browser-atoms.ts'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
const file = (path: string): WorktreeLocalFilesNode => ({ path, name: path.split('/').at(-1)!, kind: 'file', selectable: true })
function install(overrides: Partial<WorktreeLocalFilesRendererApi> = {}): void {
  const api: WorktreeLocalFilesRendererApi = {
    inspect: async ({ projectId }) => ({ ok: true, value: { projectId, manifestVersion: 'v1', entries: [{ path: '.env.local', status: 'ready' }] } }),
    listDirectory: async ({ directory }) => ({ ok: true, value: { directory, entries: [] } }),
    resolveSelection: async () => ({ ok: true, value: { paths: [], skipped: [] } }),
    save: async () => { throw new Error('浏览不应保存') },
    confirm: async () => { throw new Error('浏览不应批准') },
    prepare: async () => { throw new Error('浏览不应复制') },
    ...overrides,
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { worktreeLocalFiles: api } } })
}
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

describe('项目文件树状态', () => {
  test('按项目加载根与展开目录，不批准或复制；同一快照复用目录读取', async () => {
    const inputs: Array<Parameters<WorktreeLocalFilesRendererApi['listDirectory']>[0]> = []
    install({ listDirectory: async input => { inputs.push(input); return { ok: true, value: { directory: input.directory, entries: [file(`${input.directory ? `${input.directory}/` : ''}.env`)] } } } })
    const store = createStore()
    await store.set(openWorktreeLocalFilesDialogAtom, { projectId: 'a' })
    await store.set(loadWorktreeLocalDirectoryAtom, { directory: '' })
    await store.set(loadWorktreeLocalDirectoryAtom, { directory: '' })
    await store.set(toggleWorktreeLocalDirectoryAtom, 'config')
    expect(inputs).toEqual([{ projectId: 'a', directory: '' }, { projectId: 'a', directory: 'config' }])
    expect(store.get(worktreeLocalFilesBrowserAtom).directories.config?.entries?.[0]?.path).toBe('config/.env')
    expect(store.get(worktreeLocalFilesDialogAtom).paths).toEqual(['.env.local'])
  })

  test('搜索词改变后旧结果不能覆盖新结果', async () => {
    let resolveOld: ((result: Awaited<ReturnType<WorktreeLocalFilesRendererApi['listDirectory']>>) => void) | undefined
    const old = new Promise<Awaited<ReturnType<WorktreeLocalFilesRendererApi['listDirectory']>>>(resolve => { resolveOld = resolve })
    install({ listDirectory: async ({ directory, query }) => query === 'old' ? old : { ok: true, value: { directory, entries: [file('new.env')] } } })
    const store = createStore()
    await store.set(openWorktreeLocalFilesDialogAtom, { projectId: 'a' })
    store.set(setWorktreeLocalFilesQueryAtom, 'old')
    const loading = store.set(loadWorktreeLocalDirectoryAtom, { directory: '', query: 'old' })
    store.set(setWorktreeLocalFilesQueryAtom, 'new')
    await store.set(loadWorktreeLocalDirectoryAtom, { directory: '', query: 'new' })
    resolveOld?.({ ok: true, value: { directory: '', entries: [file('old.env')] } })
    await loading
    expect(store.get(worktreeLocalFilesBrowserAtom).search.entries).toEqual([file('new.env')])
  })

  test('切换项目或关闭再打开后旧目录结果不能进入新文件树', async () => {
    let resolveOld: ((result: Awaited<ReturnType<WorktreeLocalFilesRendererApi['listDirectory']>>) => void) | undefined
    const old = new Promise<Awaited<ReturnType<WorktreeLocalFilesRendererApi['listDirectory']>>>(resolve => { resolveOld = resolve })
    install({ listDirectory: async () => old })
    const store = createStore()
    await store.set(openWorktreeLocalFilesDialogAtom, { projectId: 'a' })
    const loading = store.set(loadWorktreeLocalDirectoryAtom, { directory: '' })
    store.set(closeWorktreeLocalFilesDialogAtom)
    await store.set(openWorktreeLocalFilesDialogAtom, { projectId: 'b' })
    resolveOld?.({ ok: true, value: { directory: '', entries: [file('old-secret.env')] } })
    await loading
    expect(store.get(worktreeLocalFilesBrowserAtom).directories).toEqual({})
    expect(store.get(worktreeLocalFilesDialogAtom).request?.projectId).toBe('b')
  })

  test('文件夹批量选择只加入可用文件；刷新树不丢草稿，清除仅影响该文件夹', async () => {
    const inputs: Array<Parameters<WorktreeLocalFilesRendererApi['resolveSelection']>[0]> = []
    install({ resolveSelection: async input => { inputs.push(input); return { ok: true, value: { paths: ['config/local.json', 'config/deep/.env'], skipped: [{ path: 'config/tracked.json', reason: '由 Git 管理' }] } } } })
    const store = createStore()
    await store.set(openWorktreeLocalFilesDialogAtom, { projectId: 'a' })
    await store.set(selectWorktreeLocalFilesAtom, { path: 'config', directory: true })
    expect(inputs).toEqual([{ projectId: 'a', paths: ['config'], existingPaths: ['.env.local'] }])
    expect(store.get(worktreeLocalFilesDialogAtom).paths).toEqual(['.env.local', 'config/local.json', 'config/deep/.env'])
    expect(store.get(worktreeLocalFilesDialogAtom).paths).not.toContain('config/tracked.json')
    expect(store.get(worktreeLocalFilesDialogAtom).folderSelections.config).toEqual(['config/local.json', 'config/deep/.env'])
    await store.set(refreshWorktreeLocalFilesBrowserAtom)
    expect(store.get(worktreeLocalFilesDialogAtom).paths).toHaveLength(3)
    expect(store.get(worktreeLocalFilesDialogAtom).folderSelections).toEqual({})
    store.set(removeWorktreeLocalDirectoryAtom, 'config')
    expect(store.get(worktreeLocalFilesDialogAtom).paths).toEqual(['.env.local'])
  })

  test('文件夹超限失败不会加入部分文件或改变已有选择', async () => {
    install({ resolveSelection: async () => ({ ok: false, error: { code: 'limit_exceeded', message: '选择超过100文件' } }) })
    const store = createStore()
    await store.set(openWorktreeLocalFilesDialogAtom, { projectId: 'a' })
    await store.set(selectWorktreeLocalFilesAtom, { path: 'large', directory: true })
    expect(store.get(worktreeLocalFilesDialogAtom).paths).toEqual(['.env.local'])
    expect(store.get(worktreeLocalFilesDialogAtom).error?.code).toBe('limit_exceeded')
    expect(store.get(worktreeLocalFilesDialogAtom).busy).toBeNull()
  })
})

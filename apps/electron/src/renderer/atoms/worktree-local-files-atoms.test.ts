import { afterEach, describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { WorktreeLocalFilesRendererApi, WorktreeLocalFilesView } from '@domi/shared'
import {
  canPrepareWorktreeLocalFiles, closeWorktreeLocalFilesDialogAtom,
  confirmWorktreeLocalFilesAtom, openWorktreeLocalFilesDialogAtom,
  prepareWorktreeLocalFilesAtom, refreshWorktreeLocalFilesDialogAtom,
  removeWorktreeLocalFileAtom, saveWorktreeLocalFilesAtom,
  selectWorktreeLocalFilesAtom, worktreeLocalFilesDialogAtom,
} from './worktree-local-files-atoms.ts'

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
const view: WorktreeLocalFilesView = {
  projectId: 'project-a', manifestVersion: 'v1',
  entries: [{ path: '.env.local', status: 'unapproved' }],
  target: { sessionId: 'session-a', revision: 12, canPrepare: true,
    files: [{ path: '.env.local', exists: true, fingerprint: 'fingerprint-a' }] },
}

function installApi(overrides: Partial<WorktreeLocalFilesRendererApi> = {}, onTargetRefresh: () => void = () => undefined): void {
  const api: WorktreeLocalFilesRendererApi = {
    inspect: async () => ({ ok: true, value: view }),
    listDirectory: async ({ directory }) => ({ ok: true, value: { directory, entries: [] } }),
    resolveSelection: async () => ({ ok: true, value: { paths: [], skipped: [] } }),
    save: async () => ({ ok: true, value: view }),
    confirm: async () => ({ ok: true, value: view }),
    prepare: async () => ({ ok: true, value: { copied: [], skipped: [] } }),
    ...overrides,
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: {
    worktreeLocalFiles: api,
    sessionCheckout: { inspect: async () => { onTargetRefresh(); return { ok: false, error: { code: 'target_unselected', message: '' } } } },
  } } })
}

afterEach(() => {
  if (originalWindowDescriptor) Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
  else Reflect.deleteProperty(globalThis, 'window')
})

describe('Worktree 本地配置状态', () => {
  test('清空不再需要的清单后可显式完成准备，避免失败 Worktree 无法恢复', async () => {
    installApi({ inspect: async () => ({ ok: true, value: { ...view, entries: [], target: { sessionId: 'session-a', revision: 12, canPrepare: true, files: [] } } }) })
    const store = createStore()
    await store.set(openWorktreeLocalFilesDialogAtom, { projectId: 'project-a', sessionId: 'session-a' })
    expect(canPrepareWorktreeLocalFiles(store.get(worktreeLocalFilesDialogAtom))).toBe(true)
  })
  test('打开清单只检查，不隐式批准或复制本地配置', async () => {
    let mutations = 0
    installApi({
      save: async () => { mutations++; return { ok: true, value: view } },
      confirm: async () => { mutations++; return { ok: true, value: view } },
      prepare: async () => { mutations++; return { ok: true, value: { copied: [], skipped: [] } } },
    })
    const store = createStore()
    await store.set(openWorktreeLocalFilesDialogAtom, { projectId: 'project-a', sessionId: 'session-a' })
    expect(store.get(worktreeLocalFilesDialogAtom).view).toEqual(view)
    expect(mutations).toBe(0)
  })

  test('添加与移除只改变草稿，保存显式带原始 manifest 版本并重新检查', async () => {
    const saved: Array<Parameters<WorktreeLocalFilesRendererApi['save']>[0]> = []
    let currentView = view
    let inspections = 0
    installApi({
      inspect: async () => { inspections++; return { ok: true, value: currentView } },
      resolveSelection: async () => ({ ok: true, value: { paths: ['config/local.json', '.env.local'], skipped: [] } }),
      save: async (input) => {
        saved.push(input)
        currentView = { ...view, manifestVersion: 'v2', entries: input.paths.map((path) => ({ path, status: 'ready' })) }
        return { ok: true, value: currentView }
      },
    })
    const store = createStore()
    await store.set(openWorktreeLocalFilesDialogAtom, { projectId: 'project-a' })
    await store.set(selectWorktreeLocalFilesAtom, { path: 'config', directory: true })
    store.set(removeWorktreeLocalFileAtom, '.env.local')
    expect(saved).toEqual([])
    expect(store.get(worktreeLocalFilesDialogAtom).paths).toEqual(['config/local.json'])
    await store.set(saveWorktreeLocalFilesAtom)
    expect(saved).toEqual([{ projectId: 'project-a', expectedVersion: 'v1', paths: ['config/local.json'] }])
    expect(inspections).toBe(2)
    expect(store.get(worktreeLocalFilesDialogAtom).view?.manifestVersion).toBe('v2')
  })

  test('外部清单批准必须显式操作，带 inspect 版本并刷新状态', async () => {
    const confirmed: Array<Parameters<WorktreeLocalFilesRendererApi['confirm']>[0]> = []
    let currentView = view
    installApi({
      inspect: async () => ({ ok: true, value: currentView }),
      confirm: async (input) => {
        confirmed.push(input)
        currentView = { ...view, entries: [{ path: '.env.local', status: 'ready' }] }
        return { ok: true, value: currentView }
      },
    })
    const store = createStore()
    await store.set(openWorktreeLocalFilesDialogAtom, { projectId: 'project-a', sessionId: 'session-a' })
    expect(canPrepareWorktreeLocalFiles(store.get(worktreeLocalFilesDialogAtom))).toBe(false)
    await store.set(confirmWorktreeLocalFilesAtom)
    expect(confirmed).toEqual([{ projectId: 'project-a', expectedVersion: 'v1' }])
    expect(canPrepareWorktreeLocalFiles(store.get(worktreeLocalFilesDialogAtom))).toBe(true)
  })

  test('默认补复制只带权威 revision，不默认覆盖，并刷新原会话 Target 与配置视图', async () => {
    const prepared: Array<Parameters<WorktreeLocalFilesRendererApi['prepare']>[0]> = []
    let inspections = 0
    let targetRefreshes = 0
    installApi({
      inspect: async () => { inspections++; return { ok: true, value: { ...view, entries: [{ path: '.env.local', status: 'ready' }] } } },
      prepare: async (input) => { prepared.push(input); return { ok: true, value: { copied: [], skipped: ['.env.local'] } } },
    }, () => { targetRefreshes++ })
    const store = createStore()
    await store.set(openWorktreeLocalFilesDialogAtom, { projectId: 'project-a', sessionId: 'session-a' })
    await store.set(prepareWorktreeLocalFilesAtom)
    expect(prepared).toEqual([{ sessionId: 'session-a', expectedRevision: 12 }])
    expect(targetRefreshes).toBe(1)
    expect(inspections).toBe(2)
    expect(store.get(worktreeLocalFilesDialogAtom).notice).toContain('跳过 1 个文件')
  })

  test('只有显式选择且 fingerprint 仍匹配的现存文件才能发起覆盖', async () => {
    const prepared: Array<Parameters<WorktreeLocalFilesRendererApi['prepare']>[0]> = []
    installApi({
      inspect: async () => ({ ok: true, value: { ...view, entries: [{ path: '.env.local', status: 'ready' }] } }),
      prepare: async (input) => { prepared.push(input); return { ok: true, value: { copied: ['.env.local'], skipped: [] } } },
    })
    const store = createStore()
    await store.set(openWorktreeLocalFilesDialogAtom, { projectId: 'project-a', sessionId: 'session-a' })
    await store.set(prepareWorktreeLocalFilesAtom, [{ path: '.env.local', expectedFingerprint: 'stale' }])
    await store.set(prepareWorktreeLocalFilesAtom, [{ path: 'unknown', expectedFingerprint: 'fingerprint-a' }])
    expect(prepared).toEqual([])
    const overwriteFiles = [{ path: '.env.local', expectedFingerprint: 'fingerprint-a' }]
    await store.set(prepareWorktreeLocalFilesAtom, overwriteFiles)
    expect(prepared).toEqual([{ sessionId: 'session-a', expectedRevision: 12, overwriteFiles }])
  })

  test('草稿修改、未批准、忙碌或 Main 不允许准备时不能复制', async () => {
    let prepares = 0
    let currentView = view
    installApi({
      inspect: async () => ({ ok: true, value: currentView }),
      prepare: async () => { prepares++; return { ok: true, value: { copied: [], skipped: [] } } },
    })
    const store = createStore()
    await store.set(openWorktreeLocalFilesDialogAtom, { projectId: 'project-a', sessionId: 'session-a' })
    await store.set(prepareWorktreeLocalFilesAtom)
    currentView = { ...view, entries: [{ path: '.env.local', status: 'ready' }], target: { ...view.target!, canPrepare: false } }
    await store.set(refreshWorktreeLocalFilesDialogAtom)
    await store.set(prepareWorktreeLocalFilesAtom)
    currentView = { ...currentView, target: { ...view.target!, canPrepare: true } }
    await store.set(refreshWorktreeLocalFilesDialogAtom)
    store.set(removeWorktreeLocalFileAtom, '.env.local')
    await store.set(prepareWorktreeLocalFilesAtom)
    expect(prepares).toBe(0)
  })

  test('另一个项目打开后，旧 inspect 与文件选择结果不能污染新清单', async () => {
    let resolveOld: ((result: Awaited<ReturnType<WorktreeLocalFilesRendererApi['inspect']>>) => void) | undefined
    const oldInspect = new Promise<Awaited<ReturnType<WorktreeLocalFilesRendererApi['inspect']>>>((resolve) => { resolveOld = resolve })
    let resolveSelected: ((result: Awaited<ReturnType<WorktreeLocalFilesRendererApi['resolveSelection']>>) => void) | undefined
    const oldSelection = new Promise<Awaited<ReturnType<WorktreeLocalFilesRendererApi['resolveSelection']>>>((resolve) => { resolveSelected = resolve })
    installApi({
      inspect: async ({ projectId }) => projectId === 'project-old' ? oldInspect : { ok: true, value: { ...view, projectId } },
      resolveSelection: async () => oldSelection,
    })
    const store = createStore()
    const oldOpen = store.set(openWorktreeLocalFilesDialogAtom, { projectId: 'project-old' })
    await store.set(openWorktreeLocalFilesDialogAtom, { projectId: 'project-a' })
    resolveOld?.({ ok: true, value: { ...view, projectId: 'project-old' } })
    await oldOpen
    expect(store.get(worktreeLocalFilesDialogAtom).view?.projectId).toBe('project-a')
    const selecting = store.set(selectWorktreeLocalFilesAtom, { path: 'config', directory: true })
    store.set(closeWorktreeLocalFilesDialogAtom)
    await store.set(openWorktreeLocalFilesDialogAtom, { projectId: 'project-b' })
    resolveSelected?.({ ok: true, value: { paths: ['old-secret-path'], skipped: [] } })
    await selecting
    expect(store.get(worktreeLocalFilesDialogAtom).paths).toEqual(['.env.local'])
    expect(store.get(worktreeLocalFilesDialogAtom).busy).toBeNull()
  })

  test('复制失败只刷新配置并展示错误，不重试或自动发送输入', async () => {
    let prepares = 0
    let targetRefreshes = 0
    installApi({
      inspect: async () => ({ ok: true, value: { ...view, entries: [{ path: '.env.local', status: 'missing' }] } }),
      prepare: async () => { prepares++; return { ok: false, error: { code: 'source_missing', message: '原项目文件不存在' } } },
    }, () => { targetRefreshes++ })
    const store = createStore()
    await store.set(openWorktreeLocalFilesDialogAtom, { projectId: 'project-a', sessionId: 'session-a' })
    await store.set(prepareWorktreeLocalFilesAtom)
    expect(prepares).toBe(1)
    expect(targetRefreshes).toBe(0)
    expect(store.get(worktreeLocalFilesDialogAtom).error?.code).toBe('source_missing')
    expect(store.get(worktreeLocalFilesDialogAtom).busy).toBeNull()
  })
})

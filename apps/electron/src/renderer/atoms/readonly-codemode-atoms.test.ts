import { expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { AgentSessionMeta } from '@domi/shared'
import { agentSessionsAtom } from './agent-atoms.ts'
import { createReadonlyCodemodeAtoms } from './readonly-codemode-atoms.ts'

function session(id: string): AgentSessionMeta { return { id, title: id, createdAt: 1, updatedAt: 1 } }

test('当前会话从Main结果更新，其他会话/刷新加载保持隔离；未设置默认关闭', async () => {
  const store = createStore()
  const atoms = createReadonlyCodemodeAtoms(async (id, enabled) => ({ ...session(id), readonlyCodemode: enabled }))
  store.set(agentSessionsAtom, [session('a'), session('b')])
  expect(store.get(atoms.state('a')).enabled).toBe(false)
  await store.set(atoms.update, { sessionId: 'a', enabled: true })
  expect(store.get(atoms.state('a')).enabled).toBe(true)
  expect(store.get(atoms.state('b')).enabled).toBe(false)
  const restarted = createStore()
  restarted.set(agentSessionsAtom, store.get(agentSessionsAtom))
  expect(restarted.get(atoms.state('a')).enabled).toBe(true)
  expect(restarted.get(atoms.state('b')).enabled).toBe(false)
})

test('保存失败不乐观开启，释放pending，下次可重试', async () => {
  const store = createStore()
  let fail = true
  const atoms = createReadonlyCodemodeAtoms(async (id, enabled) => {
    if (fail) throw new Error('disk error')
    return { ...session(id), readonlyCodemode: enabled }
  })
  store.set(agentSessionsAtom, [session('a')])
  await expect(store.set(atoms.update, { sessionId: 'a', enabled: true })).rejects.toThrow('disk error')
  expect(store.get(atoms.state('a'))).toMatchObject({ enabled: false, pending: false })
  fail = false
  await store.set(atoms.update, { sessionId: 'a', enabled: true })
  expect(store.get(atoms.state('a')).enabled).toBe(true)
})

test('pending按会话去重，切换会话与迟到结果不覆盖期间修改的模型/权限/标题', async () => {
  const store = createStore()
  let finish: (value: AgentSessionMeta) => void = () => { throw new Error('尚无请求') }
  let calls = 0
  const atoms = createReadonlyCodemodeAtoms(async () => {
    calls++
    return new Promise<AgentSessionMeta>(resolve => { finish = resolve })
  })
  store.set(agentSessionsAtom, [session('a'), session('b')])
  const saving = store.set(atoms.update, { sessionId: 'a', enabled: true })
  expect(store.get(atoms.state('a')).pending).toBe(true)
  expect(store.get(atoms.state('b')).pending).toBe(false)
  await store.set(atoms.update, { sessionId: 'a', enabled: false })
  expect(calls).toBe(1)
  store.set(agentSessionsAtom, [{ ...session('a'), title: '新标题', modelId: 'new-model', workflow: 'read-only', updatedAt: 10 }, session('b')])
  finish({ ...session('a'), readonlyCodemode: true })
  await saving
  expect(store.get(agentSessionsAtom)[0]).toMatchObject({ readonlyCodemode: true, title: '新标题', modelId: 'new-model', workflow: 'read-only', updatedAt: 10 })
  expect(store.get(atoms.state('b')).enabled).toBe(false)
})

test('删除后迟到结果不恢复会话，独立侧聊/极简不能开启，也不调用IPC', async () => {
  const store = createStore()
  let finish: (value: AgentSessionMeta) => void = () => { throw new Error('尚无请求') }
  let calls = 0
  const atoms = createReadonlyCodemodeAtoms(async () => {
    calls++
    return new Promise<AgentSessionMeta>(resolve => { finish = resolve })
  })
  store.set(agentSessionsAtom, [session('a')])
  const saving = store.set(atoms.update, { sessionId: 'a', enabled: true })
  store.set(agentSessionsAtom, [])
  finish({ ...session('a'), readonlyCodemode: true })
  await saving
  expect(store.get(agentSessionsAtom)).toEqual([])
  for (const purpose of [{ sideChatParentSessionId: 'parent' }, { parentSessionId: 'parent' }, { modelPresentationPreset: 'minimal' as const }]) {
    store.set(agentSessionsAtom, [{ ...session('a'), ...purpose }])
    await expect(store.set(atoms.update, { sessionId: 'a', enabled: true })).rejects.toThrow('不支持')
  }
  expect(calls).toBe(1)
})

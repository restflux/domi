import { expect, test } from 'bun:test'
import type { AgentSessionMeta } from '../types/agent.ts'
import { getReadonlyCodemodeUnavailableReason, resolveReadonlyCodemodeForRun } from './readonly-codemode.ts'

const main: AgentSessionMeta = { id: 'main', title: '主任务', createdAt: 1, updatedAt: 1 }

test('旧会话/缺失及非法存储值关闭，只有当前主会话严格true开启', () => {
  expect(resolveReadonlyCodemodeForRun(undefined)).toBe(false)
  expect(resolveReadonlyCodemodeForRun(main)).toBe(false)
  for (const value of ['true', 1, {}, null, false]) {
    expect(resolveReadonlyCodemodeForRun(Object.assign({}, main, { readonlyCodemode: value }))).toBe(false)
  }
  expect(resolveReadonlyCodemodeForRun({ ...main, readonlyCodemode: true })).toBe(true)
})

test('侧聊/协作/审查即使旧数据有true也不曝光，极简预设保留原工具目录', () => {
  for (const purpose of [
    { sideChatParentSessionId: 'parent' }, { parentSessionId: 'parent' }, { rootSessionId: 'parent' },
    { sourceDelegationId: 'delegation' }, { independentReviewId: 'review' }, { delegationDepth: 1 },
  ]) {
    const session = { ...main, readonlyCodemode: true, ...purpose }
    expect(getReadonlyCodemodeUnavailableReason(session)).toBe('not-main-session')
    expect(resolveReadonlyCodemodeForRun(session)).toBe(false)
  }
  const minimal = { ...main, readonlyCodemode: true, modelPresentationPreset: 'minimal' as const }
  expect(getReadonlyCodemodeUnavailableReason(minimal)).toBe('minimal-preset')
  expect(resolveReadonlyCodemodeForRun(minimal)).toBe(false)
})

test('启动时选择固定，运行中修改只影响下一次解析，不改变权限或工作方式', () => {
  let stored = { ...main, readonlyCodemode: true, workflow: 'read-only' as const }
  const firstRun = resolveReadonlyCodemodeForRun(stored)
  stored = { ...stored, readonlyCodemode: false }
  expect(firstRun).toBe(true)
  expect(resolveReadonlyCodemodeForRun(stored)).toBe(false)
  expect(stored.workflow).toBe('read-only')
})

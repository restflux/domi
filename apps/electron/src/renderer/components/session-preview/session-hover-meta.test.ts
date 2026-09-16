import { describe, expect, test } from 'bun:test'
import type { SessionTargetView } from '@domi/shared'
import { buildSessionHoverMeta, formatHoverUpdatedAt } from './session-hover-meta'

// 用本地时间构造，避免测试依赖运行机器的时区。
const NOW = new Date(2026, 8, 16, 14, 30).getTime()

function targetView(overrides: Partial<SessionTargetView> = {}): SessionTargetView {
  return {
    project: { id: 'project-1', name: 'domi' },
    checkout: { id: 'checkout-1', kind: 'isolated', label: 'Worktree', phase: 'ready' },
    source: { ref: 'refs/heads/main', oid: 'a'.repeat(40) },
    current: { branch: 'worktree--prod-name-a3f9c21', oid: 'b'.repeat(40) },
    ownership: 'owner',
    dirty: false,
    revision: 1,
    ...overrides,
  }
}

describe('buildSessionHoverMeta 目标标签', () => {
  test('无快照时按持久化意图区分 Local 与 Worktree', () => {
    expect(buildSessionHoverMeta({ sessionTargetKind: 'local', snapshot: null }).targetLabel).toBe('Local')
    expect(buildSessionHoverMeta({ sessionTargetKind: 'isolated', snapshot: null }).targetLabel).toBe('Worktree')
    expect(buildSessionHoverMeta({ sessionTargetKind: 'unselected', snapshot: null }).targetLabel).toBe('未选择位置')
  })

  test('历史会话缺失目标字段时按 Local 兼容', () => {
    const meta = buildSessionHoverMeta({ snapshot: null })
    expect(meta.targetLabel).toBe('Local')
    expect(meta.targetTone).toBe('neutral')
  })

  test('有快照时以快照的 checkout 类型为准', () => {
    const meta = buildSessionHoverMeta({
      sessionTargetKind: 'local',
      snapshot: targetView({ checkout: { id: 'c1', kind: 'isolated', label: 'Worktree', phase: 'ready' } }),
    })
    expect(meta.targetLabel).toBe('Worktree')
    expect(meta.targetTone).toBe('progress')
  })

  test('无快照时不显示状态与分支，但保留由意图推导的标签', () => {
    const meta = buildSessionHoverMeta({ sessionTargetKind: 'isolated', snapshot: null })
    expect(meta.statusLabel).toBeNull()
    expect(meta.gitLabel).toBeNull()
  })
})

describe('buildSessionHoverMeta 状态与分支', () => {
  test('Worktree 快照给出分支名与交付状态', () => {
    const meta = buildSessionHoverMeta({
      snapshot: targetView({ delivery: { state: 'working', iteration: 1 } }),
    })
    expect(meta.statusLabel).toBe('修改中')
    expect(meta.statusTone).toBe('ready')
    expect(meta.gitLabel).toBe('worktree--prod-name-a3f9c21')
  })

  test('已交付的 Worktree 显示交付终态', () => {
    const meta = buildSessionHoverMeta({
      snapshot: targetView({
        delivery: { state: 'delivered', iteration: 2, commitOid: 'c'.repeat(40), deliveredAt: NOW },
      }),
    })
    expect(meta.statusLabel).toBe('已交付')
    expect(meta.statusTone).toBe('muted')
  })

  test('Local 快照的状态与目标标签重复时省略状态', () => {
    const meta = buildSessionHoverMeta({
      snapshot: targetView({
        checkout: { id: 'checkout-1', kind: 'local', label: 'Local', phase: 'ready' },
        current: { branch: 'main', oid: 'd'.repeat(40) },
      }),
    })
    expect(meta.targetLabel).toBe('Local')
    expect(meta.statusLabel).toBeNull()
    expect(meta.gitLabel).toBe('main')
  })

  test('detached HEAD 退化为 Detached 加短 oid', () => {
    const meta = buildSessionHoverMeta({
      snapshot: targetView({ current: { branch: null, oid: 'a3f9c2188f00' } }),
    })
    expect(meta.gitLabel).toBe('Detached a3f9c21')
  })
})

describe('formatHoverUpdatedAt', () => {
  test('同年只保留月日与时分', () => {
    expect(formatHoverUpdatedAt(NOW, NOW)).toBe('9月16日 14:30')
  })

  test('跨年补上年份', () => {
    const lastYear = new Date(2025, 11, 31, 8, 5).getTime()
    expect(formatHoverUpdatedAt(lastYear, NOW)).toBe('2025年12月31日 08:05')
  })

  test('面板通过 updatedAt 提供更新时间，缺失时为空', () => {
    expect(buildSessionHoverMeta({ snapshot: null, updatedAt: NOW }, NOW).updatedLabel).toBe('9月16日 14:30')
    expect(buildSessionHoverMeta({ snapshot: null }, NOW).updatedLabel).toBeNull()
  })
})

import { describe, expect, test } from 'bun:test'
import { orderSidebarSessions, toggleAllProjectGroups } from './sidebar-session-order'

const sessions = [
  { id: 'old-updated-new-created', title: 'Zeta 2', createdAt: 300, updatedAt: 100 },
  { id: 'new-updated-old-created', title: 'Alpha', createdAt: 100, updatedAt: 300 },
  { id: 'middle', title: 'Zeta 10', createdAt: 200, updatedAt: 200 },
]

describe('orderSidebarSessions', () => {
  test('按更新时间倒序排列', () => {
    expect(orderSidebarSessions(sessions, 'updated').map((session) => session.id)).toEqual([
      'new-updated-old-created',
      'middle',
      'old-updated-new-created',
    ])
  })

  test('按创建时间倒序排列', () => {
    expect(orderSidebarSessions(sessions, 'created').map((session) => session.id)).toEqual([
      'old-updated-new-created',
      'middle',
      'new-updated-old-created',
    ])
  })

  test('时间相同时使用标题自然排序保持稳定', () => {
    const tied = [
      { id: 'z10', title: 'Zeta 10', createdAt: 100, updatedAt: 100 },
      { id: 'z2', title: 'Zeta 2', createdAt: 100, updatedAt: 100 },
    ]

    expect(orderSidebarSessions(tied, 'updated').map((session) => session.id)).toEqual(['z2', 'z10'])
  })
})

describe('toggleAllProjectGroups', () => {
  test('任一项目展开时收起全部项目', () => {
    expect([...toggleAllProjectGroups(new Set(['external']), ['a', 'b'])].sort()).toEqual(['a', 'b', 'external'])
  })

  test('全部项目已收起时展开全部，并保留其他分组状态', () => {
    expect([...toggleAllProjectGroups(new Set(['a', 'b', 'external']), ['a', 'b'])]).toEqual(['external'])
  })
})

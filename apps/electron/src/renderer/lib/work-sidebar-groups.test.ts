import { describe, expect, test } from 'bun:test'
import type { WorkSidebarCustomGroup } from '../../types'
import {
  assignSessionToCustomGroup,
  groupWorkSidebarSessions,
  toggleSessionInCustomGroup,
} from './work-sidebar-groups'

const groups: WorkSidebarCustomGroup[] = [
  { id: 'design', name: '设计', color: 'orange', collapsed: false, sessionIds: ['s1', 's2'] },
  { id: 'build', name: '实现', color: 'blue', collapsed: false, sessionIds: ['s3'] },
]

describe('Work 自定义分组', () => {
  test('Given 会话已属于其他分组 When 拖入目标分组 Then 只保留一个分组归属', () => {
    expect(assignSessionToCustomGroup(groups, 's2', 'build')).toEqual([
      { ...groups[0]!, sessionIds: ['s1'] },
      { ...groups[1]!, sessionIds: ['s3', 's2'] },
    ])
  })

  test('Given 会话已在当前分组 When 从成员选择器取消 Then 会话回到未分组', () => {
    expect(toggleSessionInCustomGroup(groups, 's1', 'design')).toEqual([
      { ...groups[0]!, sessionIds: ['s2'] },
      groups[1]!,
    ])
  })

  test('Given 存在失效会话 ID When 组织可见会话 Then 分组按当前列表排序且其余会话保持未分组', () => {
    const result = groupWorkSidebarSessions(
      [{ session: { id: 's3' } }, { session: { id: 's1' } }, { session: { id: 's4' } }],
      [
        { ...groups[0]!, sessionIds: ['missing', 's1'] },
        groups[1]!,
      ],
    )

    expect(result.groups.map(({ group, items }) => ({ id: group.id, ids: items.map((item) => item.session.id) }))).toEqual([
      { id: 'design', ids: ['s1'] },
      { id: 'build', ids: ['s3'] },
    ])
    expect(result.ungrouped.map((item) => item.session.id)).toEqual(['s4'])
  })
})

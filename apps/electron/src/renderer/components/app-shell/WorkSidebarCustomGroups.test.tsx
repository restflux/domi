import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkSidebarPreferences } from '../../../types'
import { WorkSidebarCustomGroups } from './WorkSidebarCustomGroups.tsx'

const items = [
  { session: { id: 's1', title: '会话一' } },
  { session: { id: 's2', title: '会话二' } },
]
const preferences: WorkSidebarPreferences = {
  sectionMode: 'groups',
  groupMode: 'timeline',
  sortMode: 'updated',
  customGroups: [],
}

function renderGroups(overrides: Partial<WorkSidebarPreferences> = {}): string {
  return renderToStaticMarkup(
    <WorkSidebarCustomGroups
      preferences={{ ...preferences, ...overrides }}
      items={items}
      onChange={() => {}}
      renderItem={(item) => <div data-test-session={item.session.id}>{item.session.title}</div>}
    />,
  )
}

describe('Work 会话分组留白', () => {
  test('Given 没有自定义分组 When 展示未分组会话 Then 沿用列表外层边距、不叠加横向留白', () => {
    const html = renderGroups()

    expect(html).toStartWith('<div class="pb-2"><div class="flex flex-col gap-0.5">')
    expect(html).toContain('data-test-session="s1"')
    expect(html).toContain('data-test-session="s2"')
    expect(html).toContain('draggable="true"')
  })

  test('Given 存在自定义分组 When 展开分组 Then 只缩进组内会话、未分组行保持原对齐', () => {
    const html = renderGroups({
      customGroups: [{ id: 'g1', name: '设计', color: 'blue', collapsed: false, sessionIds: ['s1'] }],
    })

    expect(html).toStartWith('<div class="pb-2">')
    expect(html).toContain('relative ml-3.5 pl-2')
    expect(html).toContain('>设计</button>')
    expect(html).toContain('data-test-session="s1"')
    expect(html).toContain('<div class="flex flex-col gap-0.5"><div draggable="true"><div data-test-session="s2"')
  })

  test('Given 收起分组 When 渲染列表 Then 隐藏组内会话、不影响未分组会话', () => {
    const html = renderGroups({
      customGroups: [{ id: 'g1', name: '设计', color: 'blue', collapsed: true, sessionIds: ['s1'] }],
    })

    expect(html).not.toContain('data-test-session="s1"')
    expect(html).toContain('data-test-session="s2"')
    expect(html).toContain('title="展开分组"')
  })

  test('Given 时间线视图 When 日期标题吸顶 Then 使用工具栏的实际高度且分区留白一致', () => {
    const source = readFileSync(new URL('./LeftSidebar.tsx', import.meta.url), 'utf8')

    expect(source).toContain('[--work-sidebar-sticky-controls-height:2.25rem]')
    expect(source).toContain('top-[var(--work-sidebar-sticky-controls-height)]')
    expect(source).toContain('h-[var(--work-sidebar-sticky-controls-height)]')
    expect(source).toContain('className="mb-2 last:mb-0"')
  })
})

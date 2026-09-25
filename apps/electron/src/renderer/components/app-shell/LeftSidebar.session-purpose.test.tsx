import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentSessionMeta } from '@domi/shared'
import { TooltipProvider } from '@/components/ui/tooltip'
import { agentSessionsAtom, agentWorkspacesAtom, currentAgentSessionIdAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { activeTabIdAtom, sidebarCollapsedAtom, tabsAtom } from '@/atoms/tab-atoms'
import { sidebarViewModeAtom, workSidebarPreferencesAtom } from '@/atoms/sidebar-atoms'
import { interfaceVariantAtom, themeModeAtom } from '@/atoms/theme'
import { activeViewAtom } from '@/atoms/active-view'
import { LeftSidebar } from './LeftSidebar'

function session(id: string, overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return { id, title: `用途测试-${id}`, workspaceId: 'workspace', createdAt: Date.now(), updatedAt: Date.now(), ...overrides }
}

const sessions = [
  session('parent', { pinned: true }),
  session('delegate', { parentSessionId: 'parent', sourceDelegationId: 'delegation' }),
  session('ordinary'),
  session('title-only', { title: '侧聊 · 辅助问答' }),
  session('archive', { archived: true }),
  session('side-root', { sideChatParentSessionId: 'parent' }),
  session('side-pinned', { sideChatParentSessionId: 'parent', pinned: true }),
  session('side-archive', { sideChatParentSessionId: 'parent', archived: true }),
  session('side-delegated', {
    sideChatParentSessionId: 'parent', parentSessionId: 'parent', sourceDelegationId: 'side-delegation',
  }),
]

function renderSidebar(archived = false, collapsed = false, groupMode: 'project' | 'timeline' = 'project', quietLight = false, view: 'planning' | 'agent-skills' | null = null): string {
  const store = createStore()
  store.set(appModeAtom, 'agent')
  store.set(interfaceVariantAtom, quietLight ? 'modern' : 'classic')
  if (quietLight) store.set(themeModeAtom, 'light')
  if (view) store.set(activeViewAtom, view)
  store.set(agentSessionsAtom, sessions)
  store.set(agentWorkspacesAtom, [{ id: 'workspace', name: '测试项目', slug: 'workspace', createdAt: 1, updatedAt: 2 }])
  store.set(currentAgentWorkspaceIdAtom, 'workspace')
  store.set(currentAgentSessionIdAtom, 'delegate')
  store.set(tabsAtom, [{ id: 'delegate', sessionId: 'delegate', title: '用途测试-delegate', type: 'agent' }])
  store.set(activeTabIdAtom, 'delegate')
  store.set(sidebarViewModeAtom, archived ? 'archived' : 'active')
  store.set(sidebarCollapsedAtom, collapsed)
  store.set(workSidebarPreferencesAtom, { ...store.get(workSidebarPreferencesAtom), groupMode })
  const html = renderToStaticMarkup(
    <Provider store={store}><TooltipProvider><LeftSidebar width={260} /></TooltipProvider></Provider>,
  )
  expect(store.get(agentSessionsAtom)).toEqual(sessions)
  return html
}

describe('LeftSidebar 侧聊用途隔离', () => {
  for (const groupMode of ['project', 'timeline'] as const) {
    test(`Given ${groupMode} 分组 When 渲染导航 Then 隐藏侧聊但保留普通协作与同名会话`, () => {
      const html = renderSidebar(false, false, groupMode)
      expect(html).toContain('用途测试-parent')
      expect(html).toContain('用途测试-ordinary')
      expect(html).toContain('侧聊 · 辅助问答')
      expect(html).toContain('用途测试-delegate')
      expect(html).toContain('收起子会话')
      expect(html).toContain('>0/1<')
      expect(html).not.toContain('用途测试-side-')
    })
  }

  test('Given 归档侧聊 When 渲染归档 Then 仅显示并计数普通归档会话', () => {
    const html = renderSidebar(true)
    expect(html).toContain('用途测试-archive')
    expect(html).not.toContain('用途测试-side-')
    expect(renderSidebar()).toContain('已归档 (1)')
  })

  test('浅色现代侧栏收起次级入口，打开规划页时仍保持对应入口可见', () => {
    const quiet = renderSidebar(false, false, 'project', true)
    expect(quiet).toContain('更多工具')
    expect(quiet).toContain('aria-expanded="false"')
    expect(quiet).toMatch(/id="sidebar-secondary-links"[^>]*hidden=""/)

    const planning = renderSidebar(false, false, 'project', true, 'planning')
    expect(planning).toContain('aria-expanded="true"')
    expect(planning).not.toMatch(/id="sidebar-secondary-links"[^>]*hidden=""/)
  })

  test('默认浅色把 Work／Chat 收进品牌菜单并提前展示项目，其余主题保留模式切换轨道', () => {
    const quiet = renderSidebar(false, false, 'project', true)
    const classic = renderSidebar()
    expect(quiet).toContain('aria-label="当前为 Work，切换工作模式"')
    expect(quiet).toContain('sidebar-quiet-mode-trigger')
    expect(quiet).toContain('sidebar-quiet-new-session')
    expect(quiet).toContain('sidebar-quiet-workspace-name')
    expect(quiet.indexOf('新会话')).toBeLessThan(quiet.indexOf('更多工具'))
    expect(quiet).not.toContain('mode-switcher-track')
    expect(classic).toContain('mode-switcher-track')
    expect(classic).not.toContain('sidebar-quiet-header')
    const css = readFileSync(resolve(import.meta.dir, '../../styles/globals.css'), 'utf8')
    expect(css).toContain('container: sidebar-quiet / inline-size;')
    expect(css).toContain('@container sidebar-quiet (max-width: 220px)')
  })

  test('Given 折叠侧栏 When 渲染最近会话 Then 不显示侧聊', () => {
    const html = renderSidebar(false, true)
    expect(html).toContain('用途测试-parent')
    expect(html).not.toContain('用途测试-side-')
  })
})

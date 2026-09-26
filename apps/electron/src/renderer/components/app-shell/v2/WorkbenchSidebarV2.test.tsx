import { expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { agentSessionsAtom, agentWorkspacesAtom, currentAgentSessionIdAtom, currentAgentWorkspaceIdAtom } from '@/atoms/agent-atoms'
import { appModeAtom } from '@/atoms/app-mode'
import { interfaceVariantAtom } from '@/atoms/theme'
import { activeTabIdAtom, sidebarCollapsedAtom, tabsAtom } from '@/atoms/tab-atoms'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WorkbenchSidebarV2 } from './WorkbenchSidebarV2'

test('Given v2 When expanding and collapsing Then project navigation keeps the same Jotai sessions', () => {
  const store = createStore()
  const sessions = [{ id: 'v2-session', title: '移植测试会话', workspaceId: 'workspace', createdAt: 1, updatedAt: 1 }]
  store.set(interfaceVariantAtom, 'workbench-v2')
  store.set(appModeAtom, 'agent')
  store.set(agentSessionsAtom, sessions)
  store.set(agentWorkspacesAtom, [{ id: 'workspace', slug: 'workspace', name: '移植测试项目', createdAt: 1, updatedAt: 1 }])
  store.set(currentAgentWorkspaceIdAtom, 'workspace')
  store.set(currentAgentSessionIdAtom, 'v2-session')
  store.set(tabsAtom, [{ id: 'v2-session', sessionId: 'v2-session', title: '移植测试会话', type: 'agent' }])
  store.set(activeTabIdAtom, 'v2-session')
  const render = (): string => renderToStaticMarkup(
    <Provider store={store}><TooltipProvider><WorkbenchSidebarV2 width={280} /></TooltipProvider></Provider>,
  )
  const expanded = render()
  expect(expanded).toContain('data-workbench-v2-sidebar="true"')
  expect(expanded).toContain('移植测试项目')
  expect(expanded).toContain('移植测试会话')
  store.set(sidebarCollapsedAtom, true)
  const collapsed = render()
  expect(collapsed).toContain('aria-label="展开工作区侧栏"')
  expect(collapsed).not.toContain('移植测试会话')
  expect(store.get(agentSessionsAtom)).toEqual(sessions)
})

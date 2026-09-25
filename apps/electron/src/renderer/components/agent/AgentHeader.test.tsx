import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  agentSessionsAtom,
  agentWorkspacesAtom,
  agentStreamingStatesAtom,
  allPendingAskUserRequestsAtom,
} from '@/atoms/agent-atoms'
import { AgentHeader } from './AgentHeader.tsx'

function renderHeader(options: { showStatus?: boolean; statusWorking?: boolean; blocked?: boolean } = {}): string {
  const store = createStore()
  store.set(agentSessionsAtom, [{
    id: 'session-1',
    title: '这个标题只应该出现在标签页',
    workspaceId: 'workspace-1',
    createdAt: 1,
    updatedAt: 2,
  }])
  store.set(agentWorkspacesAtom, [{
    id: 'workspace-1',
    slug: 'demo',
    name: 'Demo',
    createdAt: 1,
    updatedAt: 2,
  }])
  if (options.blocked) {
    store.set(agentStreamingStatesAtom, new Map([['session-1', { running: true, toolActivities: [] }]]))
    store.set(allPendingAskUserRequestsAtom, new Map([['session-1', [{ requestId: 'ask-1', sessionId: 'session-1', questions: [], toolInput: {} }]]]))
  }

  return renderToStaticMarkup(
    <Provider store={store}>
      <AgentHeader sessionId="session-1" statusWorking={options.statusWorking} onOpenStatus={options.showStatus ? () => {} : undefined} />
    </Provider>,
  )
}

describe('AgentHeader', () => {
  test('把标签页作为唯一标题位置，并保留当前会话操作入口', () => {
    const html = renderHeader()

    expect(html).toContain('data-session-toolbar="agent"')
    expect(html).toContain('aria-label="更多会话操作"')
    expect(html).toContain('aria-label="打开会话树"')
    expect(html).not.toContain('data-agent-status-shortcut="header"')
    expect(html).not.toContain('这个标题只应该出现在标签页')
    expect(html).not.toContain('aria-label="编辑标题"')
  })

  test('现代界面顶部状态入口始终可达，运行和阻塞时给出可读名称及状态点', () => {
    const idle = renderHeader({ showStatus: true })
    const running = renderHeader({ showStatus: true, statusWorking: true })
    const blocked = renderHeader({ showStatus: true, blocked: true })
    expect(idle).toContain('data-agent-status-shortcut="header"')
    expect(idle).toContain('aria-label="会话状态与耗时"')
    expect(running).toContain('aria-label="会话状态：运行中"')
    expect(blocked).toContain('aria-label="会话状态：需要处理"')
    expect(blocked).toContain('bg-amber-500')
    expect(blocked.indexOf('data-agent-status-shortcut="header"')).toBeLessThan(blocked.indexOf('aria-label="更多会话操作"'))
  })
})

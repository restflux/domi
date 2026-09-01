import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  agentSessionsAtom,
  agentWorkspacesAtom,
} from '@/atoms/agent-atoms'
import { AgentHeader } from './AgentHeader.tsx'

function renderHeader(): string {
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

  return renderToStaticMarkup(
    <Provider store={store}>
      <AgentHeader sessionId="session-1" />
    </Provider>,
  )
}

describe('AgentHeader', () => {
  test('把标签页作为唯一标题位置，并保留当前会话操作入口', () => {
    const html = renderHeader()

    expect(html).toContain('data-session-toolbar="agent"')
    expect(html).toContain('aria-label="更多会话操作"')
    expect(html).toContain('aria-label="打开会话树"')
    expect(html).not.toContain('这个标题只应该出现在标签页')
    expect(html).not.toContain('aria-label="编辑标题"')
  })
})

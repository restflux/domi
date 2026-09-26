import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { agentSessionsAtom, agentWorkspacesAtom } from '@/atoms/agent-atoms'
import { interfaceVariantAtom } from '@/atoms/theme'
import { AgentHeader } from './AgentHeader.tsx'

function renderHeader(classic = false): string {
  const store = createStore()
  store.set(interfaceVariantAtom, classic ? 'classic' : 'modern')
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
      <AgentHeader sessionId="session-1" onToggleSessionTree={() => {}} />
    </Provider>,
  )
}

describe('AgentHeader', () => {
  test('现代界面顶部只保留环境和更多菜单，标题由标签页承载', () => {
    const html = renderHeader()
    expect(html).toContain('data-session-toolbar="agent"')
    expect(html).toContain('aria-label="更多会话操作"')
    expect(html).not.toContain('aria-label="打开会话树"')
    expect(html).not.toContain('aria-label="打开生成图片画廊"')
    expect(html).not.toContain('data-agent-status-shortcut="header"')
    expect(html).not.toContain('这个标题只应该出现在标签页')
  })

  test('经典界面保留原有图片和会话树按钮', () => {
    const html = renderHeader(true)
    expect(html).toContain('aria-label="打开会话树"')
    expect(html).toContain('aria-label="打开生成图片画廊"')
  })
})

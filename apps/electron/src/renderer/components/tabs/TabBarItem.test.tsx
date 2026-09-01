import { describe, expect, test } from 'bun:test'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { interfaceVariantAtom } from '@/atoms/theme.ts'
import { TabBarItem, type TabBarItemProps } from './TabBarItem.tsx'

const noop = (): void => {}

function renderAgentTab(overrides: Partial<TabBarItemProps> = {}): string {
  const store = createStore()
  store.set(interfaceVariantAtom, 'modern')

  return renderToStaticMarkup(
    <Provider store={store}>
      <TabBarItem
        id="session-1"
        type="agent"
        title="优化顶部标签"
        workspaceName="domi"
        isActive
        isStreaming="idle"
        isHovered={false}
        isLeaving={false}
        onActivate={noop}
        onClose={noop}
        onMiddleClick={noop}
        onDragStart={noop}
        onHoverEnter={noop}
        onHoverLeave={noop}
        onPanelHoverEnter={noop}
        onPanelHoverLeave={noop}
        {...overrides}
      />
    </Provider>,
  )
}

describe('TabBarItem 会话语义图标', () => {
  test('普通 Work 会话使用固定语义图标槽并保留行内工作区元信息', () => {
    const html = renderAgentTab()

    expect(html).toContain('data-tab-semantic-icon="agent"')
    expect(html).toContain('lucide-message-square-text')
    expect(html).toContain('workspace-tab-meta')
    expect(html).toContain('>·<')
  })

  test('当前活动 Work 标签可隐藏关闭入口而不改变原有标签布局', () => {
    const html = renderAgentTab({ closable: false })

    expect(html).not.toContain('lucide-x')
    expect(html).toContain('app-tab-active')
  })

  test('运行、自动任务和委派会话复用同一个图标槽', () => {
    const running = renderAgentTab({ isStreaming: 'running' })
    const automation = renderAgentTab({ isAutomation: true })
    const delegation = renderAgentTab({ isDelegation: true })

    expect(running).toContain('data-tab-semantic-icon="running"')
    expect(running).not.toContain('lucide-message-square-text')
    expect(automation).toContain('data-tab-semantic-icon="automation"')
    expect(automation).toContain('lucide-clock')
    expect(delegation).toContain('data-tab-semantic-icon="delegation"')
    expect(delegation).toContain('lucide-git-branch')
  })
})

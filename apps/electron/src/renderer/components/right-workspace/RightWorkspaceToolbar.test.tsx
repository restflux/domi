import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { RightWorkspaceToolbar, type RightWorkspaceToolbarTab } from './RightWorkspaceToolbar.tsx'

const noop = (): void => undefined

const BASE_TABS: RightWorkspaceToolbarTab[] = [
  { id: 'files', tool: 'files', label: '文件', closeable: false },
  { id: 'changes', tool: 'changes', label: '改动', closeable: false },
]

function renderToolbar(
  activeTabId: RightWorkspaceToolbarTab['id'],
  expanded: boolean,
  tabs: RightWorkspaceToolbarTab[] = BASE_TABS,
): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <RightWorkspaceToolbar
        tabs={tabs}
        activeTabId={activeTabId}
        scratchVisible={tabs.some((tab) => tab.id === 'scratch')}
        hasUnseenChanges={false}
        expandAvailable
        expanded={expanded}
        onTabChange={noop}
        onCloseTab={noop}
        onAddBrowser={noop}
        onShowScratch={noop}
        onToggleExpand={noop}
      />
    </TooltipProvider>,
  )
}

describe('RightWorkspaceToolbar 标签入口', () => {
  test('文件与改动固定，草稿和多个浏览器各自拥有标签级关闭入口', () => {
    const tabs: RightWorkspaceToolbarTab[] = [
      ...BASE_TABS,
      { id: 'scratch', tool: 'scratch', label: '草稿', closeable: true },
      { id: 'browser:first', tool: 'browser', label: '浏览器 1', closeable: true },
      { id: 'browser:second', tool: 'browser', label: '浏览器 2', closeable: true },
    ]
    const html = renderToolbar('browser:second', false, tabs)

    expect(html).toContain('aria-label="文件"')
    expect(html).toContain('aria-label="改动"')
    expect(html).not.toContain('aria-label="关闭文件"')
    expect(html).not.toContain('aria-label="关闭改动"')
    expect(html).toContain('aria-label="关闭草稿"')
    expect(html).toContain('aria-label="关闭浏览器 1"')
    expect(html).toContain('aria-label="关闭浏览器 2"')
    expect(html).toContain('aria-label="添加工具"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('data-placement="inline"')
  })

  test('展开入口使用面向用户的展开与恢复分栏文案', () => {
    const collapsedHtml = renderToolbar('files', false)
    const expandedHtml = renderToolbar('files', true)

    expect(collapsedHtml).toContain('aria-label="展开到主区域"')
    expect(collapsedHtml).toContain('aria-pressed="false"')
    expect(expandedHtml).toContain('aria-label="恢复分栏"')
    expect(expandedHtml).toContain('aria-pressed="true"')
    expect(collapsedHtml).not.toContain('聚焦')
    expect(expandedHtml).not.toContain('聚焦')
  })
})

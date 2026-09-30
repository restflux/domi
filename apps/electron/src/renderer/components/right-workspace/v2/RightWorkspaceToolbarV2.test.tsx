import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { RightWorkspaceToolbarV2 } from './RightWorkspaceToolbarV2'

const noop = (): void => undefined

test('Given 用户按需打开文件与改动 When 渲染 v2 标签 Then 它们与浏览器和终端都可独立关闭', () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <RightWorkspaceToolbarV2
        tabs={[
          { id: 'session-files', tool: 'session-files', label: '会话文件', closeable: true },
          { id: 'files', tool: 'files', label: '文件', closeable: true },
          { id: 'changes', tool: 'changes', label: '改动', closeable: true },
          { id: 'terminal:one', tool: 'terminal', label: '终端 A', closeable: true },
          { id: 'browser:one', tool: 'browser', label: '浏览器 A', closeable: true },
        ]}
        activeTabId="browser:one"
        scratchVisible={false}
        hasUnseenChanges={false}
        expandAvailable
        expanded={false}
        onTabChange={noop}
        onCloseTab={noop}
        onAddBrowser={noop}
        onOpenTerminal={noop}
        onOpenSessionFiles={noop}
        onOpenFiles={noop}
        onOpenChanges={noop}
        onShowScratch={noop}
        onToggleExpand={noop}
        onCloseWorkspace={noop}
      />
    </TooltipProvider>,
  )
  expect(html).toContain('aria-label="关闭浏览器 A"')
  expect(html).toContain('aria-label="关闭终端 A"')
  expect(html).toContain('aria-label="关闭会话文件"')
  expect(html).toContain('aria-label="关闭文件"')
  expect(html).toContain('aria-label="关闭改动"')
  expect(html).toContain('aria-label="添加工具"')
  expect(html).toContain('aria-label="展开到主区域"')
  expect(html).toContain('aria-label="关闭右侧工作区"')
})

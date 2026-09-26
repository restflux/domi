import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { RightWorkspaceToolbarV2 } from './RightWorkspaceToolbarV2'

const noop = (): void => undefined

test('Given v2 tool tabs When rendering Then files remain fixed and browser/terminal stay independently closeable', () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <RightWorkspaceToolbarV2
        tabs={[
          { id: 'files', tool: 'files', label: '文件', closeable: false },
          { id: 'changes', tool: 'changes', label: '改动', closeable: false },
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
        onShowScratch={noop}
        onToggleExpand={noop}
      />
    </TooltipProvider>,
  )
  expect(html).toContain('aria-label="关闭浏览器 A"')
  expect(html).toContain('aria-label="关闭终端 A"')
  expect(html).not.toContain('aria-label="关闭文件"')
  expect(html).toContain('aria-label="添加工具"')
  expect(html).toContain('aria-label="展开到主区域"')
})

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { RightWorkspaceTitlebarDragRegion } from './RightWorkspaceTitlebarDragRegion.tsx'

describe('RightWorkspaceTitlebarDragRegion', () => {
  test('Windows 仅将顶部空白设为拖拽区，并避让窗口控制按钮', () => {
    const html = renderToStaticMarkup(
      <RightWorkspaceTitlebarDragRegion isWindows />,
    )

    expect(html).toContain('h-[34px]')
    expect(html).toContain('right-[126px]')
    expect(html).toContain('titlebar-drag-region')
    expect(html).toContain('data-right-workspace-titlebar-drag-region')
  })

  test('非 Windows 的顶部拖拽区可以延伸到面板右侧', () => {
    const html = renderToStaticMarkup(
      <RightWorkspaceTitlebarDragRegion isWindows={false} />,
    )

    expect(html).toContain('right-0')
    expect(html).not.toContain('right-[126px]')
  })
})

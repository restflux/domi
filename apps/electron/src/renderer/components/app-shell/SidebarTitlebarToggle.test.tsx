import { expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SidebarTitlebarToggle } from './SidebarTitlebarToggle'

function render(isMac: boolean, collapsed: boolean, previewActive = false): string {
  return renderToStaticMarkup(<SidebarTitlebarToggle isMac={isMac} collapsed={collapsed} previewActive={previewActive} onToggle={() => {}} />)
}

test('Given macOS 展开、折叠、预览 When 切换 Then 按钮始终位于红绿灯右侧的同一命中区', () => {
  for (const [collapsed, previewActive, label] of [
    [false, false, '收起侧边栏'],
    [true, false, '展开侧边栏'],
    [true, true, '固定展开侧边栏'],
  ] as const) {
    const html = render(true, collapsed, previewActive)
    expect(html).toContain('titlebar-drag-region fixed left-0 top-0 z-[90] h-[46px] w-[128px]')
    expect(html).toContain('titlebar-no-drag absolute top-[9px]')
    expect(html).toContain('left-[88px]')
    expect(html).toContain(`aria-label="${label}"`)
    expect(html).toContain(`aria-expanded="${!collapsed || previewActive}"`)
    expect(html).toContain('aria-controls="modern-left-sidebar"')
  }
})

test('Given Windows/Linux 现代界面 When 顶栏呈现 Then 单独保留左侧可点入口并避开首个侧栏导航', () => {
  const html = render(false, true)
  expect(html).toContain('w-[48px]')
  expect(html).toContain('left-[10px]')
  expect(html).not.toContain('left-[88px]')
})

test('Given 顶栏按钮 When 触发单击 Then 调用唯一开合操作', () => {
  let clicks = 0
  const element = SidebarTitlebarToggle({ isMac: true, collapsed: true, previewActive: false, onToggle: () => { clicks += 1 } })
  const button = React.Children.only(element.props.children) as React.ReactElement<React.ButtonHTMLAttributes<HTMLButtonElement>>
  button.props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
  expect(clicks).toBe(1)
})

import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SidePaneOpenTabLauncher } from './SidePaneOpenTabLauncher.tsx'

describe('v2 右侧工作区', () => {
  test('没有工具标签时展示 ZCode 式打开标签页，不以旧文件和改动面板冒充默认工作区', () => {
    const html = renderToStaticMarkup(createElement(SidePaneOpenTabLauncher, {
      onOpenBrowser: () => undefined,
      onOpenTerminal: () => undefined,
    }))
    expect(html).toContain('side-pane-open-tab-shell')
    expect(html).toContain('data-side-pane-open-tab-item="terminal"')
    expect(html).toContain('data-side-pane-open-tab-item="browser"')
    expect(html).not.toContain('>文件<')
    expect(html).not.toContain('>改动<')
  })
})

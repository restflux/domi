import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SidePaneOpenTabLauncher } from './SidePaneOpenTabLauncher.tsx'

describe('v2 右侧工作区', () => {
  test('没有工具标签时展示 ZCode 式打开标签页，不以旧文件和改动面板冒充默认工作区', () => {
    const html = renderToStaticMarkup(createElement(SidePaneOpenTabLauncher, {
      onOpenSessionFiles: () => undefined,
      onOpenFiles: () => undefined,
      onOpenChanges: () => undefined,
      onOpenBrowser: () => undefined,
      onOpenTerminal: () => undefined,
      onShowScratch: () => undefined,
    }))
    expect(html).toContain('side-pane-open-tab-shell')
    expect(html).toContain('data-side-pane-open-tab-item="terminal"')
    expect(html).toContain('data-side-pane-open-tab-item="browser"')
  })

  test('会话文件与文件拆分为独立快捷入口，改动与草稿也可从这里直达', () => {
    const html = renderToStaticMarkup(createElement(SidePaneOpenTabLauncher, {
      onOpenSessionFiles: () => undefined,
      onOpenFiles: () => undefined,
      onOpenChanges: () => undefined,
      onOpenBrowser: () => undefined,
      onOpenTerminal: () => undefined,
      onShowScratch: () => undefined,
    }))
    expect(html).toContain('data-side-pane-open-tab-item="session-files"')
    expect(html).toContain('data-side-pane-open-tab-item="files"')
    expect(html).toContain('data-side-pane-open-tab-item="changes"')
    expect(html).toContain('data-side-pane-open-tab-item="scratch"')
    expect(html).toContain('>会话文件<')
    expect(html).toContain('>文件<')
    expect(html).toContain('>改动<')
    expect(html).toContain('>草稿<')
  })
})

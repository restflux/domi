import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BrowserAddressBar, BROWSER_MORE_ACTIONS, BROWSER_PRIMARY_ACTIONS } from './BrowserAddressBar'

describe('BrowserAddressBar', () => {
  test('Given the compact browser toolbar When arranging primary actions Then expand stays in the shared workspace toolbar', () => {
    expect(BROWSER_PRIMARY_ACTIONS).toEqual([
      'back',
      'forward',
      'reload-stop',
      'address',
      'select-element',
      'more',
    ])
    expect(BROWSER_PRIMARY_ACTIONS).not.toContain('zoom')
    expect(BROWSER_PRIMARY_ACTIONS).not.toContain('close-session')
  })

  test('Given secondary browser controls When arranging the more menu Then zoom fit external and copy stay discoverable', () => {
    expect(BROWSER_MORE_ACTIONS).toEqual([
      'zoom',
      'reset-zoom',
      'fit-width',
      'open-external',
      'copy-url',
    ])
  })

  test('Given a loading browser with element selection active When rendering Then stop and selection states stay accessible', () => {
    const noop = (): void => undefined
    const html = renderToStaticMarkup(createElement(TooltipProvider, null,
      createElement(BrowserAddressBar, {
        url: 'https://example.com',
        loading: true,
        canGoBack: true,
        canGoForward: false,
        zoomPercent: 100,
        fitToWidth: false,
        selectingElement: true,
        onNavigate: noop,
        onBack: noop,
        onForward: noop,
        onReload: noop,
        onStop: noop,
        onZoom: noop,
        onToggleFit: noop,
        onToggleElementSelection: noop,
        onOpenExternal: noop,
      }),
    ))

    expect(html).toContain('aria-label="停止加载"')
    expect(html).not.toContain('aria-label="刷新"')
    expect(html).toContain('aria-label="取消选择网页元素"')
    expect(html).not.toContain('展开到主区域')
    expect(html).not.toContain('恢复分栏')
    expect(html).not.toContain('关闭浏览器')
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(html).toContain('aria-label="更多浏览器操作"')
  })
})

import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { BrowserToolbar, BrowserLoadErrorState } from './EmbeddedBrowserPaneParts.tsx'

const noop = (): void => undefined

describe('ZCode browser controls on Domi Main-owned page', () => {
  test('Given loading page When rendering Then navigation, responsive viewport, stop and selection have actual controls', () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null,
      createElement(BrowserToolbar, {
        page: { pageId: 'page', url: 'https://example.com', title: 'Test', loadState: 'loading', navigationEpoch: 1, canGoBack: true, canGoForward: false, zoomPercent: 125, fitToWidth: true, visible: true },
        disabled: false, selecting: true, responsive: true,
        onNavigate: noop, onBack: noop, onForward: noop, onReload: noop, onStop: noop,
        onZoom: noop, onToggleFit: noop, onSelectElement: noop, onOpenExternal: noop,
        onToggleResponsive: noop,
      }),
    ))
    expect(html).toContain('aria-label="后退"')
    expect(html).toContain('aria-label="停止加载"')
    expect(html).toContain('aria-label="响应式视口"')
    expect(html).toContain('aria-label="取消元素选择"')
    expect(html).toContain('aria-label="更多浏览器操作"')
    expect(html).not.toContain('开发者工具')
  })
  test('Given a certificate failure When rendering Then a retry action and certificate guidance are visible', () => {
    const html = renderToStaticMarkup(createElement(BrowserLoadErrorState, { message: 'CERT_INVALID', onRetry: noop }))
    expect(html).toContain('证书验证失败')
    expect(html).toContain('重试')
  })
})

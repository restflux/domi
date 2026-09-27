import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrowserViewportToolbar } from './BrowserViewportToolbar.tsx'

test('Given responsive browser v2 When its viewport toolbar renders Then dimension drafts expose validation and the existing native-view action', () => {
  const html = renderToStaticMarkup(<BrowserViewportToolbar size={{ width: 390, height: 844 }} onSizeChange={() => undefined} onClose={() => undefined} />)
  expect(html).toContain('data-zcode-viewport-toolbar')
  expect(html).toContain('aria-label="视口宽度"')
  expect(html).toContain('aria-label="视口高度"')
  expect(html).toContain('value="390"')
  expect(html).toContain('退出响应式')
})

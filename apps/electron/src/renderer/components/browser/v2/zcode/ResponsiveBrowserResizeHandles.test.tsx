import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ResponsiveBrowserResizeHandles } from './ResponsiveBrowserResizeHandles.tsx'

test('Given responsive viewport v2 When mounted Then ZCode four edges and four corners are present with keyboard-accessible edge controls', () => {
  const html = renderToStaticMarkup(<ResponsiveBrowserResizeHandles width={390} height={844} onBeginResize={() => undefined} onMove={() => undefined} onEndResize={() => undefined} onResizeKeyDown={() => undefined} />)
  expect(html.match(/data-resize-edge=/g)).toHaveLength(8)
  expect(html.match(/role="separator"/g)).toHaveLength(4)
  expect(html).toContain('data-resize-edge="top-left"')
  expect(html).toContain('data-resize-edge="bottom-right"')
  expect(html).toContain('aria-valuenow="390"')
})

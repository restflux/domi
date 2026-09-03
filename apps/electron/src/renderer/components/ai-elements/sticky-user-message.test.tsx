import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { StickyReturnToQuestionShortcut } from './sticky-user-message'

describe('StickyReturnToQuestionShortcut', () => {
  test('Given the previous question is above the viewport When rendering the shortcut Then it is centered with time and a liquid-glass action', () => {
    const html = renderToStaticMarkup(
      <StickyReturnToQuestionShortcut time="08/31 19:17" onClick={() => undefined} />,
    )

    expect(html).toContain('<button')
    expect(html).toContain('aria-label="返回上一条提问，08/31 19:17"')
    expect(html).toContain('返回上一条提问')
    expect(html).toContain('· 08/31 19:17')
    expect(html).toContain('justify-center')
    expect(html).toContain('backdrop-blur-2xl')
    expect(html).toContain('bg-gradient-to-b')
    expect(html).not.toContain('最近提问')
    expect(html).not.toContain('line-clamp-2')
  })
})

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { StickyReturnToQuestionShortcut } from './sticky-user-message'

describe('StickyReturnToQuestionShortcut', () => {
  test('Given the terminal theme styles When applying the shortcut override Then they preserve the component pill radius', async () => {
    const css = await Bun.file(new URL('../../styles/globals.css', import.meta.url)).text()
    const terminalOverride = css.match(/\.theme-terminal-dark \.sticky-return-question-button \{([^}]*)\}/)?.[1] ?? ''

    expect(terminalOverride).not.toContain('border-radius')
    expect(css).toContain('.theme-terminal-dark [class*="rounded"]:not(.sticky-return-question-button)')
    expect(css).not.toContain('.theme-terminal-dark [class*="rounded"] {')
  })

  test('Given the previous question is above the viewport When rendering the shortcut Then it stays compact without question content on hover or focus', () => {
    const html = renderToStaticMarkup(
      <StickyReturnToQuestionShortcut
        time="08/31 19:17"
        onClick={() => undefined}
      />,
    )

    expect(html).toContain('<button')
    expect(html).toContain('aria-label="返回上一条提问，08/31 19:17"')
    expect(html).toContain('返回上一条提问')
    expect(html).toContain('· 08/31 19:17')
    expect(html).toContain('justify-center')
    expect(html).toContain('backdrop-blur-2xl')
    expect(html).toContain('bg-gradient-to-b')
    expect(html).toContain('w-fit')
    expect(html).toContain('h-8')
    expect(html).toContain('rounded-[18px]')
    expect(html).not.toContain('aria-describedby')
    expect(html).not.toContain('group-hover/shortcut')
    expect(html).not.toContain('group-focus-visible/shortcut')
    expect(html).not.toContain('hover:w-')
    expect(html).not.toContain('focus-visible:w-')
    expect(html).not.toContain('grid-rows-')
  })
})

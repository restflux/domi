import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  buildStickyQuestionPreview,
  StickyReturnToQuestionShortcut,
} from './sticky-user-message'

describe('buildStickyQuestionPreview', () => {
  test('Given a long question with fenced code When building the hover preview Then code is summarized and text is bounded', () => {
    const preview = buildStickyQuestionPreview([
      '请检查下面的实现：',
      '',
      '```ts',
      'const secretImplementation = true',
      '```',
      '',
      '并说明为什么。'.repeat(80),
    ].join('\n'))

    expect(preview).toContain('[代码]')
    expect(preview).not.toContain('secretImplementation')
    expect(preview.endsWith('…')).toBe(true)
    expect(preview.length).toBeLessThanOrEqual(241)
  })
})

describe('StickyReturnToQuestionShortcut', () => {
  test('Given the terminal theme styles When applying the shortcut override Then they preserve the component pill radius', async () => {
    const css = await Bun.file(new URL('../../styles/globals.css', import.meta.url)).text()
    const terminalOverride = css.match(/\.theme-terminal-dark \.sticky-return-question-button \{([^}]*)\}/)?.[1] ?? ''

    expect(terminalOverride).not.toContain('border-radius')
    expect(css).toContain('.theme-terminal-dark [class*="rounded"]:not(.sticky-return-question-button)')
    expect(css).not.toContain('.theme-terminal-dark [class*="rounded"] {')
  })

  test('Given the previous question is above the viewport When rendering the shortcut Then the compact capsule expands into one shared glass surface', () => {
    const html = renderToStaticMarkup(
      <StickyReturnToQuestionShortcut
        time="08/31 19:17"
        preview="请把返回提问入口改得更紧凑一些"
        attachmentCount={2}
        userName="Wlait"
        userAvatar="🧑‍💻"
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
    expect(html).toContain('请把返回提问入口改得更紧凑一些')
    expect(html).toContain('2 个附件')
    expect(html).toContain('Wlait')
    expect(html).toContain('🧑‍💻')
    expect(html).toContain('line-clamp-3')
    expect(html).toContain('w-fit')
    expect(html).toContain('hover:w-[380px]')
    expect(html).not.toContain('w-[420px]')
    expect(html).toContain('[interpolate-size:allow-keywords]')
    expect(html).toContain('h-8')
    expect(html).toContain('px-3')
    expect(html).toContain('size-6')
    expect(html).toContain('leading-5')
    expect(html).toContain('rounded-[18px]')
    expect(html).not.toContain('rounded-full')
    expect(html).not.toContain('rounded-[20px]')
    expect(html).not.toContain('transition-[max-width,border-radius')
    expect(html).not.toContain('hover:rounded')
    expect(html).not.toContain('focus-visible:rounded')
    expect(html).not.toContain('border-t')
    expect(html).toContain('w-0 grid-rows-[0fr]')
    expect(html).toContain('group-hover/shortcut:w-full')
    expect(html).toContain('group-hover/shortcut:grid-rows-[1fr]')
    expect(html).toContain('group-focus-visible/shortcut:grid-rows-[1fr]')
    expect(html).toContain('delay-150')
    expect(html).not.toContain('role="tooltip"')
    expect(html).not.toContain('sticky-question-preview')
    expect(html).not.toContain('最近提问')
  })
})

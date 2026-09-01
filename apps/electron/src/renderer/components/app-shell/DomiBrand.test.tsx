import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DomiBrandLockup, DomiBrandMark } from './DomiBrand.tsx'

describe('DomiBrand', () => {
  test('直接呈现彩色品牌图，不再使用主题色蒙版', () => {
    const html = renderToStaticMarkup(<DomiBrandMark className="size-8" />)

    expect(html).toContain('<img')
    expect(html).toContain('domi-brand-mark')
    expect(html).not.toContain('mask-image')
    expect(html).not.toContain('bg-primary')
  })

  test('组合标使用小写 domi，并保持图文间距', () => {
    const html = renderToStaticMarkup(<DomiBrandLockup />)

    expect(html).toContain('gap-2')
    expect(html).toContain('aria-label="domi"')
    expect(html).toContain('domi-wordmark')
    expect(html).toContain('mask-image')
    // 字标本身是蒙版图而非文本样式；AI 铭牌是独立元素，允许使用自己的字重
    const wordmarkTag = /<span[^>]*domi-wordmark[^>]*>/.exec(html)?.[0] ?? ''
    expect(wordmarkTag).not.toBe('')
    expect(wordmarkTag).not.toContain('font-semibold')
  })
})

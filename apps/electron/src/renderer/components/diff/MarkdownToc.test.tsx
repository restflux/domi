import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createStore } from 'jotai'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { markdownTocPinnedAtom } from '@/atoms/markdown-toc.ts'
import { MarkdownToc } from './MarkdownToc.tsx'

function renderToc(pinned: boolean): string {
  const containerRef = React.createRef<HTMLElement>()

  return renderToStaticMarkup(
    <TooltipProvider>
      <MarkdownToc
        containerRef={containerRef}
        contentKey="test-content"
        enabled
        pinned={pinned}
        onPinnedChange={() => {}}
      />
    </TooltipProvider>,
  )
}

describe('MarkdownToc', () => {
  test('默认不固定目录，避免占用 Markdown 正文宽度', () => {
    const store = createStore()

    expect(store.get(markdownTocPinnedAtom)).toBe(false)
  })

  test('未固定时仅由目录按钮和浮层响应鼠标，左侧空白区域不会触发展开', () => {
    const html = renderToc(false)

    expect(html).toContain('data-markdown-toc-mode="floating"')
    expect(html).toContain('data-markdown-toc-floating-root="true"')
    expect(html).toContain('data-markdown-toc-trigger-scope="button"')
    expect(html).toContain('data-markdown-toc-trigger="true"')
    expect(html).toContain('aria-label="悬浮目录"')
    expect(html).toContain('aria-label="固定目录"')
    expect(html).toContain('pointer-events-none')
    expect(html).toContain('pointer-events-auto')
    expect(html).toContain('group-hover/markdown-toc:pointer-events-auto')
    expect(html).not.toContain('data-markdown-toc-reserves-space="true"')
  })

  test('固定后保持占位侧栏，并允许取消固定', () => {
    const html = renderToc(true)

    expect(html).toContain('data-markdown-toc-mode="pinned"')
    expect(html).toContain('data-markdown-toc-reserves-space="true"')
    expect(html).toContain('aria-label="取消固定目录"')
    expect(html).toContain('w-52')
    expect(html).toContain('shrink-0')
    expect(html).not.toContain('aria-label="悬浮目录"')
  })
})

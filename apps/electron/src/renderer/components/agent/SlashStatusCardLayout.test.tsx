import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  SLASH_STATUS_DIALOG_CLASS,
  SLASH_STATUS_GRID_CLASS,
  SLASH_STATUS_OVERVIEW_CLASS,
  SLASH_STATUS_SCROLL_CLASS,
} from './SlashStatusCard.tsx'

describe('SlashStatusCard layout', () => {
  test('keeps a stable, moderate inspector height while fitting short viewports', () => {
    expect(SLASH_STATUS_DIALOG_CLASS).toContain('h-[720px]')
    expect(SLASH_STATUS_DIALOG_CLASS).toContain('max-h-[calc(100vh-32px)]')
    expect(SLASH_STATUS_DIALOG_CLASS).toContain('w-[calc(100vw-32px)]')
    expect(SLASH_STATUS_DIALOG_CLASS).toContain('max-w-[900px]')
    expect(SLASH_STATUS_DIALOG_CLASS).toContain('overflow-hidden')
    expect(SLASH_STATUS_DIALOG_CLASS).not.toContain('max-w-md')
  })

  test('falls back to one column and promotes a non-equal desktop inspector grid', () => {
    expect(SLASH_STATUS_GRID_CLASS).toContain('grid-cols-1')
    expect(SLASH_STATUS_GRID_CLASS).toContain('md:grid-cols-[270px_minmax(0,1fr)]')
    expect(SLASH_STATUS_OVERVIEW_CLASS).toContain('md:sticky')
    expect(SLASH_STATUS_OVERVIEW_CLASS).toContain('md:top-0')
  })

  test('shows completed provider input, output, cache and request usage as explicit session cumulative metrics', () => {
    const source = readFileSync(resolve(import.meta.dir, 'SlashStatusCard.tsx'), 'utf8')

    expect(source).toContain('<Row label="累计输入">')
    expect(source).toContain('<Row label="累计输出">')
    expect(source).toContain('<Row label="模型请求">')
    expect(source).toContain('formatAgentUsageTokens(sessionUsage.inputTokens)')
    expect(source).toContain('formatAgentUsageTokens(sessionUsage.outputTokens)')
    expect(source).toContain('非缓存 ${sessionUsage.uncachedInputTokens.toLocaleString()}')
    expect(source).toContain('缓存读取 ${sessionUsage.cacheReadTokens.toLocaleString()}')
    expect(source).toContain('不包含当前上下文占用或实时估算')
    expect(source).toContain('className="tabular-nums"')
  })

  test('uses one modal body scroll container without a separate evidence footer', () => {
    expect(SLASH_STATUS_SCROLL_CLASS).toContain('min-h-0')
    expect(SLASH_STATUS_SCROLL_CLASS).toContain('flex-1')
    expect(SLASH_STATUS_SCROLL_CLASS).toContain('overflow-y-auto')

    const source = readFileSync(resolve(import.meta.dir, 'SlashStatusCard.tsx'), 'utf8')
    expect(source).not.toContain('<PiRunTimingEvidenceNotice')
  })
})

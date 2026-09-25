import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentSessionMeta } from '@domi/shared'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { AgentSessionItem } from './LeftSidebar.tsx'

const noop = (): void => {}
const noopAsync = async (): Promise<void> => {}

function renderSessionItem(
  sessionOverrides: Partial<AgentSessionMeta> = {},
  withDelegation = false,
): string {
  const session: AgentSessionMeta = {
    id: 'session-1',
    title: '整理会话标记布局',
    createdAt: 1,
    updatedAt: 2,
    ...sessionOverrides,
  }

  return renderToStaticMarkup(
    <Provider store={createStore()}>
      <TooltipProvider>
        <AgentSessionItem
          session={session}
          active={false}
          indicatorStatus="idle"
          disableMiniMap
          relativeTimeNow={3}
          delegationSummary={withDelegation ? {
            total: 3,
            completed: 2,
            expanded: false,
            onToggle: noop,
          } : undefined}
          onSelect={noop}
          onRequestDelete={noop}
          onRequestMove={noop}
          onRename={noopAsync}
          onTogglePin={noopAsync}
          onToggleStar={noopAsync}
          onToggleArchive={noopAsync}
        />
      </TooltipProvider>
    </Provider>,
  )
}

describe('AgentSessionItem layout', () => {
  test('所有现代主题仅高亮会话、不高亮项目，选中背景随主题前景变化', () => {
    const styles = readFileSync(resolve(import.meta.dir, '../../styles/globals.css'), 'utf8')
    const projectRule = styles.match(/:root\.ui-modern \.agent-project-item-current,[\s\S]*?\}/)?.[0]
    expect(projectRule).toContain('background-color: transparent')
    expect(styles).toContain('.agent-project-session-list .agent-session-item-active-surface::before')
    expect(styles).toContain('background-color: hsl(var(--foreground) / 0.075)')
  })
  test('keeps status and marked Flag/Star in the row without altering their semantics', () => {
    const html = renderSessionItem({ needsFollowUp: true, starred: true })

    expect(html).toMatch(/data-session-status-slot="true"[^>]*\bw-3\.5\b/)
    expect(html).toMatch(/data-session-marker-slot="true"[^>]*data-has-markers="true"/)
    expect(html).toContain('aria-label="取消待继续"')
    expect(html).toContain('aria-label="取消星标"')
    expect(html).toContain('aria-pressed="true"')
  })

  test('keeps update time accessible on the row and preserves actions on hover', () => {
    const html = renderSessionItem()

    expect(html).toContain('data-session-row-meta="true"')
    expect(html).toContain('data-has-markers="false"')
    expect(html).toContain('title="最后更新：')
    expect(html).toContain('data-session-right-slot="true"')
    expect(html).toMatch(/data-session-updated-at="true"[^>]*absolute[^>]*right-0[^>]*group-hover:opacity-0/)
    expect(html).toContain('data-session-inline-archive-action="true"')
    expect(html).toContain('data-session-more-actions="true"')
    expect(html).not.toContain('data-session-delegation-meta="true"')
  })

  test('keeps optional delegation progress left of the fixed marker and timestamp slots', () => {
    const parentHtml = renderSessionItem({}, true)
    const delegationIndex = parentHtml.indexOf('data-session-delegation-meta="true"')
    const markerIndex = parentHtml.indexOf('data-session-marker-slot="true"')
    const rightSlotIndex = parentHtml.indexOf('data-session-right-slot="true"')

    expect(delegationIndex).toBeGreaterThan(-1)
    expect(markerIndex).toBeGreaterThan(delegationIndex)
    expect(rightSlotIndex).toBeGreaterThan(markerIndex)
    expect(parentHtml).toContain('>2/3<')
    expect(parentHtml).toContain('aria-label="展开子会话"')
    expect(parentHtml).toContain('data-session-updated-at="true"')

    const leafHtml = renderSessionItem()
    expect(leafHtml).not.toContain('data-session-delegation-meta="true"')
    expect(leafHtml).toMatch(/data-session-marker-slot="true"[^>]*\bw-8\b/)
    expect(leafHtml).toMatch(/data-session-right-slot="true"[^>]*\bw-12\b/)
  })

  test('keeps archive inline while leaving low-frequency pin in the menus', () => {
    const html = renderSessionItem({ pinned: true })

    expect(html).toContain('data-session-inline-archive-action="true"')
    expect(html).toContain('aria-label="归档"')
    expect(html).toContain('data-session-more-actions="true"')
    expect(html).not.toContain('data-session-inline-pin-action="true"')
  })
})

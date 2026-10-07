import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Provider, createStore } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentSessionMeta } from '@domi/shared'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { AgentSessionItem } from './LeftSidebar.tsx'
import type { SessionIndicatorStatus } from '@/atoms/agent-atoms'

const noop = (): void => {}
const noopAsync = async (): Promise<void> => {}

function renderSessionItem(
  sessionOverrides: Partial<AgentSessionMeta> = {},
  withDelegation = false,
  indicatorStatus: SessionIndicatorStatus = 'idle',
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
          indicatorStatus={indicatorStatus}
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

  test('Given 现代会话列表 When 行处于普通状态 Then 状态留在行内且隐藏操作不占标题宽度', () => {
    const html = renderSessionItem()
    const styles = readFileSync(resolve(import.meta.dir, '../../styles/globals.css'), 'utf8')

    expect(html).toContain('agent-session-row')
    expect(html).toContain('data-actions-visible="false"')
    expect(styles).toMatch(/:root\.ui-modern \.agent-session-row,\s*:root\.ui-modern \.agent-project-session-list \.agent-session-row\s*\{[^}]*min-height: 2rem;[^}]*padding-left: 1\.5rem;/)
    expect(styles).toMatch(/\.agent-session-row \[data-session-status-slot="true"\]\s*\{\s*left: 0\.25rem;/)
    expect(styles).toMatch(/\.agent-session-row \[data-session-row-meta="true"\]\s*\{\s*width: 0;\s*overflow: hidden;/)
  })

  test('Given 按项目视图 When 预留行内状态空间 Then 不再由旧规则叠加静态状态列', () => {
    const styles = readFileSync(resolve(import.meta.dir, '../../styles/globals.css'), 'utf8')

    expect(styles).not.toMatch(/\.agent-project-session-list\s+\[data-session-status-slot="true"\]\s*\{[^}]*position:\s*static/)
    expect(styles).not.toMatch(/\.agent-project-session-list\s+\[data-session-status-slot="true"\]\s*\{[^}]*transform:\s*none/)
    expect(styles).toMatch(/:root:not\(\.ui-classic\) \.agent-project-session-list\s*\{\s*margin-left: 12px;/)
    expect(styles).toMatch(/:root\.ui-modern \.agent-session-row,\s*:root\.ui-modern \.agent-project-session-list \.agent-session-row\s*\{[^}]*padding-left: 1\.5rem;/)
  })

  test.each(['idle', 'running', 'blocked', 'completed'] as const)('Given %s 会话 When 渲染状态槽 Then 独立定位且不参与标题的 flex 占位', (status) => {
    const html = renderSessionItem({}, false, status)
    const slot = html.match(/<span\b[^>]*data-session-status-slot="true"[^>]*>/)?.[0]

    expect(slot).toBeDefined()
    expect(slot).toContain('absolute')
    expect(slot).toContain('top-1/2')
    expect(slot).toContain('-translate-y-1/2')
    expect(slot).toContain('w-3.5')
    expect(html).toContain('整理会话标记布局')
  })

  test('Given 隐藏操作槽 When 悬浮、键盘聚焦或正在确认 Then 操作槽可见且保留快捷操作', () => {
    const html = renderSessionItem()
    const styles = readFileSync(resolve(import.meta.dir, '../../styles/globals.css'), 'utf8')

    expect(styles).toContain('.agent-session-row:hover [data-session-row-meta="true"]')
    expect(styles).toContain('.agent-session-row:focus-within [data-session-row-meta="true"]')
    expect(styles).toMatch(/\[data-actions-visible="true"\]\s*\{\s*width: 2\.25rem;/)
    expect(html).toContain('group-focus-within:pointer-events-auto')
    expect(html).toContain('group-focus-within:opacity-100')
    expect(html).toContain('aria-label="归档"')
    expect(html).toContain('aria-label="更多会话操作"')
  })

  test('keeps archive inline while leaving low-frequency pin in the menus', () => {
    const html = renderSessionItem({ pinned: true })

    expect(html).toContain('data-session-inline-archive-action="true"')
    expect(html).toContain('aria-label="归档"')
    expect(html).toContain('data-session-more-actions="true"')
    expect(html).not.toContain('data-session-inline-pin-action="true"')
  })
})

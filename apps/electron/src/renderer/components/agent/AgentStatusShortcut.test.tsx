import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { AgentStatusShortcut } from './AgentStatusShortcut.tsx'

function render(running: boolean): string {
  return renderToStaticMarkup(<TooltipProvider><AgentStatusShortcut running={running} onOpen={() => {}} /></TooltipProvider>)
}

describe('AgentStatusShortcut', () => {
  test('exposes the shared status action as an always-visible accessible toolbar button', () => {
    const html = render(false)

    expect(html).toContain('aria-label="会话状态与耗时"')
    expect(html).toContain('title="会话状态与耗时"')
    expect(html).toContain('data-agent-status-shortcut="true"')
  })

  test('uses a static active color while running without animation noise', () => {
    const html = render(true)

    expect(html).toContain('text-primary')
    expect(html).not.toContain('animate-')
  })
})

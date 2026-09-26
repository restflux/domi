import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { AgentStatusShortcut } from './AgentStatusShortcut.tsx'

function render(running: boolean, status: 'idle' | 'blocked' = 'idle'): string {
  return renderToStaticMarkup(<TooltipProvider><AgentStatusShortcut running={running} status={status} onOpen={() => {}} /></TooltipProvider>)
}

describe('AgentStatusShortcut', () => {
  test('exposes the shared status action as an always-visible accessible toolbar button', () => {
    const html = render(false)

    expect(html).toContain('aria-label="会话状态与耗时"')
    expect(html).toContain('title="会话状态与耗时"')
    expect(html).toContain('data-agent-status-shortcut="true"')
  })

  test('阻塞时在输入区保留醒目的状态名称和提示点', () => {
    const html = render(true, 'blocked')
    expect(html).toContain('aria-label="会话状态：需要处理"')
    expect(html).toContain('bg-amber-500')
  })

  test('uses a static active color while running without animation noise', () => {
    const html = render(true)

    expect(html).toContain('text-primary')
    expect(html).not.toContain('animate-')
  })
})

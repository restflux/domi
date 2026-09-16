import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionHoverMeta } from './session-hover-meta'
import { SessionHoverMetaPanel } from './SessionMiniMapPopover'

function renderMetaPanel(meta: Partial<SessionHoverMeta>, projectName?: string): string {
  const full: SessionHoverMeta = {
    targetLabel: 'Worktree',
    targetTone: 'progress',
    statusLabel: null,
    statusTone: 'neutral',
    gitLabel: null,
    updatedLabel: null,
    ...meta,
  }
  return renderToStaticMarkup(<SessionHoverMetaPanel meta={full} projectName={projectName} />)
}

describe('SessionHoverMetaPanel', () => {
  test('渲染目标、状态、更新时间与项目分支两行', () => {
    const html = renderMetaPanel({
      statusLabel: '修改中',
      statusTone: 'ready',
      gitLabel: 'worktree--prod-name-a3f9c21',
      updatedLabel: '9月16日 14:30',
    }, 'domi')

    expect(html).toContain('data-session-hover-meta="panel"')
    expect(html).toContain('data-session-hover-meta="status"')
    expect(html).toContain('data-session-hover-meta="location"')
    expect(html).toMatch(/data-session-hover-meta="target"[^>]*>Worktree</)
    expect(html).toContain('修改中')
    expect(html).toContain('更新于 9月16日 14:30')
    expect(html).toContain('domi')
    expect(html).toContain('worktree--prod-name-a3f9c21')
  })

  test('缺少状态、分支与更新时间时不渲染空槽位', () => {
    const html = renderMetaPanel({})

    expect(html).toContain('Worktree')
    expect(html).not.toContain('更新于')
    expect(html).not.toContain('data-session-hover-meta="location"')
  })

  test('只有分支没有项目名时仍显示位置行', () => {
    const html = renderMetaPanel({ gitLabel: 'main' })

    expect(html).toContain('data-session-hover-meta="location"')
    expect(html).toContain('main')
  })
})

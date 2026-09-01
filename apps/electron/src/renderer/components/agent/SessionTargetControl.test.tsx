import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionTargetDisplayInput } from '@/lib/session-target-view-model.ts'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { SessionTargetControl } from './SessionTargetControl.tsx'

function target(kind: 'local' | 'isolated'): SessionTargetDisplayInput {
  return {
    project: { name: 'domi' },
    checkout: {
      id: kind === 'isolated' ? 'session-checkout-1234' : 'local:domi',
      kind,
      phase: 'ready',
    },
    source: { ref: 'refs/heads/workbench', oid: 'fd97bfc1234567890' },
    current: { branch: 'workbench', oid: 'fd97bfc1234567890' },
    ownership: 'owner',
    dirty: false,
  }
}

function renderCompact(kind: 'local' | 'isolated'): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <SessionTargetControl
        target={target(kind)}
        compact
        disabled
        onChooseTarget={() => undefined}
      />
    </TooltipProvider>,
  )
}

describe('SessionTargetControl compact header', () => {
  test('Given a Local target When rendered Then the project precedes a clearly labelled Local badge', () => {
    const html = renderCompact('local')

    expect(html.indexOf('domi')).toBeLessThan(html.indexOf('Local'))
    expect(html).toContain('data-session-target-mode="local"')
    expect(html).toContain('aria-label="当前修改环境"')
    expect(html).not.toContain('>HEAD fd97bfc')
  })

  test('Given宿主提供可信目标打开动作 When compact header 渲染 Then 显示位置按钮但不接收绝对路径', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SessionTargetControl
          target={target('local')}
          compact
          disabled
          onChooseTarget={() => undefined}
          onRevealTarget={() => undefined}
        />
      </TooltipProvider>,
    )

    expect(html).toContain('data-session-target-mode="local"')
    expect(html).toContain('aria-haspopup="dialog"')
  })

  test('Given any bound Agent session When host provides handoff action Then compact menu exposes a persistent handoff entry', () => {
    for (const kind of ['local', 'isolated'] as const) {
      const html = renderToStaticMarkup(
        <TooltipProvider>
          <SessionTargetControl
            target={target(kind)} compact disabled onChooseTarget={() => undefined}
            sessionHandoffAction={{ disabled: false, pending: false, onClick: () => undefined }}
          />
        </TooltipProvider>,
      )
      expect(html).toContain('data-session-handoff-available="true"')
    }
  })

  test('Given a Worktree target When rendered Then its isolated location is visually distinguishable', () => {
    const html = renderCompact('isolated')

    expect(html.indexOf('domi')).toBeLessThan(html.indexOf('Worktree'))
    expect(html).toContain('data-session-target-mode="worktree"')
    expect(html).toContain('aria-label="当前修改环境"')
    expect(html).toContain('Worktree · 修改中')
  })

  test('Given a Worktree has saved checkpoints When rendered Then it explains they remain unpublished to Local', () => {
    const checkpointed = {
      ...target('isolated'),
      delivery: { state: 'working' as const, iteration: 1 },
      checkpoints: [{
        checkpointId: 'checkpoint-1', sequence: 1, reviewId: 'review-1', createdAt: 1,
        summary: '阶段 A', validationStatus: 'passed' as const, changedFiles: ['src/a.ts'],
      }],
    }
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SessionTargetControl target={checkpointed} compact disabled onChooseTarget={() => undefined} />
      </TooltipProvider>,
    )

    expect(html).toContain('Worktree · 1 个阶段未交付')
  })

  test('Given a non-Git project When the target chooser renders Then Worktree is disabled with an actionable explanation', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SessionTargetControl
          target={{
            project: { name: 'plain-folder' },
            checkout: { id: '', kind: 'unselected', phase: 'unselected' },
            source: null,
            current: null,
            ownership: null,
            dirty: false,
          }}
          worktreeChecked
          worktreeAvailable={false}
          onToggleWorktree={() => undefined}
          onChooseTarget={() => undefined}
        />
      </TooltipProvider>,
    )

    expect(html).toContain('data-session-target-chooser="true"')
    expect(html).toContain('bg-transparent')
    expect(html).not.toContain('bg-muted/35')
    expect(html).toContain('仅 Git 项目支持')
    expect(html).not.toContain('title="Worktree 仅支持 Git 项目"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('首次发送时创建')
  })
})

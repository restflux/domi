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

  test('Given 顶部标签已显示项目名 When 在同一行展示 Worktree Then 只保留简短环境状态', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SessionTargetControl target={target('isolated')} compact hideProjectName disabled onChooseTarget={() => undefined} />
      </TooltipProvider>,
    )
    expect(html).toContain('Worktree · 修改中')
    expect(html).not.toContain('>domi<')
    expect(html).toContain('aria-label="当前修改环境"')
  })

  test('现代 Work 顶部正常 Worktree 保留身份与入口，但不再使用蓝色底块', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SessionTargetControl target={target('isolated')} compact hideProjectName disabled onChooseTarget={() => undefined} />
      </TooltipProvider>,
    )
    expect(html).toContain('Worktree · 修改中')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('border-transparent bg-transparent text-muted-foreground')
    expect(html).not.toContain('bg-sky-500/10')
    expect(html).not.toContain('text-sky-700')
    expect(renderCompact('isolated')).toContain('bg-sky-500/10')
  })

  test('现代 Work 的待验收与 Local 验收中也保持透明，但明确写出当前状态', () => {
    const review = {
      reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: '顶部优化',
      validationStatus: 'passed' as const, tests: [], changedFiles: ['src/a.ts'],
      suggestedCommitMessage: 'style(ui): 优化顶部',
    }
    for (const delivery of [
      { state: 'ready_for_review' as const, review },
      { state: 'preview_active' as const, review, previewedAt: 2 },
    ]) {
      const html = renderToStaticMarkup(
        <TooltipProvider>
          <SessionTargetControl target={{ ...target('isolated'), delivery }} compact hideProjectName disabled onChooseTarget={() => undefined} />
        </TooltipProvider>,
      )
      expect(html).toContain(`Worktree · ${delivery.state === 'ready_for_review' ? '待验收' : 'Local 验收中'}`)
      expect(html).toContain('border-transparent bg-transparent text-muted-foreground')
      expect(html).not.toContain('bg-sky-500/10')
      expect(html).not.toContain('bg-amber-500/10')
      expect(html).toContain('aria-haspopup="dialog"')
    }
  })

  test('Worktree 正在准备时继续显示进度强调色', () => {
    const worktree = target('isolated')
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SessionTargetControl target={{ ...worktree, checkout: { ...worktree.checkout, phase: 'preparing' } }} compact hideProjectName disabled onChooseTarget={() => undefined} />
      </TooltipProvider>,
    )
    expect(html).toContain('Worktree · 正在准备 Worktree')
    expect(html).toContain('bg-sky-500/10')
  })

  test('需要恢复的 Worktree 仍保持醒目的警告色', () => {
    const worktree = target('isolated')
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SessionTargetControl target={{ ...worktree, checkout: { ...worktree.checkout, phase: 'recovery_required' } }} compact hideProjectName disabled onChooseTarget={() => undefined} />
      </TooltipProvider>,
    )
    expect(html).toContain('Worktree · 需要恢复')
    expect(html).toContain('bg-amber-500/10')
    expect(html).toContain('text-amber-700')
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

  test('Given a new session When the location chooser renders Then default Local is not shown', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SessionTargetControl
          target={{ project: { name: 'domi' }, checkout: { id: '', kind: 'unselected', phase: 'unselected' }, source: null, current: null, ownership: null, dirty: false }}
          hideProjectName
          onToggleWorktree={() => undefined}
          onChooseTarget={() => undefined}
        />
      </TooltipProvider>,
    )
    expect(html).not.toContain('Local')
    expect(html).toContain('Worktree')
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

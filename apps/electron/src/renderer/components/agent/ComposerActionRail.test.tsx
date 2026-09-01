import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ComposerActionRail,
  composerRailOwnsRunningIndicator,
  resolveComposerActionRailKind,
  resolveWorktreeRailPriority,
} from './ComposerActionRail'

describe('ComposerActionRail', () => {
  test('uses AI issue → runtime → urgent Worktree → review Worktree → summary → channel → settled Worktree priority in modern mode', () => {
    const base = {
      modern: true,
      hasUrgentWorktreeAction: false,
      hasActiveWorktreeAction: false,
      hasAgentIssue: false,
      hasAgentRuntime: false,
      hasAgentSummary: false,
      hasChannelSetupAction: false,
      hasSettledWorktreeAction: false,
    }

    expect(resolveComposerActionRailKind({ ...base, hasSettledWorktreeAction: true })).toBe('worktree_settled')
    expect(resolveComposerActionRailKind({ ...base, hasSettledWorktreeAction: true, hasChannelSetupAction: true })).toBe('channel_setup')
    expect(resolveComposerActionRailKind({ ...base, hasChannelSetupAction: true, hasAgentSummary: true })).toBe('agent_summary')
    expect(resolveComposerActionRailKind({ ...base, hasAgentSummary: true, hasActiveWorktreeAction: true })).toBe('worktree_active')
    expect(resolveComposerActionRailKind({ ...base, hasActiveWorktreeAction: true, hasUrgentWorktreeAction: true })).toBe('worktree_active')
    expect(resolveComposerActionRailKind({ ...base, hasActiveWorktreeAction: true, hasAgentRuntime: true })).toBe('agent_runtime')
    expect(resolveComposerActionRailKind({ ...base, hasUrgentWorktreeAction: true, hasAgentRuntime: true })).toBe('agent_runtime')
    expect(resolveComposerActionRailKind({ ...base, hasAgentRuntime: true, hasAgentIssue: true })).toBe('agent_issue')
    expect(resolveComposerActionRailKind({ ...base, modern: false, hasUrgentWorktreeAction: true })).toBeNull()
  })

  test('separates urgent Worktree recovery from ordinary review and settled delivery', () => {
    expect(resolveWorktreeRailPriority({ state: 'ready_for_review' })).toBe('active')
    expect(resolveWorktreeRailPriority({ state: 'ready_for_review' }, { preflightStatus: 'conflict' })).toBe('urgent')
    expect(resolveWorktreeRailPriority(
      { state: 'ready_for_review' },
      { preflightStatus: 'blocked', preflightBlockedReason: 'project_acceptance_busy' },
    )).toBe('active')
    expect(resolveWorktreeRailPriority({ state: 'preview_active' })).toBe('active')
    expect(resolveWorktreeRailPriority({ state: 'preview_active' }, { checkoutPhase: 'recovery_required' })).toBe('urgent')
    expect(resolveWorktreeRailPriority({ state: 'preview_detached' })).toBe('urgent')
    expect(resolveWorktreeRailPriority({ state: 'finalized', cleanup: 'pending' })).toBe('urgent')
    expect(resolveWorktreeRailPriority({ state: 'finalized', cleanup: 'blocked' })).toBe('urgent')
    expect(resolveWorktreeRailPriority({ state: 'retained', cleanup: 'blocked' })).toBe('urgent')
    expect(resolveWorktreeRailPriority({ state: 'retained', cleanup: 'scheduled' })).toBe('settled')
    expect(resolveWorktreeRailPriority({ state: 'delivered' })).toBe('settled')
    expect(resolveWorktreeRailPriority({ state: 'working' })).toBeNull()
    expect(resolveWorktreeRailPriority(undefined)).toBeNull()
  })

  test('delegates the old message running indicator only to Runtime Rail', () => {
    expect(composerRailOwnsRunningIndicator('agent_runtime')).toBe(true)
    expect(composerRailOwnsRunningIndicator('agent_summary')).toBe(false)
    expect(composerRailOwnsRunningIndicator('agent_issue')).toBe(false)
    expect(composerRailOwnsRunningIndicator(null)).toBe(false)
  })

  test('provides reusable icon, label and action slots', () => {
    const html = renderToStaticMarkup(createElement(ComposerActionRail, {
      dataKind: 'channel_setup',
      icon: createElement('svg', { 'data-icon': 'settings' }),
      actions: createElement('button', null, '前往设置'),
      iconClassName: 'size-5',
      contentClassName: 'max-w-[48%] flex-none',
      children: '请配置 Agent 渠道',
    }))

    expect(html).toContain('data-composer-action-rail="channel_setup"')
    expect(html).not.toContain('data-composer-action-rail-collapsed')
    expect(html).toContain('border-transparent')
    expect(html).toContain('bg-transparent')
    expect(html).not.toContain('border-border/60')
    expect(html).toContain('size-5')
    expect(html).toContain('composer-action-rail')
    expect(html).toContain('max-w-[48%] flex-none')
    expect(html).not.toContain('title=')
    expect(html).toContain('ml-auto flex shrink-0 items-center gap-1')
    expect(html).toContain('请配置 Agent 渠道')
    expect(html).toContain('前往设置')
  })
})

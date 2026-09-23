import { describe, expect, test } from 'bun:test'
import type { ManagedWorktreeSummaryView } from '@domi/shared'
import { partitionManagedWorktreesForBulkCleanup, stateBadgeMeta } from './WorktreeManagerSheet.tsx'

function item(
  checkoutId: string,
  eligibility: NonNullable<ManagedWorktreeSummaryView['cleanup']>['eligibility'],
): ManagedWorktreeSummaryView {
  return {
    checkoutId,
    revision: 3,
    ownerSessionId: `session-${checkoutId}`,
    ownerSessionTitle: checkoutId,
    project: { id: 'project-1', name: 'Domi' },
    iteration: 2,
    state: eligibility === 'retained' ? 'retained' : eligibility === 'safe' ? 'cleanup_pending' : 'working',
    phase: eligibility === 'retained' ? 'retained' : eligibility === 'safe' ? 'finalized' : 'ready',
    dirty: eligibility !== 'safe',
    commitOid: eligibility === 'blocked' ? null : 'a'.repeat(40),
    approximateBytes: 10,
    updatedAt: 1,
    canReveal: true,
    canCleanup: eligibility === 'safe',
    cleanup: {
      eligibility,
      reason: eligibility === 'safe' ? 'cleanup_failed' : eligibility === 'retained' ? 'retention_active' : 'working',
      message: eligibility === 'safe' ? '可以清理' : '需要保留',
      inspectedRevision: 3,
    },
  }
}

describe('WorktreeManagerSheet bulk cleanup', () => {
  test('Given managed cleanup states When confirmation is prepared Then eligible retained items are submitted and active items stay visible', () => {
    const safe = item('safe', 'safe')
    const retained = item('retained', 'retained')
    const blocked = item('blocked', 'blocked')

    expect(partitionManagedWorktreesForBulkCleanup([safe, retained, blocked])).toEqual({
      safe: [safe, retained],
      retained: [blocked],
    })
  })
})

describe('WorktreeManagerSheet state badge', () => {
  test('Given every managed summary state When mapping to badge Then each state gets a stable label and color class', () => {
    const states: Array<ManagedWorktreeSummaryView['state']> = [
      'working', 'ready_for_review', 'preview_active', 'retained', 'cleanup_pending', 'delivered', 'needs_attention',
    ]
    for (const state of states) {
      const meta = stateBadgeMeta(state)
      expect(meta.label.length).toBeGreaterThan(0)
      expect(meta.className).toContain('bg-')
    }
    // 需要用户关注的两个状态必须是 amber 提示色。
    expect(stateBadgeMeta('needs_attention').className).toContain('amber')
    expect(stateBadgeMeta('cleanup_pending').className).toContain('amber')
  })
})

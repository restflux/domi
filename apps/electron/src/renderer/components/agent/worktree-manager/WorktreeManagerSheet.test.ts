import { describe, expect, test } from 'bun:test'
import type { ManagedWorktreeSummaryView } from '@domi/shared'
import { partitionManagedWorktreesForBulkCleanup } from './WorktreeManagerSheet.tsx'

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
  test('Given mixed cleanup diagnostics When confirmation is prepared Then only proven-safe items are submitted and every other item stays visible', () => {
    const safe = item('safe', 'safe')
    const retained = item('retained', 'retained')
    const blocked = item('blocked', 'blocked')

    expect(partitionManagedWorktreesForBulkCleanup([safe, retained, blocked])).toEqual({
      safe: [safe],
      retained: [retained, blocked],
    })
  })
})

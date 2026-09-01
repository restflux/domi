import { describe, expect, test } from 'bun:test'
import type { SessionTargetView } from '@domi/shared'
import {
  applyAgentWorktree,
  canOfferAgentWorktreeApply,
  finishAgentWorktree,
  type AgentWorktreeApplyDependencies,
} from './agent-worktree-apply.ts'

function target(overrides: Partial<SessionTargetView> = {}): SessionTargetView {
  return {
    project: { id: 'project-a', name: 'Project A' },
    checkout: { id: 'checkout-a', kind: 'isolated', label: 'Isolated Checkout', phase: 'ready' },
    source: { ref: 'refs/heads/main', oid: 'a'.repeat(40) },
    current: { branch: null, oid: 'b'.repeat(40) },
    ownership: 'owner',
    dirty: true,
    revision: 7,
    ...overrides,
  }
}

describe('Agent Worktree Apply', () => {
  test('Given a direct owner Isolated session When tools are selected Then ApplyWorktree is available only there', () => {
    expect(canOfferAgentWorktreeApply({
      targetKind: 'isolated', ownership: 'owner', triggeredBy: 'user',
    })).toBe(true)
    expect(canOfferAgentWorktreeApply({
      targetKind: 'isolated', ownership: 'inherited', triggeredBy: 'user',
    })).toBe(false)
    expect(canOfferAgentWorktreeApply({
      targetKind: 'isolated', ownership: 'owner', triggeredBy: 'delegation',
    })).toBe(false)
    expect(canOfferAgentWorktreeApply({
      targetKind: 'local', ownership: 'owner', triggeredBy: 'user',
    })).toBe(false)
  })

  test('Given an owner Isolated session When Agent applies Then the current revision is sent to the deterministic checkout operation', async () => {
    const calls: unknown[] = []
    const dependencies: AgentWorktreeApplyDependencies = {
      inspectTarget: async () => target(),
      operateFinish: async () => { throw new Error('must not run') },
      operateApply: async (input) => {
        calls.push(input)
        return {
          status: 'conflict',
          code: 'apply_conflict',
          reason: 'content_conflict',
          target: target({ revision: 9 }),
          baseStrategy: 'recorded_base',
          effectiveBaseOid: 'a'.repeat(40),
          localHeadOid: 'c'.repeat(40),
          isolatedHeadOid: 'd'.repeat(40),
          canRetryAfterRefresh: false,
          conflictingFiles: ['src/conflict.ts'],
        }
      },
    }

    const result = await applyAgentWorktree('session-a', dependencies)

    expect(calls).toEqual([{ action: 'apply', sessionId: 'session-a', expectedRevision: 7 }])
    expect(result).toMatchObject({
      status: 'conflict',
      localHeadOid: 'c'.repeat(40),
      conflictingFiles: ['src/conflict.ts'],
    })
  })

  test('Given Apply creates the first reversible Preview When Agent applies Then a persistent review notice is emitted once', async () => {
    const notices: unknown[] = []
    const previewTarget = target({
      revision: 8,
      delivery: {
        state: 'preview_active',
        previewedAt: 2,
        review: {
          reviewId: 'review-apply',
          iteration: 1,
          preparedAt: 1,
          summary: 'Apply Preview',
          validationStatus: 'not_run',
          tests: [],
          changedFiles: ['a.ts'],
          suggestedCommitMessage: 'fix: apply preview',
        },
      },
    })
    const dependencies: AgentWorktreeApplyDependencies = {
      inspectTarget: async () => target(),
      operateFinish: async () => { throw new Error('must not run') },
      operateApply: async () => ({ status: 'previewed', target: previewTarget, changedFiles: ['a.ts'] }),
      persistPreviewNotice: (sessionId, persistedTarget) => notices.push({ sessionId, target: persistedTarget }),
    }

    const result = await applyAgentWorktree('session-a', dependencies)

    expect(result.status).toBe('previewed')
    expect(notices).toEqual([{ sessionId: 'session-a', target: previewTarget }])
  })

  test('Given explicit direct delivery When Agent finishes Then commit message and current revision reach the deterministic operation', async () => {
    const calls: unknown[] = []
    const dependencies: AgentWorktreeApplyDependencies = {
      inspectTarget: async () => target(),
      operateApply: async () => { throw new Error('must not run') },
      operateFinish: async (input) => {
        calls.push(input)
        return { status: 'finished', target: target({ revision: 8 }), changedFiles: ['a.ts'], commitOid: 'e'.repeat(40), cleanup: 'discarded' }
      },
    }

    const result = await finishAgentWorktree('session-a', '  fix: direct delivery  ', dependencies)

    expect(calls).toEqual([{ action: 'finish', sessionId: 'session-a', expectedRevision: 7, commitMessage: 'fix: direct delivery', retention: 'cleanup' }])
    expect(result).toMatchObject({ status: 'finished', cleanup: 'discarded' })
  })

  test('Given major checkpoints followed by a micro-adjustment When Agent finishes directly Then one cumulative main-feature-led message reaches the final lifecycle without duplicate bullets', async () => {
    const calls: unknown[] = []
    const dependencies: AgentWorktreeApplyDependencies = {
      inspectTarget: async () => target({
        checkpoints: [
          { checkpointId: 'checkpoint-1', sequence: 1, reviewId: 'review-1', createdAt: 1, summary: '主要功能 checkpoint', validationStatus: 'passed', changedFiles: ['src/feature.ts'] },
          { checkpointId: 'checkpoint-2', sequence: 2, reviewId: 'review-2', createdAt: 2, summary: '补充主要功能验证', validationStatus: 'passed', changedFiles: ['src/feature.test.ts'] },
        ],
      }),
      operateApply: async () => { throw new Error('must not run') },
      operateFinish: async (input) => {
        calls.push(input)
        return { status: 'finished', target: target({ revision: 8 }), changedFiles: ['src/feature.ts', 'src/style.ts'], commitOid: 'e'.repeat(40), cleanup: 'discarded' }
      },
    }

    await finishAgentWorktree('session-a', [
      'feat(electron): 添加累计交付汇总',
      '',
      '- 覆盖主要功能 checkpoint 与当前修改',
      '- 调整确认文案顺序',
      '- 覆盖主要功能 checkpoint 与当前修改',
      '- 调整确认文案顺序',
    ].join('\n'), dependencies)

    expect(calls).toEqual([{
      action: 'finish',
      sessionId: 'session-a',
      expectedRevision: 7,
      commitMessage: [
        'feat(electron): 添加累计交付汇总',
        '',
        '- 覆盖主要功能 checkpoint 与当前修改',
        '- 调整确认文案顺序',
      ].join('\n'),
      retention: 'cleanup',
    }])
  })

  test('Given Preview is active or detached When the user explicitly chooses direct delivery Then FinishWorktree delegates to the deterministic Finish lifecycle', async () => {
    for (const deliveryState of ['preview_active', 'preview_detached'] as const) {
      const calls: unknown[] = []
      const review = {
        reviewId: `review-${deliveryState}`,
        iteration: 1,
        preparedAt: 1,
        summary: deliveryState,
        validationStatus: 'passed' as const,
        tests: [],
        changedFiles: ['a.ts'],
        suggestedCommitMessage: 'fix: direct preview delivery',
      }
      const delivery = deliveryState === 'preview_active'
        ? { state: 'preview_active' as const, previewedAt: 2, review }
        : {
            state: 'preview_detached' as const,
            previewedAt: 2,
            detachedAt: 3,
            reason: 'stale_local' as const,
            attemptedAction: 'rollback_preview' as const,
            review,
          }
      const dependencies: AgentWorktreeApplyDependencies = {
        inspectTarget: async () => target({ delivery }),
        operateApply: async () => { throw new Error('must not run') },
        operateFinish: async (input) => {
          calls.push(input)
          return { status: 'finished', target: target({ revision: 8 }), changedFiles: ['a.ts'], commitOid: 'e'.repeat(40), cleanup: 'discarded' }
        },
      }

      const result = await finishAgentWorktree('session-a', 'fix: direct preview delivery', dependencies)

      expect(calls).toEqual([{
        action: 'finish', sessionId: 'session-a', expectedRevision: 7,
        commitMessage: 'fix: direct preview delivery', retention: 'cleanup',
      }])
      expect(result.status).toBe('finished')
    }
  })

  test('Given a Local or inherited target When Agent applies Then it fails before any checkout mutation', async () => {
    let operationCount = 0
    const dependencies: AgentWorktreeApplyDependencies = {
      inspectTarget: async () => target({
        checkout: { id: 'local-a', kind: 'local', label: 'Local Checkout', phase: 'ready' },
      }),
      operateApply: async () => {
        operationCount += 1
        throw new Error('must not run')
      },
      operateFinish: async () => {
        operationCount += 1
        throw new Error('must not run')
      },
    }

    await expect(applyAgentWorktree('session-a', dependencies)).rejects.toThrow('仅适用于 managed Worktree')
    expect(operationCount).toBe(0)
  })
})

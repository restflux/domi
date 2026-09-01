import { describe, expect, test } from 'bun:test'
import type { ManagedCheckoutRecord } from './session-checkout/ports.ts'
import { collectSessionProjectArtifactPaths } from './session-project-artifacts.ts'

function checkout(overrides: Partial<ManagedCheckoutRecord>): ManagedCheckoutRecord {
  return {
    checkoutId: 'checkout-1',
    projectId: 'project-1',
    projectName: '项目',
    ownerSessionId: 'session-1',
    localRoot: '/local',
    managedRoot: '/managed',
    managedGitRoot: '/managed',
    gitCommonDir: '/local/.git',
    gitDir: '/local/.git/worktrees/managed',
    baseOid: 'base',
    sourceRef: 'refs/heads/main',
    phase: 'ready',
    delivery: { state: 'working', iteration: 1 },
    journal: null,
    revision: 1,
    ...overrides,
  }
}

describe('collectSessionProjectArtifactPaths', () => {
  test('聚合当前改动、文件检查点和历次交付产物，并排除其他会话与已删除路径', () => {
    const records = [
      checkout({
        delivery: {
          state: 'delivered',
          iteration: 1,
          commitOid: 'commit-1',
          deliveredAt: 100,
          proof: {
            localBranch: 'main',
            localHeadBefore: 'before',
            localHeadAfter: 'after',
            changedFiles: ['docs/report.html', 'src/shared.ts'],
          },
        },
        checkpoints: [{
          checkpointId: 'checkpoint-1',
          sequence: 1,
          reviewId: 'review-1',
          iteration: 1,
          createdAt: 90,
          commitOid: 'checkpoint-commit',
          parentOid: 'base',
          summary: '阶段产物',
          commitMessage: '阶段产物',
          validationStatus: 'not_run',
          changedFiles: ['docs/draft.md'],
        }],
      }),
      checkout({ checkoutId: 'checkout-2', ownerSessionId: 'other-session' }),
    ]

    expect(collectSessionProjectArtifactPaths({
      sessionId: 'session-1',
      checkoutRecords: records,
      checkpointPaths: ['src/shared.ts', 'assets/generated.png'],
      currentChangedPaths: ['src/current.ts', 'docs/deleted.md'],
      deletedPaths: ['docs/deleted.md'],
    })).toEqual([
      'assets/generated.png',
      'docs/draft.md',
      'docs/report.html',
      'src/current.ts',
      'src/shared.ts',
    ])
  })

  test('继承会话也能读取当前绑定 checkout 的产物，但不会读取其他无关 checkout', () => {
    expect(collectSessionProjectArtifactPaths({
      sessionId: 'child-session',
      checkoutRecords: [
        checkout({
          checkoutId: 'inherited-checkout',
          ownerSessionId: 'owner-session',
          previousReview: {
            reviewId: 'review-1',
            iteration: 1,
            summary: '继承产物',
            suggestedCommitMessage: 'test',
            changedFiles: ['docs/inherited.md'],
          },
        }),
        checkout({
          checkoutId: 'unrelated-checkout',
          ownerSessionId: 'other-session',
          previousReview: {
            reviewId: 'review-2',
            iteration: 1,
            summary: '无关产物',
            suggestedCommitMessage: 'test',
            changedFiles: ['docs/unrelated.md'],
          },
        }),
      ],
      boundCheckoutIds: new Set(['inherited-checkout']),
      checkpointPaths: [],
      currentChangedPaths: [],
      deletedPaths: [],
    })).toEqual(['docs/inherited.md'])
  })

  test('拒绝绝对路径、父级穿越和空路径，避免历史记录扩大文件授权范围', () => {
    expect(collectSessionProjectArtifactPaths({
      sessionId: 'session-1',
      checkoutRecords: [checkout({
        previousReview: {
          reviewId: 'review-1',
          iteration: 1,
          summary: '旧验收',
          suggestedCommitMessage: 'test',
          changedFiles: ['/etc/passwd', '../outside.txt', 'safe/file.txt'],
        },
      })],
      checkpointPaths: ['C:\\secret.txt', '', './safe/file.txt'],
      currentChangedPaths: [],
      deletedPaths: [],
    })).toEqual(['safe/file.txt'])
  })
})

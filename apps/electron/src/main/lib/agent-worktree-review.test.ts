import { describe, expect, test } from 'bun:test'
import type { SDKMessage, SessionTargetView } from '@domi/shared'
import { canOfferReadyForReview, normalizeSuggestedCommitMessage, readyAgentWorktree, sanitizeWorktreeReviewText } from './agent-worktree-review.ts'

function readyTarget(): SessionTargetView {
  return {
    project: { id: 'project-1', name: 'Project' },
    checkout: { id: 'checkout-1', kind: 'isolated', label: 'Isolated Checkout', phase: 'ready' },
    source: { ref: 'refs/heads/main', oid: 'a'.repeat(40) },
    current: { branch: null, oid: 'a'.repeat(40) },
    ownership: 'owner',
    dirty: true,
    revision: 3,
    delivery: {
      state: 'ready_for_review',
      review: {
        reviewId: 'review-1',
        iteration: 1,
        preparedAt: 1,
        summary: '完成任务',
        validationStatus: 'passed',
        tests: [{ command: 'bun test', status: 'passed' }],
        changedFiles: ['src/a.ts'],
        suggestedCommitMessage: 'fix: task',
      },
    },
  }
}

describe('Agent Worktree Review', () => {
  test('Given tool availability context When checked Then only direct user owner Isolated sessions can prepare review', () => {
    expect(canOfferReadyForReview({ targetKind: 'isolated', ownership: 'owner', triggeredBy: 'user' })).toBe(true)
    expect(canOfferReadyForReview({ targetKind: 'local', ownership: 'owner', triggeredBy: 'user' })).toBe(false)
    expect(canOfferReadyForReview({ targetKind: 'isolated', ownership: 'inherited', triggeredBy: 'user' })).toBe(false)
    expect(canOfferReadyForReview({ targetKind: 'isolated', ownership: 'owner', triggeredBy: 'automation' })).toBe(false)
    expect(canOfferReadyForReview({ targetKind: 'isolated', ownership: 'owner', triggeredBy: 'delegation' })).toBe(false)
  })

  test('Given Agent-provided review text contains local paths or internal refs When sanitized Then persisted projection removes them', () => {
    const text = '失败于 D:\\workspace\\demo\\a.ts /home/a/repo/b.ts refs/domi/preview/secret'
    const sanitized = sanitizeWorktreeReviewText(text)
    expect(sanitized).not.toContain('D:\\workspace')
    expect(sanitized).not.toContain('/home/a')
    expect(sanitized).not.toContain('refs/domi/')
    expect(sanitized).toContain('[路径]')
    expect(sanitized).toContain('[内部引用]')
  })

  test('Given review text contains an HTTPS link When sanitized Then it is not mistaken for a Windows path', () => {
    const text = '参考 https://example.com/spec 后继续修改。'
    expect(sanitizeWorktreeReviewText(text)).toBe(text)
  })

  test('Given regenerated cumulative commit text repeats an identical bullet When normalized Then it keeps one final review message without stacking duplicates', () => {
    expect(normalizeSuggestedCommitMessage([
      'feat(electron): 添加完整工作动态侧栏',
      '',
      '- 新增紧凑任务概览',
      '- 调整筛选栏顺序',
      '- 新增紧凑任务概览',
      '- 调整筛选栏顺序',
    ].join('\n'))).toBe([
      'feat(electron): 添加完整工作动态侧栏',
      '',
      '- 新增紧凑任务概览',
      '- 调整筛选栏顺序',
    ].join('\n'))
  })

  test('Given a valid ReadyForReview call When persisted Then registry is updated before one safe system card message is appended', async () => {
    const events: string[] = []
    const persisted: SDKMessage[] = []
    const target = await readyAgentWorktree('session-1', {
      details: '## 变更说明\n\n完成 D:\\workspace\\demo\\a.ts 的修改。',
      summary: ' 完成任务 ',
      validationStatus: 'passed',
      tests: [{ command: ' bun test ', status: 'passed' }],
      suggestedCommitMessage: ' fix: task ',
    }, {
      markReadyForReview: async (_sessionId, input) => {
        events.push(`mark:${input.summary}:${input.suggestedCommitMessage}`)
        expect(input.detailsMarkdown).toBe('## 变更说明\n\n完成 [路径] 的修改。')
        const ready = readyTarget()
        if (ready.delivery?.state !== 'ready_for_review') throw new Error('测试目标状态错误')
        return {
          ...ready,
          delivery: {
            ...ready.delivery,
            review: { ...ready.delivery.review, detailsMarkdown: input.detailsMarkdown },
          },
        }
      },
      persistMessages: (_sessionId, messages) => {
        events.push('persist')
        persisted.push(...messages)
      },
    })

    expect(target.delivery?.state).toBe('ready_for_review')
    expect(events).toEqual(['mark:完成任务:fix: task', 'persist'])
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      type: 'system',
      subtype: 'worktree_ready_for_review',
      session_id: 'session-1',
      checkout_id: 'checkout-1',
      review_id: 'review-1',
      details_markdown: '## 变更说明\n\n完成 [路径] 的修改。',
      changed_files: ['src/a.ts'],
    })
    expect(JSON.stringify(persisted[0])).not.toContain('localRoot')
  })
})

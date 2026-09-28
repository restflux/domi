import { describe, expect, test } from 'bun:test'
import type { SDKSystemMessage, SessionTargetView, WorktreeReviewView } from '@domi/shared'
import { resolveWorktreeHeaderReviewAction } from './worktree-header-review-action.ts'

const review: WorktreeReviewView = {
  reviewId: 'review-3', iteration: 3, preparedAt: 100, summary: '本轮变更',
  detailsMarkdown: '## 完整报告', validationStatus: 'passed', tests: [], changedFiles: ['src/a.ts'],
  suggestedCommitMessage: 'fix: 修复体验',
}
const base: SessionTargetView = {
  project: { id: 'project-1', name: 'Domi' },
  checkout: { id: 'checkout-1', kind: 'isolated', label: 'Worktree', phase: 'ready', iteration: 3 },
  source: { ref: 'main', oid: 'a'.repeat(40) }, current: { branch: 'main', oid: 'b'.repeat(40) },
  ownership: 'owner', dirty: true, revision: 7,
  delivery: { state: 'ready_for_review', review },
}
const next = {
  type: 'system', subtype: 'worktree_next_iteration_requested', request_id: 'request-4',
  session_id: 'session-1', checkout_id: 'checkout-1', expected_revision: 7,
  iteration: 4, task: '第四轮', summary: '下一步', details_markdown: '## 完整任务',
} as SDKSystemMessage
const revision = {
  type: 'system', subtype: 'worktree_preview_revision_requested', request_id: 'revision-3',
  session_id: 'session-1', iteration: 3, task: '修复', summary: '修复样式',
} as SDKSystemMessage

describe('右上角 Worktree 验收兜底入口', () => {
  test('有效验收独立于 composer 摘要，始终由当前目标快照重建详情', () => {
    const result = resolveWorktreeHeaderReviewAction('session-1', base, null)
    expect(result?.label).toBe('查看验收并预览修改')
    expect(result?.message).toMatchObject({ session_id: 'session-1', checkout_id: 'checkout-1', review_id: 'review-3', changed_files: ['src/a.ts'] })
    const preview = { ...base, delivery: { state: 'preview_active', review, previewedAt: 120 } } as SessionTargetView
    expect(resolveWorktreeHeaderReviewAction('session-1', preview, null)?.label).toBe('查看预览并应用修改')
    const detached = { ...base, delivery: { state: 'preview_detached', review, previewedAt: 120, detachedAt: 121, reason: 'stale_local', attemptedAction: 'discard' } } as SessionTargetView
    expect(resolveWorktreeHeaderReviewAction('session-1', detached, null)?.label).toBe('查看预览状态与恢复操作')
  })

  test('仅接受当前会话、checkout、revision、轮次匹配的待确认请求', () => {
    const delivered = { ...base, checkout: { ...base.checkout, phase: 'discarded' }, delivery: { state: 'delivered', iteration: 3, commitOid: null, deliveredAt: 20 } } as SessionTargetView
    expect(resolveWorktreeHeaderReviewAction('session-1', delivered, next)?.label).toBe('查看任务并确认下一轮')
    expect(resolveWorktreeHeaderReviewAction('session-2', delivered, next)).toBeNull()
    expect(resolveWorktreeHeaderReviewAction('session-1', { ...delivered, revision: 8 }, next)).toBeNull()
    expect(resolveWorktreeHeaderReviewAction('session-1', { ...delivered, checkout: { ...delivered.checkout, id: 'other' } }, next)).toBeNull()
    const preview = { ...base, delivery: { state: 'preview_active', review, previewedAt: 120 } } as SessionTargetView
    expect(resolveWorktreeHeaderReviewAction('session-1', preview, revision)?.label).toBe('查看任务并确认继续修改')
    expect(resolveWorktreeHeaderReviewAction('session-1', { ...base, delivery: { state: 'working', iteration: 3 } }, revision)).toBeNull()
  })

  test('旧验收、非 owner、工作中和未知快照均不提供可执行兜底入口', () => {
    expect(resolveWorktreeHeaderReviewAction('session-1', null, next)).toBeNull()
    expect(resolveWorktreeHeaderReviewAction('session-1', { ...base, ownership: 'inherited' }, null)).toBeNull()
    expect(resolveWorktreeHeaderReviewAction('session-1', { ...base, checkout: { ...base.checkout, kind: 'local' } }, null)).toBeNull()
    expect(resolveWorktreeHeaderReviewAction('session-1', { ...base, delivery: { state: 'working', iteration: 3 } }, null)).toBeNull()
    expect(resolveWorktreeHeaderReviewAction('session-1', { ...base, delivery: { state: 'delivered', iteration: 3, commitOid: null, deliveredAt: 20 } }, null)).toBeNull()
    expect(resolveWorktreeHeaderReviewAction('session-1', { ...base, delivery: { state: 'retained', review, retainedAt: 20, expiresAt: null } } as SessionTargetView, null)).toBeNull()
  })
})

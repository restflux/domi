import { describe, expect, test } from 'bun:test'
import type { SDKMessage, SDKSystemMessage, SessionTargetView, WorktreeReviewView } from '@domi/shared'
import { currentReviewMessage, findCurrentIterationRequest, isCurrentIterationRequest } from './worktree-detail-model.ts'

const review: WorktreeReviewView = {
  reviewId: 'review-3', iteration: 3, preparedAt: 100, summary: '本轮变更', detailsMarkdown: '## 完整内容',
  validationStatus: 'passed', tests: [{ command: 'bun test', status: 'passed' }], changedFiles: ['src/a.ts'], suggestedCommitMessage: 'feat: 新增功能',
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
  iteration: 4, task: '继续做第四轮', summary: '第四轮', details_markdown: '## 下一步\n\n保留完整任务',
} as SDKSystemMessage
const revision = {
  type: 'system', subtype: 'worktree_preview_revision_requested', request_id: 'revision-3',
  session_id: 'session-1', iteration: 3, task: '修复第三轮', summary: '修复样式',
} as SDKSystemMessage

describe('Worktree 当前详情选择', () => {
  test('从目标快照重建当前验收的全部详情，旧版 working/delivered 不伪造可操作验收', () => {
    expect(currentReviewMessage('session-1', base)).toMatchObject({
      session_id: 'session-1', checkout_id: 'checkout-1', review_id: 'review-3',
      details_markdown: '## 完整内容', changed_files: ['src/a.ts'], tests: review.tests,
    })
    expect(currentReviewMessage('session-1', { ...base, delivery: { state: 'working', iteration: 4 } })).toBeNull()
    expect(currentReviewMessage('session-1', { ...base, delivery: { state: 'delivered', iteration: 3, commitOid: null, deliveredAt: 11 } })).toBeNull()
  })

  test('新一轮请求只在相同会话、checkout、revision 和已完成轮次有效', () => {
    const delivered: SessionTargetView = { ...base, checkout: { ...base.checkout, phase: 'discarded' }, delivery: { state: 'delivered', iteration: 3, commitOid: null, deliveredAt: 20 } }
    expect(isCurrentIterationRequest(next, 'session-1', delivered)).toBe(true)
    expect(isCurrentIterationRequest(next, 'session-2', delivered)).toBe(false)
    expect(isCurrentIterationRequest(next, 'session-1', { ...delivered, checkout: { ...delivered.checkout, id: 'checkout-2' } })).toBe(false)
    expect(isCurrentIterationRequest(next, 'session-1', { ...delivered, revision: 8 })).toBe(false)
    expect(isCurrentIterationRequest(next, 'session-1', { ...delivered, ownership: 'inherited' })).toBe(false)
    expect(isCurrentIterationRequest(next, 'session-1', { ...delivered, delivery: { state: 'working', iteration: 4 } })).toBe(false)
    expect(isCurrentIterationRequest(next, 'session-1', { ...delivered, delivery: { state: 'delivered', iteration: 2, commitOid: null, deliveredAt: 20 } })).toBe(false)
    expect(isCurrentIterationRequest(next, 'session-1', { ...delivered, checkout: { ...delivered.checkout, phase: 'retained' } })).toBe(false)
  })

  test('预览修订仅在同轮 Preview 尚生效时显示确认，撤回后不复活', () => {
    const preview: SessionTargetView = { ...base, delivery: { state: 'preview_active', review, previewedAt: 120 } }
    expect(isCurrentIterationRequest(revision, 'session-1', preview)).toBe(true)
    expect(isCurrentIterationRequest(revision, 'session-1', { ...preview, delivery: { state: 'working', iteration: 3 } })).toBe(false)
    expect(isCurrentIterationRequest(revision, 'session-1', { ...preview, delivery: { state: 'preview_detached', review, previewedAt: 120, detachedAt: 121, reason: 'stale_local', attemptedAction: 'discard' } })).toBe(false)
    expect(isCurrentIterationRequest(revision, 'session-2', preview)).toBe(false)
  })

  test('持久化与 live 混合消息只挑最后一个有效请求，不把无关用户或另一轮的请求作为当前操作', () => {
    const delivered: SessionTargetView = { ...base, checkout: { ...base.checkout, phase: 'discarded' }, delivery: { state: 'delivered', iteration: 3, commitOid: null, deliveredAt: 20 } }
    const userMessage = { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'text', text: '继续' }] } } as SDKMessage
    const toolResult = { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] } } as SDKMessage
    const messages = [next, { ...next, request_id: 'other-checkout', checkout_id: 'checkout-2' }, toolResult, { ...next, request_id: 'latest' }] as SDKMessage[]
    expect(findCurrentIterationRequest(messages, 'session-1', delivered)?.request_id).toBe('latest')
    expect(findCurrentIterationRequest([...messages, userMessage], 'session-1', delivered)).toBeNull()
    expect(findCurrentIterationRequest([...messages, { type: 'system', subtype: 'task_notification' } as SDKMessage], 'session-1', delivered)).toBeNull()
    expect(findCurrentIterationRequest(messages, 'session-2', delivered)).toBeNull()
    expect(findCurrentIterationRequest(messages, 'session-1', { ...delivered, delivery: { state: 'working', iteration: 4 } })).toBeNull()
  })
})

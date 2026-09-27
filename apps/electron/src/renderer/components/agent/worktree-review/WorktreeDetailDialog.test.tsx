import { describe, expect, test } from 'bun:test'
import type { SDKSystemMessage } from '@domi/shared'
import { worktreeDetailSelectionAtomFamily } from './WorktreeDetailDialog.tsx'

const review = {
  type: 'system', subtype: 'worktree_ready_for_review', session_id: 'session-1', checkout_id: 'checkout-1', review_id: 'review-1', iteration: 1,
  summary: '本轮验收', details_markdown: '## 工作详情\n\n完整内容', validation_status: 'passed', tests: [], changed_files: ['src/a.ts'],
  suggested_commit_message: 'feat: 工作改动',
} as SDKSystemMessage
const request = {
  type: 'system', subtype: 'worktree_next_iteration_requested', session_id: 'session-1', request_id: 'request-2', iteration: 2,
  summary: '下一轮', task: '继续完成任务', details_markdown: '## 详细任务\n\n授权前阅读',
} as SDKSystemMessage

describe('Worktree 消息事件与详情展示边界', () => {
  test('消息区不再插入验收和下一轮 system 事件条；详情选择状态按会话隔离', async () => {
    const renderer = await Bun.file('apps/electron/src/renderer/components/agent/SDKMessageRenderer.tsx').text()
    expect(renderer).not.toContain('<WorktreeHistoryEvent')
    expect(renderer).toContain('<WorktreeReportText')
    expect(worktreeDetailSelectionAtomFamily('session-a')).not.toBe(worktreeDetailSelectionAtomFamily('session-b'))
  })

  test('详情弹窗挂载于消息列表外的 AgentView，消息两种 system 分支均只渲染历史事件', async () => {
    const agentView = await Bun.file('apps/electron/src/renderer/components/agent/AgentView.tsx').text()
    const renderer = await Bun.file('apps/electron/src/renderer/components/agent/SDKMessageRenderer.tsx').text()
    const dialog = await Bun.file('apps/electron/src/renderer/components/agent/worktree-review/WorktreeDetailDialog.tsx').text()
    expect(dialog).toContain('data-worktree-history-review-details')
    expect(dialog).toContain('<WorktreeIterationRequestCard key={request.requestId} message={message} currentSessionId={sessionId} />')
    expect(dialog).toContain('<WorktreeReviewCard key={review.reviewId} message={currentReview} currentSessionId={sessionId} initialAction={selection?.action} />')
    expect(agentView).toContain('<WorktreeDetailDialog sessionId={sessionId} currentRequest={currentIterationRequest} />')
    expect(agentView).toContain('<AgentMessages')
    expect(renderer).not.toContain('<WorktreeHistoryEvent message=')
    expect(renderer).not.toContain('<WorktreeReviewCard')
    expect(renderer).not.toContain('<WorktreeIterationRequestCard')
  })
})

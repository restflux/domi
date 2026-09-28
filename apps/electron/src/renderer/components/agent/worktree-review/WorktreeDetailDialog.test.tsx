import { describe, expect, test } from 'bun:test'
import type { SDKSystemMessage, SessionTargetView } from '@domi/shared'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { sessionTargetStateAtomFamily } from '@/atoms/session-target-atoms.ts'
import { WorktreeReviewCard } from './WorktreeReviewCard.tsx'
import { shouldOpenWorktreeDetailDialog, worktreeDetailSelectionAtomFamily } from './WorktreeDetailDialog.tsx'

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
  test('当前下一轮请求可确认，处理后立即关闭历史弹窗；历史验收仍可查看', () => {
    expect(shouldOpenWorktreeDetailDialog(null, false)).toBe(false)
    expect(shouldOpenWorktreeDetailDialog({ message: request }, true)).toBe(true)
    expect(shouldOpenWorktreeDetailDialog({ message: request }, false)).toBe(false)
    expect(shouldOpenWorktreeDetailDialog({ message: review }, false)).toBe(true)
    expect(shouldOpenWorktreeDetailDialog({ message: review, action: 'commit' }, false)).toBe(false)
  })

  test('保存入口不呈现验收详情正文，查看详情仍保留文件与验证', () => {
    const store = createStore()
    const snapshot: SessionTargetView = {
      project: { id: 'project-1', name: 'domi' },
      checkout: { id: 'checkout-1', kind: 'isolated', label: 'Isolated Checkout', phase: 'ready' },
      source: { ref: 'main', oid: 'abc123' },
      current: { branch: null, oid: 'abc123' },
      ownership: 'owner', dirty: false, revision: 2,
      delivery: {
        state: 'preview_active', previewedAt: 2,
        review: { reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: '本轮验收',
          validationStatus: 'passed', tests: [], changedFiles: ['src/a.ts'], suggestedCommitMessage: 'feat: 工作改动' },
      },
    }
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot, selectionRequired: false, loading: false, pendingAction: null, error: null,
    })
    const renderCard = (confirmationOnly: boolean): string => renderToStaticMarkup(
      <Provider store={store}><WorktreeReviewCard message={review} currentSessionId="session-1" initialAction="commit" confirmationOnly={confirmationOnly} /></Provider>,
    )
    expect(renderCard(true)).not.toContain('data-worktree-review-detail')
    expect(renderCard(true)).not.toContain('修改文件')
    expect(renderCard(false)).toContain('data-worktree-review-detail')
    expect(renderCard(false)).toContain('修改文件')
  })

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
    expect(dialog).toContain('review.review.changedFiles.map')
    expect(dialog).toContain('review.review.tests.map')
    expect(dialog).not.toContain('历史交付说明')
    expect(dialog).not.toContain('review.detailsMarkdown')
    expect(dialog).not.toContain('review.review.suggestedCommitMessage')
    expect(dialog).not.toContain('request.detailsMarkdown')
    expect(dialog).not.toContain('历史记录 · 仅供回看')
    expect(dialog).toContain('shouldOpenWorktreeDetailDialog(selection, isActiveRequest)')
    expect(dialog).toContain('<WorktreeIterationRequestCard key={request.requestId} message={message} currentSessionId={sessionId} />')
    expect(dialog).toContain('<WorktreeReviewCard key={review.reviewId} message={currentReview} currentSessionId={sessionId} initialAction={selection?.action} />')
    expect(agentView).toContain('<WorktreeDetailDialog sessionId={sessionId} currentRequest={currentIterationRequest} />')
    expect(agentView).toContain('<AgentMessages')
    expect(renderer).not.toContain('<WorktreeHistoryEvent message=')
    expect(renderer).not.toContain('<WorktreeReviewCard')
    expect(renderer).not.toContain('<WorktreeIterationRequestCard')
    expect(renderer).toContain('data-worktree-report="true"')
  })
})

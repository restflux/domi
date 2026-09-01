import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { SDKSystemMessage, SessionTargetView } from '@domi/shared'
import { sessionTargetStateAtomFamily } from '@/atoms/session-target-atoms.ts'
import { WorktreeIterationRequestCard, parseWorktreeIterationRequest } from './WorktreeIterationRequestCard.tsx'

describe('WorktreeIterationRequestCard parser', () => {
  test('只接受有界 request identity、iteration 和 task，并读取独立摘要', () => {
    expect(parseWorktreeIterationRequest({
      type: 'system',
      subtype: 'worktree_next_iteration_requested',
      request_id: 'request-1',
      iteration: 2,
      details_markdown: '## 调整内容\n\n修复请求卡输出。',
      summary: '修复请求卡输出',
      task: '继续修复并补测试',
    })).toEqual({
      requestId: 'request-1', iteration: 2, detailsMarkdown: '## 调整内容\n\n修复请求卡输出。', summary: '修复请求卡输出', task: '继续修复并补测试', mode: 'next_iteration',
    })

    expect(parseWorktreeIterationRequest({
      type: 'system',
      subtype: 'worktree_preview_revision_requested',
      request_id: 'request-2',
      iteration: 1,
      details_markdown: '## 调整内容\n\n调整验收中的表单布局。',
      summary: '调整验收中的表单布局',
      task: '撤回后继续调整',
    })).toEqual({
      requestId: 'request-2', iteration: 1, detailsMarkdown: '## 调整内容\n\n调整验收中的表单布局。', summary: '调整验收中的表单布局', task: '撤回后继续调整', mode: 'preview_revision',
    })

    expect(parseWorktreeIterationRequest({
      type: 'system', request_id: '', iteration: 2, task: '修改',
    })).toBeNull()
    expect(parseWorktreeIterationRequest({
      type: 'system', request_id: 'request-1', iteration: -1, task: '修改',
    })).toBeNull()
    expect(parseWorktreeIterationRequest({
      type: 'system', request_id: 'request-1', iteration: 2, task: '',
    })).toBeNull()
  })

  test('历史请求中的脱敏路径占位符显示为可理解的 Local Checkout 语义', () => {
    expect(parseWorktreeIterationRequest({
      type: 'system',
      subtype: 'worktree_next_iteration_requested',
      request_id: 'redacted-request',
      iteration: 2,
      details_markdown: '从 `[路径]` 的最新 Local revision 创建。',
      summary: '从 Local 最新状态开始',
      task: '从用户 Local Checkout `[路径]` 的最新状态继续修改。',
    })).toEqual({
      requestId: 'redacted-request',
      iteration: 2,
      detailsMarkdown: '从当前项目的 Local Checkout 的最新 Local revision 创建。',
      summary: '从 Local 最新状态开始',
      task: '从当前项目的 Local Checkout 的最新状态继续修改。',
      mode: 'next_iteration',
    })
  })

  test('历史请求没有 summary 时只生成有界单行摘要，不把完整 task 塞回卡片', () => {
    const task = `继续优化请求卡：\n${'完整调整细节'.repeat(80)}`
    const request = parseWorktreeIterationRequest({
      type: 'system',
      subtype: 'worktree_next_iteration_requested',
      request_id: 'legacy-request',
      iteration: 4,
      task,
    })

    expect(request?.summary.length).toBeLessThanOrEqual(160)
    expect(request?.summary).not.toContain('\n')
    expect(request?.summary.endsWith('…')).toBe(true)
    expect(request?.detailsMarkdown).toContain('## 调整内容')
    expect(request?.detailsMarkdown).toContain(task)
    expect(request?.task).toBe(task)
  })

  test('不信任历史消息中的 session_id', () => {
    const message = {
      type: 'system',
      subtype: 'worktree_next_iteration_requested',
      session_id: 'forged-session',
      request_id: 'request-1',
      iteration: 3,
      details_markdown: '继续修改请求卡正文',
      summary: '继续修改请求卡',
      task: '继续修改',
    } as SDKSystemMessage
    expect(parseWorktreeIterationRequest(message)).toEqual({
      requestId: 'request-1', iteration: 3, detailsMarkdown: '继续修改请求卡正文', summary: '继续修改请求卡', task: '继续修改', mode: 'next_iteration',
    })
  })

  test('确认卡逐字展示将获得本次执行授权的完整任务，而不是只展示摘要', () => {
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: {
        project: { id: 'project-1', name: 'domi' },
        checkout: { id: 'checkout-1', kind: 'isolated', label: 'Isolated Checkout', phase: 'discarded' },
        source: { ref: 'main', oid: 'a'.repeat(40) },
        current: { branch: 'main', oid: 'b'.repeat(40) },
        ownership: 'owner', dirty: false, revision: 2,
        delivery: { state: 'delivered', iteration: 1, commitOid: 'b'.repeat(40), deliveredAt: 1 },
      },
      selectionRequired: false, loading: false, pendingAction: null, error: null,
    })
    const html = renderToStaticMarkup(React.createElement(
      Provider,
      { store },
      React.createElement(WorktreeIterationRequestCard, {
        currentSessionId: 'session-1',
        message: {
          type: 'system', subtype: 'worktree_next_iteration_requested', request_id: 'request-visible', iteration: 2,
          details_markdown: '## 可见说明\n\n只修复按钮文案', summary: '修复按钮文案',
          task: '修复按钮文案，并删除未使用的旧实现',
        } as SDKSystemMessage,
      }),
    ))

    expect(html).toContain('确认后将执行的完整任务')
    expect(html).toContain('修复按钮文案，并删除未使用的旧实现')
  })

  test('重新打开撤回卡时只显示中性加载，不冒充正在撤回', () => {
    const store = createStore()
    const review = {
      reviewId: 'review-2', iteration: 2, preparedAt: 1, summary: '第二轮完成', validationStatus: 'passed' as const,
      tests: [], changedFiles: ['src/a.ts'], suggestedCommitMessage: 'fix: task',
    }
    const snapshot: SessionTargetView = {
      project: { id: 'project-1', name: 'domi' },
      checkout: { id: 'checkout-2', kind: 'isolated', label: 'Isolated Checkout', phase: 'ready' },
      source: { ref: 'main', oid: 'a'.repeat(40) }, current: { branch: 'main', oid: 'b'.repeat(40) },
      ownership: 'owner', dirty: true, revision: 2,
      delivery: { state: 'preview_active', review, previewedAt: 2 },
    }
    const message = {
      type: 'system', subtype: 'worktree_preview_revision_requested', request_id: 'request-revision', iteration: 2,
      details_markdown: '继续调整', summary: '继续调整', task: '继续调整',
    } as SDKSystemMessage

    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot, selectionRequired: false, loading: true, pendingAction: null, error: null,
    })
    const loadingHtml = renderToStaticMarkup(React.createElement(
      Provider,
      { store },
      React.createElement(WorktreeIterationRequestCard, { message, currentSessionId: 'session-1' }),
    ))
    expect(loadingHtml).toContain('正在加载请求状态…')
    expect(loadingHtml).toContain('inert=""')
    expect(loadingHtml).toContain('>撤回验收并继续修改</button>')
    expect(loadingHtml.match(/animate-spin/g)).toHaveLength(1)
    expect(loadingHtml).not.toContain('正在撤回验收…')
    const loadingButton = loadingHtml.match(/<button[^>]*>撤回验收并继续修改<\/button>/)?.[0]
    expect(loadingButton).toMatch(/\sdisabled(?:=|>)/)

    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot, selectionRequired: false, loading: true, pendingAction: 'rollback_preview', error: null,
    })
    const pendingHtml = renderToStaticMarkup(React.createElement(
      Provider,
      { store },
      React.createElement(WorktreeIterationRequestCard, { message, currentSessionId: 'session-1' }),
    ))
    expect(pendingHtml).toContain('正在撤回预览…')
    expect(pendingHtml).toContain('>撤回验收并继续修改</button>')
    expect(pendingHtml.match(/animate-spin/g)).toHaveLength(1)
  })

  test('放弃第一轮并清理 Worktree 后仍可点击创建第二轮', () => {
    const store = createStore()
    const snapshot: SessionTargetView = {
      project: { id: 'project-1', name: 'domi' },
      checkout: { id: 'checkout-1', kind: 'isolated', label: 'Isolated Checkout', phase: 'discarded', iteration: 1 },
      source: { ref: 'main', oid: 'a'.repeat(40) },
      current: { branch: 'main', oid: 'b'.repeat(40) },
      ownership: 'owner',
      dirty: false,
      revision: 4,
    }
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot,
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })
    const message = {
      type: 'system',
      subtype: 'worktree_next_iteration_requested',
      request_id: 'request-2',
      iteration: 2,
      details_markdown: '开始第二轮修改',
      summary: '开始第二轮修改',
      task: '开始第二轮修改',
    } as SDKSystemMessage

    const html = renderToStaticMarkup(React.createElement(
      Provider,
      { store },
      React.createElement(WorktreeIterationRequestCard, { message, currentSessionId: 'session-1' }),
    ))

    const button = html.match(/<button[^>]*>创建第 2 轮 Worktree 并继续<\/button>/)?.[0]
    expect(button).toBeDefined()
    expect(button).not.toMatch(/\sdisabled(?:=|>)/)

    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: { ...snapshot, ownership: 'inherited' },
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })
    const inheritedHtml = renderToStaticMarkup(React.createElement(
      Provider,
      { store },
      React.createElement(WorktreeIterationRequestCard, { message, currentSessionId: 'session-1' }),
    ))
    const inheritedButton = inheritedHtml.match(/<button[^>]*>创建第 2 轮 Worktree 并继续<\/button>/)?.[0]
    expect(inheritedButton).toMatch(/\sdisabled(?:=|>)/)
  })

  test('Commit 已创建但 Worktree 清理待重试时仍可点击创建下一轮', () => {
    const store = createStore()
    const review = {
      reviewId: 'review-3',
      iteration: 3,
      preparedAt: 1,
      summary: '第三轮已完成',
      validationStatus: 'passed' as const,
      tests: [],
      changedFiles: ['src/a.ts'],
      suggestedCommitMessage: 'fix: third iteration',
    }
    const snapshot: SessionTargetView = {
      project: { id: 'project-1', name: 'domi' },
      checkout: { id: 'checkout-3', kind: 'isolated', label: 'Isolated Checkout', phase: 'finalized' },
      source: { ref: 'main', oid: 'a'.repeat(40) },
      current: { branch: 'main', oid: 'b'.repeat(40) },
      ownership: 'owner',
      dirty: false,
      revision: 3,
      delivery: { state: 'finalized', review, commitOid: 'b'.repeat(40), cleanup: 'pending' },
    }
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot,
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })
    const message = {
      type: 'system',
      subtype: 'worktree_next_iteration_requested',
      request_id: 'request-4',
      iteration: 4,
      details_markdown: '继续第四轮修改',
      summary: '继续第四轮修改',
      task: '继续第四轮修改',
    } as SDKSystemMessage

    const html = renderToStaticMarkup(React.createElement(
      Provider,
      { store },
      React.createElement(WorktreeIterationRequestCard, { message, currentSessionId: 'session-1' }),
    ))

    const button = html.match(/<button[^>]*>创建第 4 轮 Worktree 并继续<\/button>/)?.[0]
    expect(button).toBeDefined()
    expect(button).not.toMatch(/\sdisabled(?:=|>)/)

    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: { ...snapshot, checkout: { ...snapshot.checkout, phase: 'recovery_required' } },
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
    })
    const recoveryHtml = renderToStaticMarkup(React.createElement(
      Provider,
      { store },
      React.createElement(WorktreeIterationRequestCard, { message, currentSessionId: 'session-1' }),
    ))
    const recoveryButton = recoveryHtml.match(/<button[^>]*>创建第 4 轮 Worktree 并继续<\/button>/)?.[0]
    expect(recoveryButton).toMatch(/\sdisabled(?:=|>)/)
  })
})

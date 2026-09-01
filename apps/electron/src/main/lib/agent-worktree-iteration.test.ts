import { describe, expect, test } from 'bun:test'
import type { SDKMessage, SessionTargetView } from '@domi/shared'
import {
  canOfferNextWorktreeIteration,
  canOfferWorktreePreviewRevision,
  requestNextWorktreeIteration,
  requestWorktreePreviewRevision,
  type AgentWorktreeIterationDependencies,
} from './agent-worktree-iteration.ts'

const deliveredTarget: SessionTargetView = {
  project: { id: 'project', name: 'Project' },
  checkout: { id: 'checkout-1', kind: 'isolated', label: 'Isolated Checkout', phase: 'discarded' },
  source: { ref: 'refs/heads/main', oid: 'a'.repeat(40) },
  current: { branch: 'main', oid: 'b'.repeat(40) },
  ownership: 'owner',
  dirty: false,
  revision: 8,
  delivery: { state: 'delivered', iteration: 1, commitOid: 'b'.repeat(40), deliveredAt: 1 },
}

const discardedTarget: SessionTargetView = {
  ...deliveredTarget,
  checkout: { ...deliveredTarget.checkout, iteration: 3 },
  revision: 11,
  delivery: undefined,
}

const review = {
  reviewId: 'review-1',
  iteration: 1,
  preparedAt: 1,
  summary: '初版验收',
  validationStatus: 'passed' as const,
  tests: [],
  suggestedCommitMessage: 'feat: first review',
  changedFiles: ['src/a.ts'],
}

const previewTarget: SessionTargetView = {
  ...deliveredTarget,
  checkout: { ...deliveredTarget.checkout, phase: 'ready' },
  revision: 9,
  delivery: {
    state: 'preview_active',
    previewedAt: 2,
    review,
  },
}

const finalizedTarget: SessionTargetView = {
  ...previewTarget,
  checkout: { ...previewTarget.checkout, phase: 'finalized' },
  revision: 10,
  delivery: {
    state: 'finalized',
    review,
    commitOid: 'b'.repeat(40),
    cleanup: 'pending',
  },
}

function dependencies(messages: SDKMessage[], target = deliveredTarget): AgentWorktreeIterationDependencies {
  return {
    inspectTarget: async () => target,
    persistMessages: (_sessionId, next) => messages.push(...next),
    createRequestId: () => 'request-1',
  }
}

describe('agent worktree iteration request', () => {
  test('仅向 direct interactive owner delivered 或 retained follow-up 暴露下一轮入口', () => {
    expect(canOfferNextWorktreeIteration({
      targetKind: 'isolated', ownership: 'owner', followupOnly: true, followupReason: 'delivered', triggeredBy: 'user',
    })).toBe(true)
    expect(canOfferNextWorktreeIteration({
      targetKind: 'isolated', ownership: 'owner', followupOnly: true, followupReason: 'retained', triggeredBy: 'user',
    })).toBe(true)
    expect(canOfferNextWorktreeIteration({
      targetKind: 'isolated', ownership: 'owner', followupOnly: true, followupReason: 'discarded', triggeredBy: 'user',
    })).toBe(true)
    expect(canOfferNextWorktreeIteration({
      targetKind: 'isolated', ownership: 'owner', followupOnly: true, followupReason: 'preview_active', triggeredBy: 'user',
    })).toBe(false)
    expect(canOfferNextWorktreeIteration({
      targetKind: 'isolated', ownership: 'owner', followupOnly: false, triggeredBy: 'user',
    })).toBe(false)
    expect(canOfferNextWorktreeIteration({
      targetKind: 'isolated', ownership: 'owner', followupOnly: true, triggeredBy: 'automation',
    })).toBe(false)
    expect(canOfferNextWorktreeIteration({
      targetKind: 'isolated', ownership: 'inherited', followupOnly: true, triggeredBy: 'user',
    })).toBe(false)
  })

  test('仅向 interactive owner preview follow-up 暴露撤回并继续入口', () => {
    expect(canOfferWorktreePreviewRevision({
      targetKind: 'isolated', ownership: 'owner', followupOnly: true, followupReason: 'preview_active', triggeredBy: 'user',
    })).toBe(true)
    expect(canOfferWorktreePreviewRevision({
      targetKind: 'isolated', ownership: 'owner', followupOnly: true, followupReason: 'delivered', triggeredBy: 'user',
    })).toBe(false)
  })

  test('放弃本轮修改后可基于 checkout iteration 请求创建干净的下一轮', async () => {
    const messages: SDKMessage[] = []
    const result = await requestNextWorktreeIteration('session-1', {
      details: '开始新的修改任务。',
      summary: '开始新的修改任务',
      task: '开始新的修改任务',
    }, dependencies(messages, discardedTarget))

    expect(result.iteration).toBe(4)
    expect(messages).toEqual([expect.objectContaining({
      subtype: 'worktree_next_iteration_requested',
      iteration: 4,
      checkout_id: 'checkout-1',
      expected_revision: 11,
    })])
  })

  test('Preview 调整请求持久化为同 iteration 的撤回确认，并单独保存卡片摘要', async () => {
    const messages: SDKMessage[] = []
    const result = await requestWorktreePreviewRevision('session-1', {
      details: '## 调整内容\n\n调整表单布局与间距。',
      summary: '调整表单布局与间距',
      task: '调整表单布局',
    }, dependencies(messages, previewTarget))

    expect(result).toEqual({
      requestId: 'request-1',
      iteration: 1,
      details: '## 调整内容\n\n调整表单布局与间距。',
      summary: '调整表单布局与间距',
      task: '调整表单布局',
    })
    expect(messages[0]).toMatchObject({
      type: 'system',
      subtype: 'worktree_preview_revision_requested',
      request_id: 'request-1',
      iteration: 1,
      details_markdown: '## 调整内容\n\n调整表单布局与间距。',
      summary: '调整表单布局与间距',
      task: '调整表单布局',
    })
  })

  test('持久化有界续跑任务和独立卡片摘要，并计算下一 iteration', async () => {
    const messages: SDKMessage[] = []
    const result = await requestNextWorktreeIteration(
      'session-1',
      {
        details: '## 调整内容\n\n修复请求卡输出并补测试。',
        summary: '修复请求卡输出并补测试',
        task: '修复 src/secret.ts 并补测试',
      },
      dependencies(messages),
    )

    expect(result).toEqual({
      requestId: 'request-1',
      iteration: 2,
      details: '## 调整内容\n\n修复请求卡输出并补测试。',
      summary: '修复请求卡输出并补测试',
      task: '修复 src/secret.ts 并补测试',
    })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      type: 'system',
      subtype: 'worktree_next_iteration_requested',
      request_id: 'request-1',
      iteration: 2,
      checkout_id: deliveredTarget.checkout.id,
      expected_revision: deliveredTarget.revision,
      details_markdown: '## 调整内容\n\n修复请求卡输出并补测试。',
      summary: '修复请求卡输出并补测试',
      task: '修复 src/secret.ts 并补测试',
    })
  })

  test('用户可见正文或续跑任务包含绝对路径时拒绝落库，避免生成路径占位符', async () => {
    const messages: SDKMessage[] = []

    await expect(requestNextWorktreeIteration(
      'session-1',
      {
        details: '从 `D:\\workspace\\demo\\domi` 的 Local 最新状态开始。',
        summary: '从 Local 最新状态开始',
        task: '修改 D:\\workspace\\demo\\domi\\src\\main.ts',
      },
      dependencies(messages),
    )).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('当前项目的 Local Checkout'),
    })
    expect(messages).toHaveLength(0)
  })

  test('用户可见正文中的 HTTPS 资料链接不被误判为 Windows 绝对路径', async () => {
    const messages: SDKMessage[] = []
    const result = await requestNextWorktreeIteration(
      'session-1',
      {
        details: '按 https://example.com/spec 的说明继续修改。',
        summary: '按外部规格继续修改',
        task: '按 https://example.com/spec 的说明继续修改',
      },
      dependencies(messages),
    )

    expect(result.details).toContain('https://example.com/spec')
    expect(messages).toHaveLength(1)
  })

  test('遗留路径占位符在进入下一轮或撤回 Preview 前都会被拒绝', async () => {
    const nextMessages: SDKMessage[] = []
    await expect(requestNextWorktreeIteration(
      'session-1',
      { details: '从 `[路径]` 开始修改', summary: '继续修改', task: '继续修改' },
      dependencies(nextMessages),
    )).rejects.toMatchObject({ code: 'invalid_input' })
    expect(nextMessages).toHaveLength(0)

    const previewMessages: SDKMessage[] = []
    await expect(requestWorktreePreviewRevision(
      'session-1',
      { details: '继续调整', summary: '继续调整', task: '修改 <path> 中的布局' },
      dependencies(previewMessages, previewTarget),
    )).rejects.toMatchObject({ code: 'invalid_input' })
    expect(previewMessages).toHaveLength(0)
  })

  test('Commit 已创建但 cleanup 待处理时仍可持久化下一 iteration 请求', async () => {
    const messages: SDKMessage[] = []
    const result = await requestNextWorktreeIteration(
      'session-1',
      { details: '继续修复接口编号', summary: '继续修复接口编号', task: '继续修复接口编号' },
      dependencies(messages, finalizedTarget),
    )

    expect(result).toEqual({
      requestId: 'request-1', iteration: 2, details: '继续修复接口编号', summary: '继续修复接口编号', task: '继续修复接口编号',
    })
    expect(messages[0]).toMatchObject({ subtype: 'worktree_next_iteration_requested', iteration: 2 })
  })

  test('finalized delivery 仍处于 recovery_required 时不允许绕过 Local 身份检查', async () => {
    const messages: SDKMessage[] = []
    const recovery = {
      ...finalizedTarget,
      checkout: { ...finalizedTarget.checkout, phase: 'recovery_required' as const },
    }
    await expect(requestNextWorktreeIteration(
      'session-1',
      { details: '继续修改', summary: '继续修改', task: '继续修改' },
      dependencies(messages, recovery),
    )).rejects.toMatchObject({ code: 'operation_not_allowed' })
    expect(messages).toHaveLength(0)
  })

  test('权威目标不再 delivered 时 fail closed', async () => {
    const messages: SDKMessage[] = []
    const working = { ...deliveredTarget, delivery: { state: 'working' as const, iteration: 2 } }
    await expect(requestNextWorktreeIteration(
      'session-1',
      { details: '继续修改', summary: '继续修改', task: '继续修改' },
      dependencies(messages, working),
    )).rejects.toMatchObject({ code: 'operation_not_allowed' })
    expect(messages).toHaveLength(0)
  })

  test('摘要为空时拒绝创建请求卡', async () => {
    const messages: SDKMessage[] = []
    await expect(requestNextWorktreeIteration(
      'session-1',
      { details: '继续修改', summary: '  ', task: '继续修改' },
      dependencies(messages),
    )).rejects.toMatchObject({ code: 'invalid_input' })
    expect(messages).toHaveLength(0)
  })
})

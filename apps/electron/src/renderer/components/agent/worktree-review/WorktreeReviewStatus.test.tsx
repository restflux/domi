import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { SessionCheckoutAction, SessionTargetView, WorktreeDeliveryView } from '@domi/shared'
import { sessionTargetStateAtomFamily } from '@/atoms/session-target-atoms.ts'
import { WorktreeReviewStatus } from './WorktreeReviewStatus.tsx'

const review = {
  reviewId: 'review-1',
  iteration: 1,
  preparedAt: 1,
  summary: '完成任务',
  validationStatus: 'passed' as const,
  tests: [],
  changedFiles: ['src/a.ts'],
  suggestedCommitMessage: 'fix: task',
}

function target(delivery: WorktreeDeliveryView, overrides: Partial<SessionTargetView> = {}): SessionTargetView {
  return {
    project: { id: 'project-1', name: 'domi' },
    checkout: { id: 'checkout-1', kind: 'isolated', label: 'Isolated Checkout', phase: delivery.state === 'delivered' ? 'discarded' : delivery.state === 'retained' ? 'retained' : delivery.state === 'finalized' ? 'finalized' : 'ready' },
    source: { ref: 'main', oid: 'abcdef0123456789' },
    current: { branch: null, oid: 'abcdef0123456789' },
    ownership: 'owner',
    dirty: false,
    revision: 1,
    delivery,
    ...overrides,
  }
}

function renderStatus(
  delivery: WorktreeDeliveryView,
  overrides?: Partial<SessionTargetView>,
  options: {
    railKind?: 'worktree_active' | 'worktree_settled'
    legacySurface?: boolean
    loading?: boolean
    pendingAction?: SessionCheckoutAction | null
  } = {},
): string {
  const store = createStore()
  store.set(sessionTargetStateAtomFamily('session-1'), {
    snapshot: target(delivery, overrides),
    selectionRequired: false,
    loading: options.loading ?? false,
    pendingAction: options.pendingAction ?? null,
    error: null,
  })
  return renderToStaticMarkup(
    <Provider store={store}>
      <WorktreeReviewStatus sessionId="session-1" railKind={options.railKind} legacySurface={options.legacySurface} />
    </Provider>,
  )
}

describe('WorktreeReviewStatus current delivery actions', () => {
  test('待验收状态收敛为贴近输入框的轻量验收入口', () => {
    const html = renderStatus({ state: 'ready_for_review', review })

    expect(html).toContain('新修改待验收')
    expect(html).toContain('查看验收卡')
    expect(html).toContain('bg-sky-400')
    expect(html).toContain('lucide-clipboard-check')
    expect(html).toContain('mx-2 rounded-none border-0 bg-transparent')
    expect(html).toContain('aria-label="更多交付操作"')
  })

  test('初始化加载只显示一个中性 Spinner，不冒充具体操作', () => {
    const html = renderStatus(
      { state: 'ready_for_review', review },
      undefined,
      { loading: true },
    )

    expect(html).toContain('正在加载验收状态…')
    expect(html).toContain('查看验收卡</button>')
    expect(html.match(/animate-spin/g)).toHaveLength(1)
    expect(html).not.toContain('处理中…')
    const reviewButton = html.match(/<button[^>]*>.*查看验收卡<\/button>/)?.[0]
    expect(reviewButton).toMatch(/\sdisabled(?:=|>)/)
  })

  test('真实操作只在 rail 图标处显示一个准确 Spinner，按钮文案保持稳定', () => {
    const html = renderStatus(
      { state: 'preview_active', review, previewedAt: 2 },
      undefined,
      { pendingAction: 'rollback_preview' },
    )

    expect(html).toContain('正在撤回预览…')
    expect(html).toContain('查看验收卡</button>')
    expect(html.match(/animate-spin/g)).toHaveLength(1)
    expect(html).not.toContain('处理中…')
    const reviewButton = html.match(/<button[^>]*>.*查看验收卡<\/button>/)?.[0]
    expect(reviewButton).toMatch(/\sdisabled(?:=|>)/)
  })

  test('已放弃的 Worktree 即使残留旧验收快照也不再显示待验收状态条', () => {
    const html = renderStatus(
      { state: 'ready_for_review', review },
      { checkout: { id: 'checkout-1', kind: 'isolated', label: 'Isolated Checkout', phase: 'discarded' } },
    )

    expect(html).toBe('')
  })

  test('已保存当前验收阶段时仍保留同步主操作并隐藏重复保存入口', () => {
    const html = renderStatus(
      { state: 'ready_for_review', review },
      { checkpoints: [{ checkpointId: 'checkpoint-1', sequence: 1, reviewId: review.reviewId, createdAt: 1, summary: '完成任务', validationStatus: 'passed', changedFiles: ['src/a.ts'] }] },
    )

    expect(html).toContain('新修改待验收')
    expect(html).toContain('查看验收卡')
    expect(html).not.toContain('保存阶段并继续')
  })

  test('验收槽位被占用且预检返回 busy 时等待按钮仍可点击并提示可查看占用任务', () => {
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: target(
        { state: 'ready_for_review', review },
        { reviewSlot: 'waiting', reviewSlotOwnerSessionId: 'session-owner' },
      ),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
      preflight: {
        status: 'blocked', localModified: false, checkoutId: 'checkout-1', reviewId: 'review-1', revision: 1,
        reason: 'project_acceptance_busy', message: '另一个任务正在占用该项目的 Local 验收槽位',
      },
    })
    const html = renderToStaticMarkup(<Provider store={store}><WorktreeReviewStatus sessionId="session-1" /></Provider>)

    const reviewButton = html.match(/<button[^>]*>.*查看验收卡<\/button>/)?.[0]
    expect(reviewButton).toBeDefined()
    expect(reviewButton).not.toContain('title=')
    expect(reviewButton).not.toMatch(/\sdisabled(?:=|>)/)
  })

  test('预检发现冲突时状态栏展示结构化结论并提供让 Agent 解决的可点击入口', () => {
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: target({ state: 'ready_for_review', review }),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
      preflight: {
        status: 'conflict', localModified: false, checkoutId: 'checkout-1', reviewId: 'review-1', revision: 1,
        configuredBaseOid: 'a'.repeat(40), effectiveBaseOid: 'a'.repeat(40), baseStrategy: 'recorded_base',
        localBranch: 'main', localHeadOid: 'b'.repeat(40), isolatedHeadOid: 'c'.repeat(40),
        changedFiles: ['src/a.ts'], conflictingFiles: ['src/a.ts'],
      },
    })
    const html = renderToStaticMarkup(<Provider store={store}><WorktreeReviewStatus sessionId="session-1" /></Provider>)

    expect(html).toContain('本次修改暂时无法预览 · 1 个文件冲突')
    const reviewButton = html.match(/<button[^>]*>.*查看验收卡<\/button>/)?.[0]
    expect(reviewButton).toBeDefined()
    expect(reviewButton).not.toMatch(/\sdisabled(?:=|>)/)
  })

  test('Worktree 在 Ready 后变化时提供可点击的重新生成验收结果入口', () => {
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: target({ state: 'ready_for_review', review }),
      selectionRequired: false,
      loading: false,
      pendingAction: null,
      error: null,
      preflight: {
        status: 'blocked', localModified: false, checkoutId: 'checkout-1', reviewId: 'review-1', revision: 1,
        reason: 'stale_isolated', message: 'Worktree 在准备验收后发生变化，请重新生成验收结果',
      },
    })
    const html = renderToStaticMarkup(<Provider store={store}><WorktreeReviewStatus sessionId="session-1" /></Provider>)

    expect(html).toContain('暂时无法预览 · Worktree 在准备验收后发生变化，请重新生成验收结果')
    const reviewButton = html.match(/<button[^>]*>.*查看验收卡<\/button>/)?.[0]
    expect(reviewButton).toBeDefined()
    expect(reviewButton).not.toMatch(/\sdisabled(?:=|>)/)
  })

  test('Local 验收中状态使用验收通过并交付到 Local 作为主操作', () => {
    const html = renderStatus({ state: 'preview_active', review, previewedAt: 2 })

    expect(html).toContain('正在预览本次修改')
    expect(html).toContain('查看验收卡')
    expect(html).toContain('bg-amber-400')
  })

  test('Local 验收中只有安全可释放的协作占用时恢复一键释放并交付入口', () => {
    const html = renderStatus(
      { state: 'preview_active', review, previewedAt: 2 },
      { collaborators: [{ sessionId: 'child-1', title: '已完成协作', kind: 'delegation', status: 'completed', canRelease: true }] },
    )

    const reviewButton = html.match(/<button[^>]*>.*查看验收卡<\/button>/)?.[0]
    expect(reviewButton).toBeDefined()
    expect(reviewButton).not.toMatch(/\sdisabled(?:=|>)/)
  })

  test('Local 验收中仍有运行协作者时提交入口保持关闭', () => {
    const html = renderStatus(
      { state: 'preview_active', review, previewedAt: 2 },
      { collaborators: [{ sessionId: 'child-1', title: '运行中的协作', kind: 'delegation', status: 'running', canRelease: false }] },
    )

    const reviewButton = html.match(/<button[^>]*>.*查看验收卡<\/button>/)?.[0]
    expect(reviewButton).toBeDefined()
    expect(reviewButton).not.toMatch(/\sdisabled(?:=|>)/)
  })

  test('Preview 操作中断进入 recovery 时只提供恢复撤回主操作，不再引导直接提交', () => {
    const html = renderStatus(
      { state: 'preview_active', review, previewedAt: 2 },
      { checkout: { id: 'checkout-1', kind: 'isolated', label: 'Isolated Checkout', phase: 'recovery_required' } },
    )

    expect(html).toContain('预览需要恢复，安全记录已保留')
    expect(html).toContain('查看验收卡')
    expect(html).not.toContain('>确认并保存</button>')
  })

  test('旧 Preview 进入 detached 后可直接提交、重新撤回或交接到新会话', () => {
    const html = renderStatus({
      state: 'preview_detached',
      review,
      previewedAt: 2,
      detachedAt: 3,
      reason: 'stale_local',
      attemptedAction: 'discard',
    })

    expect(html).toContain('当前项目已有新变化，本次修改仍可保存')
    expect(html).toContain('查看验收卡')
    expect(html).toContain('aria-label="更多交付操作"')
  })

  test('清理待重试状态使用重试清理环境作为主操作', () => {
    const html = renderStatus({ state: 'finalized', review, commitOid: 'abcdef0123456789', cleanup: 'pending' })

    expect(html).toContain('修改已保存，运行环境清理待重试')
    expect(html).toContain('查看验收卡')
  })

  test('保留环境清理失败时使用重试清理环境作为主操作', () => {
    const html = renderStatus({
      state: 'retained',
      review,
      commitOid: 'abcdef0123456789',
      retention: 'retain_manual',
      retainedAt: 2,
      expiresAt: null,
      cleanup: 'blocked',
    })

    expect(html).toContain('重试清理环境')
    expect(html).toContain('text-amber-500')
    expect(html).not.toContain('>开始下一轮修改</button>')
  })

  test('已交付状态使用透明的 settled 元信息行和开始下一轮修改主操作', () => {
    const html = renderStatus(
      { state: 'delivered', iteration: 1, commitOid: 'abcdef0123456789', deliveredAt: 3 },
      undefined,
      { railKind: 'worktree_settled' },
    )

    expect(html).toContain('data-composer-action-rail="worktree_settled"')
    expect(html).toContain('text-emerald-500')
    expect(html).toContain('开始下一轮修改')
    expect(html).toContain('bg-transparent')
    expect(html).not.toContain('legacy-worktree-review-status')
    expect(html).not.toContain('border-blue-500/20')
    expect(html).not.toContain('bg-blue-500/5')
    expect(html).not.toContain('aria-label="更多交付操作"')
  })

  test('classic 与 terminal 状态仍可显式使用旧的内嵌表面', () => {
    const html = renderStatus(
      { state: 'delivered', iteration: 1, commitOid: 'abcdef0123456789', deliveredAt: 3 },
      undefined,
      { legacySurface: true },
    )

    expect(html).toContain('legacy-worktree-review-status')
    expect(html).toContain('border-blue-500/20')
    expect(html).toContain('bg-blue-500/5')
  })
})

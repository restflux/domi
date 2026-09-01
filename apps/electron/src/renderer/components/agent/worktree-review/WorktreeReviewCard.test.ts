import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Provider, createStore } from 'jotai'
import type { SDKSystemMessage } from '@domi/shared'
import { sessionTargetStateAtomFamily } from '@/atoms/session-target-atoms.ts'
import { WorktreeReviewCard, directFinishAction, directFinishActionLabel, directFinishBlockReason, isWorktreeReviewIdentityAuthorized, nextAutomaticPreflightKey, parseWorktreeReviewNotice, partitionCollaboratorsForBulkRelease, worktreeDeliveryProofSummary, worktreePreflightSummary } from './WorktreeReviewCard.tsx'

describe('WorktreeReviewCard sync explainability', () => {
  test('preflight summaries distinguish direct sync, advanced Local, conflict and blocked states', () => {
    const facts = {
      localModified: false as const,
      checkoutId: 'checkout-1', reviewId: 'review-1', revision: 2,
      configuredBaseOid: 'a'.repeat(40), effectiveBaseOid: 'a'.repeat(40),
      baseStrategy: 'recorded_base' as const, localBranch: 'main',
      localHeadOid: 'a'.repeat(40), isolatedHeadOid: 'b'.repeat(40), changedFiles: ['src/a.ts'],
    }
    expect(worktreePreflightSummary({ ...facts, status: 'ready' })).toContain('可以安全预览')
    expect(worktreePreflightSummary({ ...facts, status: 'local_advanced' })).toContain('可以安全合并后预览')
    expect(worktreePreflightSummary({ ...facts, status: 'conflict', conflictingFiles: ['src/a.ts'] })).toContain('1 个文件')
    expect(worktreePreflightSummary({
      status: 'blocked', localModified: false, checkoutId: 'checkout-1', reviewId: 'review-1', revision: 2,
      reason: 'project_acceptance_busy', message: '验收槽位被占用',
    })).toBe('另一个任务正在预览此项目的修改')
  })

  test('bulk release partition only permits one-click continuation when every collaborator is safely releasable', () => {
    const completed = { sessionId: 'child-1', title: '完成项', kind: 'delegation' as const, status: 'completed' as const, canRelease: true }
    const cancelled = { sessionId: 'child-2', title: '取消项', kind: 'delegation' as const, status: 'cancelled' as const, canRelease: true }
    const running = { sessionId: 'child-3', title: '运行项', kind: 'delegation' as const, status: 'running' as const, canRelease: false }

    expect(partitionCollaboratorsForBulkRelease([completed, cancelled])).toMatchObject({
      releasable: [completed, cancelled], blocked: [], canReleaseAll: true,
    })
    expect(partitionCollaboratorsForBulkRelease([completed, running])).toMatchObject({
      releasable: [completed], blocked: [running], canReleaseAll: false,
    })
  })

  test('safe collaborator release remains a one-click step before direct finish while unsafe occupancy stays blocked', () => {
    expect(directFinishBlockReason({ waitingForSlot: false, blockedByCollaborator: true, canReleaseAll: true })).toBeNull()
    expect(directFinishAction({ waitingForSlot: false, blockedByCollaborator: true, canReleaseAll: true })).toBe('release_collaborators')
    expect(directFinishActionLabel({ waitingForSlot: false, blockedByCollaborator: true, canReleaseAll: true, releasableCount: 1 })).toBe('结束 1 个占用并保存')
    expect(directFinishBlockReason({ waitingForSlot: false, blockedByCollaborator: true, canReleaseAll: false })).toBe('请先停止或等待仍在运行的协作会话，再释放 Worktree 占用。')
    expect(directFinishAction({ waitingForSlot: false, blockedByCollaborator: true, canReleaseAll: false })).toBe('blocked')
    expect(directFinishActionLabel({ waitingForSlot: false, blockedByCollaborator: true, canReleaseAll: false, releasableCount: 1 })).toBe('跳过预览并保存（协作占用未结束）')
  })

  test('acceptance busy keeps navigation available, exposes one checkpoint entry and blocks direct finish until the Local slot is released', () => {
    expect(directFinishBlockReason({ waitingForSlot: true, blockedByCollaborator: false, canReleaseAll: false })).toBe('另一个任务正在预览此项目的修改。请先完成或撤回该预览，再保存本轮修改。')
    expect(directFinishBlockReason({ waitingForSlot: false, blockedByCollaborator: false, canReleaseAll: false })).toBeNull()

    const store = createStore()
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: {
        project: { id: 'project-1', name: 'domi' },
        checkout: { id: 'checkout-1', kind: 'isolated', label: 'Worktree', phase: 'ready' },
        source: { ref: 'main', oid: 'a'.repeat(40) },
        current: { branch: null, oid: 'a'.repeat(40) },
        ownership: 'owner', dirty: true, revision: 7,
        delivery: {
          state: 'ready_for_review',
          review: {
            reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: '完成任务', validationStatus: 'passed',
            tests: [], changedFiles: ['src/a.ts'], suggestedCommitMessage: 'fix: task',
          },
        },
        reviewSlot: 'waiting',
        reviewSlotOwnerSessionId: 'session-owner',
      },
      selectionRequired: false, loading: false, pendingAction: null, error: null,
      preflight: {
        status: 'blocked', localModified: false, checkoutId: 'checkout-1', reviewId: 'review-1', revision: 7,
        reason: 'project_acceptance_busy', message: '另一个任务正在占用该项目的 Local 验收槽位',
      },
    })
    const message = {
      type: 'system', subtype: 'worktree_ready_for_review', session_id: 'session-1', checkout_id: 'checkout-1', review_id: 'review-1',
      iteration: 1, summary: '完成任务', details_markdown: '## 变更说明\n\n完成任务。', validation_status: 'passed',
      tests: [], changed_files: ['src/a.ts'], suggested_commit_message: 'fix: task',
    } as unknown as SDKSystemMessage

    const html = renderToStaticMarkup(createElement(Provider, { store }, createElement(WorktreeReviewCard, { message, currentSessionId: 'session-1' })))

    const waitingButton = html.match(/<button[^>]*title="点击查看正在预览此项目修改的任务"[^>]*>.*查看正在预览的任务<\/button>/)?.[0]
    expect(waitingButton).toBeDefined()
    expect(waitingButton).not.toMatch(/\sdisabled(?:=|>)/)
    expect(html).toContain('待你确认')
    expect(html).toContain('保存进度')
    expect(html).toContain('另一个任务正在预览此项目的修改')
    expect(html).toContain('请先完成或撤回该预览，再处理本轮。')
    expect(html).not.toContain('Local 验收槽位')
    expect(html).not.toContain('另一个任务正在预览修改。请先完成或撤回那个预览，再处理本轮。')
    expect(html.match(/另一个任务正在/g)).toHaveLength(1)
  })

  test('saved Checkpoint keeps the reviewed card active for immediate Local sync without offering a duplicate save', () => {
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: {
        project: { id: 'project-1', name: 'domi' },
        checkout: { id: 'checkout-1', kind: 'isolated', label: 'Worktree', phase: 'ready' },
        source: { ref: 'main', oid: 'a'.repeat(40) }, current: { branch: null, oid: 'b'.repeat(40) },
        ownership: 'owner', dirty: false, revision: 8,
        delivery: {
          state: 'ready_for_review',
          review: { reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: '阶段 A', validationStatus: 'passed', tests: [], changedFiles: ['src/a.ts'], suggestedCommitMessage: 'fix: task' },
        },
        checkpoints: [{ checkpointId: 'checkpoint-1', sequence: 1, reviewId: 'review-1', createdAt: 1, summary: '阶段 A', validationStatus: 'passed', changedFiles: ['src/a.ts'] }],
      },
      selectionRequired: false, loading: false, pendingAction: null, error: null,
      preflight: {
        status: 'ready', localModified: false, checkoutId: 'checkout-1', reviewId: 'review-1', revision: 8,
        configuredBaseOid: 'a'.repeat(40), effectiveBaseOid: 'a'.repeat(40), baseStrategy: 'recorded_base',
        localBranch: 'main', localHeadOid: 'a'.repeat(40), isolatedHeadOid: 'b'.repeat(40), changedFiles: ['src/a.ts'],
      },
    })
    const message = {
      type: 'system', subtype: 'worktree_ready_for_review', session_id: 'session-1', checkout_id: 'checkout-1', review_id: 'review-1',
      iteration: 1, summary: '阶段 A', validation_status: 'passed', tests: [], changed_files: ['src/a.ts'], suggested_commit_message: 'fix: task',
    } as unknown as SDKSystemMessage

    const html = renderToStaticMarkup(createElement(Provider, { store }, createElement(WorktreeReviewCard, { message, currentSessionId: 'session-1' })))

    expect(html).toContain('data-worktree-review-layout="split"')
    expect(html).toContain('data-worktree-review-section="summary"')
    expect(html).toContain('data-worktree-review-section="decision"')
    expect(html).toContain('Review 01')
    expect(html).toContain('新验收')
    expect(html).toContain('border-l-2 border-l-sky-500/80')
    expect(html).toContain('bg-sky-400')
    expect(html).toContain('border-sky-500/70 text-sky-400')
    expect(html).toContain('修改已完成')
    expect(html).toContain('含 <span class="text-foreground/80">1</span> 个已保存进度')
    expect(html).toContain('1 个文件已更新')
    expect(html).toContain('查看变更与技术详情')
    expect(html).toContain('待你确认')
    expect(html).toContain('预览修改')
    expect(html).toContain('可撤回，不会立即保存')
    expect(html).not.toContain('保存进度并继续')
  })

  test('card-level busy state keeps button labels stable and renders exactly one Spinner', () => {
    const store = createStore()
    const message = {
      type: 'system', subtype: 'worktree_ready_for_review', session_id: 'session-1', checkout_id: 'checkout-1', review_id: 'review-1',
      iteration: 1, summary: '完成任务', validation_status: 'passed', tests: [], changed_files: ['src/a.ts'], suggested_commit_message: 'fix: task',
    } as unknown as SDKSystemMessage
    const review = {
      reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: '完成任务', validationStatus: 'passed' as const,
      tests: [], changedFiles: ['src/a.ts'], suggestedCommitMessage: 'fix: task',
    }
    const baseSnapshot = {
      project: { id: 'project-1', name: 'domi' },
      checkout: { id: 'checkout-1', kind: 'isolated' as const, label: 'Worktree', phase: 'ready' as const },
      source: { ref: 'main', oid: 'a'.repeat(40) }, current: { branch: null, oid: 'a'.repeat(40) },
      ownership: 'owner' as const, dirty: true, revision: 8,
    }

    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: { ...baseSnapshot, delivery: { state: 'ready_for_review', review } },
      selectionRequired: false, loading: true, pendingAction: null, error: null,
    })
    const loadingHtml = renderToStaticMarkup(createElement(Provider, { store }, createElement(WorktreeReviewCard, { message, currentSessionId: 'session-1' })))
    expect(loadingHtml).toContain('aria-busy="true"')
    expect(loadingHtml).toContain('inert=""')
    expect(loadingHtml).toContain('pointer-events-none opacity-60')
    expect(loadingHtml).toContain('正在加载验收状态…')
    expect(loadingHtml).toContain('>预览修改</button>')
    expect(loadingHtml.match(/animate-spin/g)).toHaveLength(1)
    expect(loadingHtml).not.toContain('正在创建预览…')
    const previewButton = loadingHtml.match(/<button[^>]*>预览修改<\/button>/)?.[0]
    expect(previewButton).toMatch(/\sdisabled(?:=|>)/)

    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: { ...baseSnapshot, delivery: { state: 'preview_active', review, previewedAt: 2 } },
      selectionRequired: false, loading: true, pendingAction: 'rollback_preview', error: null,
    })
    const rollbackHtml = renderToStaticMarkup(createElement(Provider, { store }, createElement(WorktreeReviewCard, { message, currentSessionId: 'session-1' })))
    expect(rollbackHtml).toContain('正在撤回预览…')
    expect(rollbackHtml).toContain('>确认保存</button>')
    expect(rollbackHtml).toContain('>撤回预览</button>')
    expect(rollbackHtml).toContain('修改正在预览')
    expect(rollbackHtml.match(/animate-spin/g)).toHaveLength(1)
    expect(rollbackHtml).not.toContain('处理中…')
    const rollbackButton = rollbackHtml.match(/<button[^>]*>.*撤回预览<\/button>/)?.[0]
    expect(rollbackButton).toMatch(/\sdisabled(?:=|>)/)
  })

  test('discarded Worktree keeps the review as history but removes every pending review action', () => {
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: {
        project: { id: 'project-1', name: 'domi' },
        checkout: { id: 'checkout-1', kind: 'isolated', label: 'Worktree', phase: 'discarded' },
        source: { ref: 'main', oid: 'a'.repeat(40) }, current: { branch: null, oid: 'a'.repeat(40) },
        ownership: 'owner', dirty: false, revision: 8,
        delivery: {
          state: 'ready_for_review',
          review: { reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: '已完成但放弃', validationStatus: 'passed', tests: [], changedFiles: ['src/a.ts'], suggestedCommitMessage: 'fix: task' },
        },
      },
      selectionRequired: false, loading: false, pendingAction: null, error: null,
    })
    const message = {
      type: 'system', subtype: 'worktree_ready_for_review', session_id: 'session-1', checkout_id: 'checkout-1', review_id: 'review-1',
      iteration: 1, summary: '已完成但放弃', validation_status: 'passed', tests: [], changed_files: ['src/a.ts'], suggested_commit_message: 'fix: task',
    } as unknown as SDKSystemMessage

    const html = renderToStaticMarkup(createElement(Provider, { store }, createElement(WorktreeReviewCard, { message, currentSessionId: 'session-1' })))

    expect(html).toContain('data-worktree-review-layout="history"')
    expect(html).toContain('data-worktree-review-section="history"')
    expect(html).toContain('第 1 轮修改已放弃')
    expect(html).toContain('查看详情')
    expect(html).not.toContain('data-worktree-review-section="decision"')
    expect(html).not.toContain('>预览修改</button>')
    expect(html).not.toContain('aria-label="更多交付操作"')
  })

  test('active Local Preview separates final delivery, Worktree checkpoint and rollback actions', () => {
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: {
        project: { id: 'project-1', name: 'domi' },
        checkout: { id: 'checkout-1', kind: 'isolated', label: 'Worktree', phase: 'ready' },
        source: { ref: 'main', oid: 'a'.repeat(40) }, current: { branch: null, oid: 'a'.repeat(40) },
        ownership: 'owner', dirty: true, revision: 8,
        delivery: {
          state: 'preview_active', previewedAt: 2,
          review: { reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: '完成任务', validationStatus: 'passed', tests: [], changedFiles: ['src/a.ts'], suggestedCommitMessage: 'fix: task' },
        },
        checkpoints: [{ checkpointId: 'checkpoint-1', sequence: 1, reviewId: 'old-review', createdAt: 1, summary: '阶段 A', validationStatus: 'passed', changedFiles: ['src/old.ts'] }],
      },
      selectionRequired: false, loading: false, pendingAction: null, error: null,
    })
    const message = {
      type: 'system', subtype: 'worktree_ready_for_review', session_id: 'session-1', checkout_id: 'checkout-1', review_id: 'review-1',
      iteration: 1, summary: '完成任务', validation_status: 'passed', tests: [], changed_files: ['src/a.ts'], suggested_commit_message: 'fix: task',
    } as unknown as SDKSystemMessage

    const html = renderToStaticMarkup(createElement(Provider, { store }, createElement(WorktreeReviewCard, { message, currentSessionId: 'session-1' })))

    expect(html).toContain('修改正在预览')
    expect(html).toContain('检查预览效果')
    expect(html).toContain('bg-amber-400')
    expect(html).toContain('border-amber-500/70 text-amber-400')
    expect(html).not.toContain('新验收')
    expect(html).toContain('确认保存')
    const rollbackButton = html.match(/<button[^>]*>.*撤回预览<\/button>/)?.[0]
    expect(rollbackButton).toBeDefined()
    expect(rollbackButton).toContain('border-border/60')
    expect(html).toContain('保存进度')
    expect(html).toContain('含 <span class="text-foreground/80">1</span> 个已保存进度')
  })

  test('detached Preview offers direct delivery on the latest Local state and keeps rollback as a secondary action', () => {
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: {
        project: { id: 'project-1', name: 'domi' },
        checkout: { id: 'checkout-1', kind: 'isolated', label: 'Worktree', phase: 'ready' },
        source: { ref: 'main', oid: 'a'.repeat(40) }, current: { branch: null, oid: 'b'.repeat(40) },
        ownership: 'owner', dirty: true, revision: 9,
        delivery: {
          state: 'preview_detached', previewedAt: 2, detachedAt: 3, reason: 'stale_local', attemptedAction: 'rollback_preview',
          review: { reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: '完成任务', validationStatus: 'passed', tests: [], changedFiles: ['src/a.ts'], suggestedCommitMessage: 'fix: task' },
        },
      },
      selectionRequired: false, loading: false, pendingAction: null, error: null,
    })
    const message = {
      type: 'system', subtype: 'worktree_ready_for_review', session_id: 'session-1', checkout_id: 'checkout-1', review_id: 'review-1',
      iteration: 1, summary: '完成任务', validation_status: 'passed', tests: [], changed_files: ['src/a.ts'], suggested_commit_message: 'fix: task',
    } as unknown as SDKSystemMessage

    const html = renderToStaticMarkup(createElement(Provider, { store }, createElement(WorktreeReviewCard, { message, currentSessionId: 'session-1' })))

    expect(html).toContain('基于最新 Local 重新计算')
    expect(html).toContain('保存修改')
    expect(html).toContain('需要重新确认')
    expect(html).toContain('aria-label="更多交付操作"')
    expect(html).toContain('当前项目已有新变化')
  })

  test('failed automatic preflight stops retrying and exposes an explicit retry action instead of flashing forever', () => {
    const store = createStore()
    const message = {
      type: 'system', subtype: 'worktree_ready_for_review', session_id: 'session-1', checkout_id: 'checkout-1', review_id: 'review-1',
      iteration: 1, summary: '完成任务', details_markdown: '## 变更说明\n\n完成任务。', validation_status: 'passed',
      tests: [], changed_files: ['src/a.ts'], suggested_commit_message: 'fix: task',
    } as unknown as SDKSystemMessage
    const notice = parseWorktreeReviewNotice(message)
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: {
        project: { id: 'project-1', name: 'domi' },
        checkout: { id: 'checkout-1', kind: 'isolated', label: 'Worktree', phase: 'ready' },
        source: { ref: 'main', oid: 'a'.repeat(40) },
        current: { branch: null, oid: 'a'.repeat(40) },
        ownership: 'owner', dirty: true, revision: 7,
        delivery: {
          state: 'ready_for_review',
          review: {
            reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: '完成任务', validationStatus: 'passed',
            tests: [], changedFiles: ['src/a.ts'], suggestedCommitMessage: 'fix: task',
          },
        },
      },
      selectionRequired: false, loading: false, pendingAction: null, error: null,
      preflight: null,
      preflightLoading: false,
      preflightError: null,
    })

    const initialState = store.get(sessionTargetStateAtomFamily('session-1'))
    const attemptKey = nextAutomaticPreflightKey('session-1', notice, initialState, null)
    expect(attemptKey).toBe('session-1:checkout-1:review-1:7:unknown')

    store.set(sessionTargetStateAtomFamily('session-1'), {
      ...initialState,
      preflightError: { code: 'preflight_failed', message: 'Git 预检暂时不可用' },
    })
    const failedState = store.get(sessionTargetStateAtomFamily('session-1'))
    expect(nextAutomaticPreflightKey('session-1', notice, failedState, attemptKey)).toBeNull()
    expect(nextAutomaticPreflightKey('session-1', notice, { ...failedState, preflightError: null }, attemptKey)).toBeNull()
    expect(nextAutomaticPreflightKey('session-1', notice, {
      ...failedState,
      snapshot: failedState.snapshot ? { ...failedState.snapshot, reviewSlot: 'available' } : null,
      preflightError: null,
    }, attemptKey)).toBe('session-1:checkout-1:review-1:7:available')

    const html = renderToStaticMarkup(createElement(Provider, { store }, createElement(WorktreeReviewCard, { message, currentSessionId: 'session-1' })))
    expect(html).toContain('安全检查失败：Git 预检暂时不可用')
    expect(html).toContain('重新检查')
    expect(html).not.toContain('正在检查是否可以安全预览')
  })

  test('stale Worktree review explains the expired fingerprint and exposes one-click regeneration instead of a generic blocker', () => {
    const store = createStore()
    store.set(sessionTargetStateAtomFamily('session-1'), {
      snapshot: {
        project: { id: 'project-1', name: 'domi' },
        checkout: { id: 'checkout-1', kind: 'isolated', label: 'Worktree', phase: 'ready' },
        source: { ref: 'main', oid: 'a'.repeat(40) },
        current: { branch: null, oid: 'a'.repeat(40) },
        ownership: 'owner', dirty: true, revision: 7,
        delivery: {
          state: 'ready_for_review',
          review: {
            reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: '完成任务', validationStatus: 'passed',
            tests: [], changedFiles: ['src/a.ts'], suggestedCommitMessage: 'fix: task',
          },
        },
      },
      selectionRequired: false, loading: false, pendingAction: null, error: null,
      preflight: {
        status: 'blocked', localModified: false, checkoutId: 'checkout-1', reviewId: 'review-1', revision: 7,
        reason: 'stale_isolated', message: 'Worktree 在准备验收后发生变化，请重新生成验收结果',
      },
    })
    const message = {
      type: 'system', subtype: 'worktree_ready_for_review', session_id: 'session-1', checkout_id: 'checkout-1', review_id: 'review-1',
      iteration: 1, summary: '完成任务', details_markdown: '## 变更说明\n\n完成任务。', validation_status: 'passed',
      tests: [], changed_files: ['src/a.ts'], suggested_commit_message: 'fix: task',
    } as unknown as SDKSystemMessage

    const html = renderToStaticMarkup(createElement(Provider, { store }, createElement(WorktreeReviewCard, { message, currentSessionId: 'session-1' })))

    expect(html).toContain('验收结果已过期，需要重新生成')
    expect(html).toContain('后台任务、子 Agent 或其他进程仍在写入 Worktree')
    const regenerateButton = html.match(/<button[^>]*>.*重新生成验收结果<\/button>/)?.[0]
    expect(regenerateButton).toBeDefined()
    expect(regenerateButton).not.toMatch(/\sdisabled(?:=|>)/)
    expect(html).not.toContain('请先处理阻塞')
  })

  test('delivery proof summary uses ancestry instead of requiring Local HEAD equality', () => {
    const proof = {
      localBranch: 'main', localHeadBefore: 'a'.repeat(40), localHeadAfter: 'b'.repeat(40),
      changedFiles: ['src/a.ts'], commitInLocalHistory: true,
    }
    expect(worktreeDeliveryProofSummary(proof, 'b'.repeat(40))).toContain('仍在 Local 历史中')
    expect(worktreeDeliveryProofSummary({ ...proof, commitInLocalHistory: false }, 'b'.repeat(40))).toContain('不在 Local HEAD 历史中')
  })
})

describe('WorktreeReviewCard notice parsing', () => {
  test('Given a persisted Ready for Review message When parsed Then only safe bounded delivery fields become card data', () => {
    const parsed = parseWorktreeReviewNotice({
      type: 'system',
      subtype: 'worktree_ready_for_review',
      session_id: 'session-1',
      checkout_id: 'checkout-1',
      review_id: 'review-1',
      iteration: 2,
      summary: '完成任务',
      details_markdown: '## 变更说明\n\n完成详细修改。',
      validation_status: 'failed',
      validation_summary: '存在一个既有失败',
      tests: [{ command: 'bun test', status: 'failed', summary: 'baseline failure' }],
      changed_files: ['src/a.ts'],
      suggested_commit_message: 'fix: 修复任务\n\n- 保留本地修改\n- 补充回归测试',
      local_root: 'D:/must-not-be-used',
      _createdAt: 10,
    } as unknown as SDKSystemMessage)

    expect(parsed).toEqual({
      sessionId: 'session-1',
      checkoutId: 'checkout-1',
      reviewId: 'review-1',
      detailsMarkdown: '## 变更说明\n\n完成详细修改。',
      review: {
        reviewId: 'review-1',
        iteration: 2,
        preparedAt: 10,
        summary: '完成任务',
        validationStatus: 'failed',
        validationSummary: '存在一个既有失败',
        tests: [{ command: 'bun test', status: 'failed', summary: 'baseline failure' }],
        changedFiles: ['src/a.ts'],
        suggestedCommitMessage: 'fix: 修复任务\n\n- 保留本地修改\n- 补充回归测试',
      },
    })
    expect(JSON.stringify(parsed)).not.toContain('must-not-be-used')
    expect(isWorktreeReviewIdentityAuthorized('session-1', parsed!)).toBe(true)
    expect(isWorktreeReviewIdentityAuthorized('forged-session', parsed!)).toBe(false)
    expect(isWorktreeReviewIdentityAuthorized(undefined, parsed!)).toBe(false)
  })

  test('Given legacy notice without details When parsed Then deterministic review details are reconstructed outside the card', () => {
    const parsed = parseWorktreeReviewNotice({
      type: 'system',
      subtype: 'worktree_ready_for_review',
      session_id: 'session-1',
      checkout_id: 'checkout-1',
      review_id: 'review-1',
      iteration: 1,
      summary: '完成旧版任务',
      validation_status: 'passed',
      validation_summary: '聚焦验证通过',
      tests: [{ command: 'bun test', status: 'passed' }],
      changed_files: ['src/a.ts'],
      suggested_commit_message: 'fix: legacy review',
    } as SDKSystemMessage)

    expect(parsed?.detailsMarkdown).toContain('## 变更说明')
    expect(parsed?.detailsMarkdown).toContain('完成旧版任务')
    expect(parsed?.detailsMarkdown).toContain('## 验证结果')
    expect(parsed?.detailsMarkdown).toContain('bun test')
    expect(parsed?.detailsMarkdown).toContain('fix: legacy review')
  })

  test('Given malformed or path-forged data When parsed Then the card refuses incomplete identity', () => {
    expect(parseWorktreeReviewNotice({
      type: 'system',
      subtype: 'worktree_ready_for_review',
      session_id: 'session-1',
      checkout_id: 'checkout-1',
    } as unknown as SDKSystemMessage)).toBeNull()
  })
})

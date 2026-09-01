import { describe, expect, test } from 'bun:test'
import {
  buildWorktreeReviewRegenerationPrompt,
  consumeQueuedWorktreeReviewRegeneration,
  createWorktreeReviewRegenerationFromPreflight,
  dispatchWorktreeReviewRegeneration,
  getQueuedWorktreeReviewRegeneration,
  shouldDeferWorktreeReviewRegeneration,
} from './worktree-review-regeneration.ts'

describe('Worktree review regeneration continuation', () => {
  test('stale isolated preflight becomes one stable review-scoped regeneration request', () => {
    const detail = createWorktreeReviewRegenerationFromPreflight('session-1', {
      status: 'blocked',
      localModified: false,
      checkoutId: 'checkout-1',
      reviewId: 'review-1',
      revision: 7,
      reason: 'stale_isolated',
      message: 'Worktree 在准备验收后发生变化，请重新生成验收结果',
    })

    expect(detail).toEqual({
      sessionId: 'session-1',
      requestId: 'review-regeneration:checkout-1:review-1:7',
      checkoutId: 'checkout-1',
      reviewId: 'review-1',
      revision: 7,
    })
  })

  test('regeneration prompt is read-only, waits for background writes, revalidates, and calls ReadyForReview again', () => {
    const prompt = buildWorktreeReviewRegenerationPrompt({
      sessionId: 'session-1',
      requestId: 'request-1',
      checkoutId: 'checkout-1',
      reviewId: 'review-1',
      revision: 7,
    })

    expect(prompt).toContain('保持 Read Only')
    expect(prompt).toContain('不要修改任何文件')
    expect(prompt).toContain('后台任务')
    expect(prompt).toContain('重新执行必要验证')
    expect(prompt).toContain('ReadyForReview')
    expect(prompt).toContain('如果 Worktree 仍在变化')
  })

  test('AgentView send gate defers while running or refreshing and requires the matching isolated checkout', () => {
    const detail = {
      sessionId: 'session-1', requestId: 'request-1', checkoutId: 'checkout-1', reviewId: 'review-1', revision: 7,
    }
    const ready = {
      streaming: false,
      messagesRefreshing: false,
      messagesRefreshingRef: false,
      messagesLoaded: true,
      hasAgentChannel: true,
      hasAvailableModel: true,
      requiresTargetChoice: false,
      preparingInitialWorktree: false,
      targetLoading: false,
      checkoutKind: 'isolated' as const,
      checkoutId: 'checkout-1',
    }

    expect(shouldDeferWorktreeReviewRegeneration(detail, ready)).toBe(false)
    expect(shouldDeferWorktreeReviewRegeneration(detail, { ...ready, streaming: true })).toBe(true)
    expect(shouldDeferWorktreeReviewRegeneration(detail, { ...ready, messagesRefreshing: true })).toBe(true)
    expect(shouldDeferWorktreeReviewRegeneration(detail, { ...ready, checkoutId: 'other-checkout' })).toBe(true)
    expect(shouldDeferWorktreeReviewRegeneration(detail, { ...ready, checkoutKind: 'local' })).toBe(true)
  })

  test('duplicate dispatches keep one persisted request and only matching identity can consume it', () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const storage = new Map<string, string>()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => { storage.set(key, value) },
        },
        dispatchEvent: () => true,
      },
    })
    try {
      const detail = {
        sessionId: 'session-delayed', requestId: 'review-regeneration:checkout-1:review-1:7',
        checkoutId: 'checkout-1', reviewId: 'review-1', revision: 7,
      }
      dispatchWorktreeReviewRegeneration(detail)
      dispatchWorktreeReviewRegeneration(detail)
      expect(getQueuedWorktreeReviewRegeneration(detail.sessionId)).toEqual(detail)

      consumeQueuedWorktreeReviewRegeneration(detail.sessionId, 'other-request')
      expect(getQueuedWorktreeReviewRegeneration(detail.sessionId)).toEqual(detail)
      consumeQueuedWorktreeReviewRegeneration(detail.sessionId, detail.requestId)
      expect(getQueuedWorktreeReviewRegeneration(detail.sessionId)).toBeNull()
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else delete (globalThis as { window?: unknown }).window
    }
  })
})

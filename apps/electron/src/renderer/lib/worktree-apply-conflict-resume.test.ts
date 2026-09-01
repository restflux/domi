import { describe, expect, test } from 'bun:test'
import {
  buildWorktreeApplyConflictContinuationPrompt,
  claimQueuedWorktreeApplyConflictResume,
  consumeQueuedWorktreeApplyConflictResume,
  createWorktreeApplyConflictResumeFromContinuation,
  createWorktreeApplyConflictResumeFromPreflight,
  dispatchWorktreeApplyConflictResume,
  getQueuedWorktreeApplyConflictResume,
  releaseClaimedWorktreeApplyConflictResume,
} from './worktree-apply-conflict-resume.ts'

describe('Worktree Apply conflict continuation', () => {
  test('权限响应 continuation 可转换为不携带 kind 的安全续跑详情', () => {
    expect(createWorktreeApplyConflictResumeFromContinuation('session-1', {
      kind: 'worktree_apply_conflict', requestId: 'request-1', checkoutId: 'checkout-1', revision: 9,
      localHeadOid: 'd'.repeat(40), conflictingFiles: ['src/a.ts'],
    })).toEqual({
      sessionId: 'session-1', requestId: 'request-1', checkoutId: 'checkout-1', revision: 9,
      localHeadOid: 'd'.repeat(40), conflictingFiles: ['src/a.ts'],
    })
  })

  test('只读预检冲突可转换成稳定且可去重的续跑请求', () => {
    const detail = createWorktreeApplyConflictResumeFromPreflight('session-1', {
      status: 'conflict', localModified: false, checkoutId: 'checkout-1', reviewId: 'review-1', revision: 7,
      configuredBaseOid: 'a'.repeat(40), effectiveBaseOid: 'a'.repeat(40), baseStrategy: 'recorded_base',
      localBranch: 'main', localHeadOid: 'b'.repeat(40), isolatedHeadOid: 'c'.repeat(40),
      changedFiles: ['src/a.ts'], conflictingFiles: ['src/a.ts'],
    })

    expect(detail).toMatchObject({
      sessionId: 'session-1', checkoutId: 'checkout-1', revision: 7,
      localHeadOid: 'b'.repeat(40), conflictingFiles: ['src/a.ts'],
    })
    expect(detail.requestId).toContain('preflight:checkout-1:review-1:7')
  })

  test('批准后的实时 Apply 发现冲突时生成可执行提示，并明确 Local 未修改与新快照仍需重新确认', () => {
    const prompt = buildWorktreeApplyConflictContinuationPrompt({
      sessionId: 'session-1',
      requestId: 'request-1',
      checkoutId: 'checkout-1',
      revision: 9,
      localHeadOid: 'c'.repeat(40),
      conflictingFiles: ['src/a.ts', 'src/b.ts'],
    })

    expect(prompt).toContain('Local 当前未修改')
    expect(prompt).toContain('c'.repeat(40))
    expect(prompt).toContain('src/a.ts')
    expect(prompt).toContain('当前 managed Worktree')
    expect(prompt).toContain('不要直接修改 Local')
    expect(prompt).toContain('已有 Domi Checkpoint')
    expect(prompt).toContain('不得 rebase')
    expect(prompt).toContain('保留 checkpoint commit ancestry')
    expect(prompt).toContain('重新验收的有效交付基线')
    expect(prompt).toContain(`该 Local HEAD → 当前 Worktree 最终快照`)
    expect(prompt).toContain('不得把已经存在于该 Local HEAD 的功能、文件或提交重新写进本次验收与 Commit Message')
    expect(prompt).toContain('原始 Session Base 只用于 checkpoint ancestry 和完整历史校验')
    expect(prompt).toContain('重新调用 ReadyForReview')
    expect(prompt).toContain('验收卡')
    expect(prompt).toContain('不要再次调用 ApplyWorktree')
    expect(prompt).toContain('不要调用 FinishWorktree')
  })

  test('同一冲突续跑只能被一个 AgentView claim，失败 release 后才允许重试', () => {
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
        sessionId: 'claim-session', requestId: 'claim-request', checkoutId: 'claim-checkout', revision: 4,
        localHeadOid: 'e'.repeat(40), conflictingFiles: ['src/claim-conflict.ts'],
      }
      dispatchWorktreeApplyConflictResume(detail)

      expect(claimQueuedWorktreeApplyConflictResume(detail.sessionId, detail.requestId)).toEqual(detail)
      expect(getQueuedWorktreeApplyConflictResume(detail.sessionId)).toBeNull()
      expect([...storage.values()].join('\n')).toContain(detail.requestId)
      expect(claimQueuedWorktreeApplyConflictResume(detail.sessionId, detail.requestId)).toBeNull()

      releaseClaimedWorktreeApplyConflictResume(detail.sessionId, detail.requestId)
      expect(claimQueuedWorktreeApplyConflictResume(detail.sessionId, detail.requestId)).toEqual(detail)
      consumeQueuedWorktreeApplyConflictResume(detail.sessionId, detail.requestId)
      expect(getQueuedWorktreeApplyConflictResume(detail.sessionId)).toBeNull()
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else delete (globalThis as { window?: unknown }).window
    }
  })

  test('旧冲突发送失败时不会覆盖同一会话后来收到的新 continuation', () => {
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
      const original = {
        sessionId: 'replacement-session', requestId: 'old-request', checkoutId: 'replacement-checkout', revision: 5,
        localHeadOid: 'a'.repeat(40), conflictingFiles: ['src/old.ts'],
      }
      const replacement = {
        ...original,
        requestId: 'new-request',
        revision: 6,
        localHeadOid: 'b'.repeat(40),
        conflictingFiles: ['src/new.ts'],
      }
      dispatchWorktreeApplyConflictResume(original)
      expect(claimQueuedWorktreeApplyConflictResume(original.sessionId, original.requestId)).toEqual(original)
      dispatchWorktreeApplyConflictResume(replacement)

      releaseClaimedWorktreeApplyConflictResume(original.sessionId, original.requestId)

      expect(getQueuedWorktreeApplyConflictResume(original.sessionId)).toEqual(replacement)
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else delete (globalThis as { window?: unknown }).window
    }
  })

  test('冲突续跑先进入持久队列，延迟挂载后仍能获取且只消费匹配请求', () => {
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
        sessionId: 'delayed-session', requestId: 'request-delayed', checkoutId: 'checkout-delayed', revision: 3,
        localHeadOid: 'd'.repeat(40), conflictingFiles: ['src/conflict.ts'],
      }
      dispatchWorktreeApplyConflictResume(detail)
      expect(getQueuedWorktreeApplyConflictResume(detail.sessionId)).toEqual(detail)

      consumeQueuedWorktreeApplyConflictResume(detail.sessionId, 'other-request')
      expect(getQueuedWorktreeApplyConflictResume(detail.sessionId)).toEqual(detail)
      consumeQueuedWorktreeApplyConflictResume(detail.sessionId, detail.requestId)
      expect(getQueuedWorktreeApplyConflictResume(detail.sessionId)).toBeNull()
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else delete (globalThis as { window?: unknown }).window
    }
  })
})

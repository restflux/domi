import { describe, expect, test } from 'bun:test'
import {
  claimQueuedWorktreeIterationResume,
  consumeQueuedWorktreeIterationResume,
  dispatchWorktreeIterationResume,
  getQueuedWorktreeIterationResume,
  registerWorktreeIterationResumeConsumer,
  releaseClaimedWorktreeIterationResume,
  reserveWorktreeIterationResumeConsumer,
} from './worktree-iteration-resume.ts'

function detail(sessionId: string, requestId: string) {
  return {
    sessionId,
    requestId,
    iteration: 2,
    detailsMarkdown: '继续修复',
    summary: '继续修复',
    task: '修复切换会话后的续跑',
    mode: 'next_iteration' as const,
    authorizationToken: 'token-1',
    continuationMessage: 'canonical continuation',
  }
}

describe('Worktree iteration continuation', () => {
  test('先进入队列再通知，目标 AgentView 在异步操作结束后才挂载仍可继续', () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const dispatched: Event[] = []
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { dispatchEvent: (event: Event) => dispatched.push(event) },
    })
    try {
      const queued = detail('delayed-session', 'request-delayed')
      dispatchWorktreeIterationResume(queued)

      expect(dispatched).toHaveLength(1)
      expect(getQueuedWorktreeIterationResume(queued.sessionId)).toEqual(queued)

      consumeQueuedWorktreeIterationResume(queued.sessionId, 'other-request')
      expect(getQueuedWorktreeIterationResume(queued.sessionId)).toEqual(queued)
      consumeQueuedWorktreeIterationResume(queued.sessionId, queued.requestId)
      expect(getQueuedWorktreeIterationResume(queued.sessionId)).toBeNull()
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else delete (globalThis as { window?: unknown }).window
    }
  })

  test('异步 checkout 开始时捕获当前 AgentView，切换会话卸载后仍会立即交付', () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { dispatchEvent: () => true },
    })
    try {
      const delivered: string[] = []
      const queued = detail('switched-session', 'request-switched')
      const unregister = registerWorktreeIterationResumeConsumer(queued.sessionId, (resume) => {
        delivered.push(resume.requestId)
      })
      reserveWorktreeIterationResumeConsumer(queued.sessionId, queued.requestId)
      unregister()

      dispatchWorktreeIterationResume(queued)

      expect(delivered).toEqual([queued.requestId])
      expect(getQueuedWorktreeIterationResume(queued.sessionId)).toEqual(queued)
      consumeQueuedWorktreeIterationResume(queued.sessionId, queued.requestId)
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else delete (globalThis as { window?: unknown }).window
    }
  })

  test('同一续跑同一时刻只能由一个 AgentView 认领，失败释放后可以重试', () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { dispatchEvent: () => true },
    })
    try {
      const queued = detail('claim-session', 'request-claim')
      dispatchWorktreeIterationResume(queued)

      expect(claimQueuedWorktreeIterationResume(queued.sessionId, queued.requestId)).toBe(true)
      expect(claimQueuedWorktreeIterationResume(queued.sessionId, queued.requestId)).toBe(false)

      releaseClaimedWorktreeIterationResume(queued.sessionId, queued.requestId)
      expect(claimQueuedWorktreeIterationResume(queued.sessionId, queued.requestId)).toBe(true)

      consumeQueuedWorktreeIterationResume(queued.sessionId, queued.requestId)
      expect(claimQueuedWorktreeIterationResume(queued.sessionId, queued.requestId)).toBe(false)
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
      else delete (globalThis as { window?: unknown }).window
    }
  })
})

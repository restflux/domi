import { expect, test } from 'bun:test'
import { createRetentionMaintenance } from './retention-maintenance.ts'

test('创建维护调度不立即清理，活动会话跳过，挂起轮次不重入', async () => {
  let idle = false
  const calls: string[] = []
  let release = (): void => undefined
  const paused = new Promise<void>((resolve) => { release = resolve })
  const run = createRetentionMaintenance({
    isIdle: () => idle,
    cleanupExpired: async () => { calls.push('expired'); await paused },
    cleanupRetryable: async () => { calls.push('retry') },
    onError: () => { throw new Error('不应失败') },
  })
  expect(calls).toEqual([])
  await run()
  expect(calls).toEqual([])
  idle = true
  const first = run()
  await run()
  expect(calls).toEqual(['expired'])
  idle = false
  release()
  await first
  expect(calls).toEqual(['expired'])
  idle = true
  await run()
  expect(calls).toEqual(['expired', 'expired', 'retry'])
})

test('到期维护失败不跳过下一类维护，活动判断传入项内', async () => {
  const errors: unknown[] = []
  let retried = false
  const run = createRetentionMaintenance({
    isIdle: () => true,
    cleanupExpired: async (shouldContinue) => { expect(shouldContinue()).toBe(true); throw new Error('测试失败') },
    cleanupRetryable: async (shouldContinue) => { retried = shouldContinue() },
    onError: (error) => { errors.push(error) },
  })
  await run()
  expect(errors).toHaveLength(1)
  expect(retried).toBe(true)
})

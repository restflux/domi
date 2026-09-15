import { expect, test } from 'bun:test'
import { GitCommandInterruptedError } from './git-execution-policy.ts'
import { assertGitOperationActive, canCleanGitOperation, interruptGitOperation, withGitOperation } from './git-operation-lifetime.ts'

test('Given Git 超时 When 内部 catch 降为普通错误 Then 禁止补偿与清理并重新抛出中断', async () => {
  const failure = new GitCommandInterruptedError('update-ref', 120_000)
  let cleanup = false
  let compensation = false
  const operation = withGitOperation(async () => {
    try {
      interruptGitOperation(failure)
      throw failure
    } catch {
      try {
        assertGitOperationActive()
        compensation = true
      } catch { /* 模拟上层捕获补偿异常。 */ }
      return { status: 'error' }
    } finally {
      if (canCleanGitOperation()) cleanup = true
    }
  })
  await expect(operation).rejects.toBe(failure)
  expect(compensation).toBeFalse()
  expect(cleanup).toBeFalse()
})

test('Given 并发 Git 操作 When 一次中断 Then 不污染另一操作或下一次调用', async () => {
  const failure = new GitCommandInterruptedError('apply', 120_000)
  await Promise.all([
    expect(withGitOperation(async () => {
      interruptGitOperation(failure)
      await Promise.resolve()
      expect(canCleanGitOperation()).toBeFalse()
    })).rejects.toBe(failure),
    withGitOperation(async () => {
      await Promise.resolve()
      assertGitOperationActive()
      expect(canCleanGitOperation()).toBeTrue()
    }),
  ])
  expect(canCleanGitOperation()).toBeTrue()
})

import { AsyncLocalStorage } from 'node:async_hooks'
import { GitCommandInterruptedError } from './git-execution-policy.ts'

interface GitOperationLifetime {
  interrupted?: GitCommandInterruptedError
}
const operations = new AsyncLocalStorage<GitOperationLifetime>()

/** 一个操作超时后禁止补偿 Git 与临时现场清理，不影响并发的其他操作。 */
export async function withGitOperation<T>(operation: () => Promise<T>): Promise<T> {
  return operations.run({}, async () => {
    try {
      return await operation()
    } finally {
      assertGitOperationActive()
    }
  })
}

export function interruptGitOperation(error: GitCommandInterruptedError): void {
  const operation = operations.getStore()
  if (operation) operation.interrupted = error
}

export function canCleanGitOperation(): boolean {
  return !operations.getStore()?.interrupted
}

export function assertGitOperationActive(): void {
  const error = operations.getStore()?.interrupted
  if (error) throw error
}

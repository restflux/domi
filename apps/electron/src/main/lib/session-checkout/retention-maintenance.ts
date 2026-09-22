/** 单轮后台维护：不抢占前台，不叠加未完成轮次，失败隔离到单个维护阶段。 */
export function createRetentionMaintenance(options: {
  isIdle(): boolean
  cleanupExpired(shouldContinue: () => boolean): Promise<unknown>
  cleanupRetryable(shouldContinue: () => boolean): Promise<unknown>
  onError(error: unknown): void
}): () => Promise<void> {
  let running = false
  return async () => {
    if (running || !options.isIdle()) return
    running = true
    try {
      for (const cleanup of [options.cleanupExpired, options.cleanupRetryable]) {
        if (!options.isIdle()) break
        try { await cleanup(options.isIdle) } catch (error) { options.onError(error) }
      }
    } finally {
      running = false
    }
  }
}

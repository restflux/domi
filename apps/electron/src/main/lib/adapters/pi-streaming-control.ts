export interface DeltaBatchCoalescer<T> {
  schedule: (value: T) => void
  flush: () => void
  dispose: () => void
}

/**
 * 保留时间窗口内的全部增量，并以单批形式发送。Delta 不可只保留最后一项，
 * 否则会丢失新增文本、思考或工具参数片段。
 */
export function createDeltaBatchCoalescer<T>(
  emit: (values: T[]) => void,
  intervalMs: number,
): DeltaBatchCoalescer<T> {
  let pending: T[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastEmittedAt = 0
  let disposed = false

  const emitPending = (): void => {
    timer = undefined
    if (disposed || pending.length === 0) return
    const next = pending
    pending = []
    lastEmittedAt = Date.now()
    emit(next)
  }

  return {
    schedule(value) {
      if (disposed) return
      pending.push(value)
      if (timer) return
      const elapsed = Date.now() - lastEmittedAt
      timer = setTimeout(emitPending, Math.max(0, intervalMs - elapsed))
    },
    flush() {
      if (timer) clearTimeout(timer)
      timer = undefined
      emitPending()
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = undefined
      pending = []
    },
  }
}

import { SessionCheckoutError } from './index.ts'

export interface SessionCheckoutQueueEvent {
  operationId: number
  operation: string
  sessionId?: string
  phase: 'queued' | 'started' | 'long_running' | 'finished' | 'failed' | 'queue_timeout'
  timestamp: string
  waitMs: number
  executionMs: number
}

interface SessionCheckoutOperationQueueOptions {
  waitTimeoutMs?: number
  longRunningMs?: number
  onEvent?: (event: SessionCheckoutQueueEvent) => void | Promise<void>
}

export const SESSION_CHECKOUT_QUEUE_WAIT_MS = 30_000

function queueTimeoutError(): SessionCheckoutError {
  return new SessionCheckoutError('operation_not_allowed', '工作环境操作等待超时，本次请求尚未执行，请稍后重试')
}

/** 仅用于无副作用的等待信号，不中止或解锁信号背后的写事务。 */
export async function waitForSessionCheckoutSignal(signal: Promise<void>, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) throw queueTimeoutError()
  const deadline = Date.now() + timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(queueTimeoutError()), timeoutMs) }),
    ])
    if (Date.now() >= deadline) throw queueTimeoutError()
  } finally {
    clearTimeout(timer)
  }
}

/** FIFO 的请求等待与事务所有权分离：超时请求跳过，但绝不提前释放正在执行的前项。 */
export class SessionCheckoutOperationQueue {
  private tail: Promise<void> = Promise.resolve()
  private nextId = 0

  constructor(private readonly options: SessionCheckoutOperationQueueOptions = {}) {}

  run<T>(operationName: string, sessionId: string | undefined, operation: () => Promise<T>): Promise<T> {
    const operationId = ++this.nextId
    const queuedAt = Date.now()
    let startedAt: number | undefined
    const emit = (phase: SessionCheckoutQueueEvent['phase']): void => {
      const now = Date.now()
      try {
        void Promise.resolve(this.options.onEvent?.({
          operationId, operation: operationName, ...(sessionId ? { sessionId } : {}), phase,
          timestamp: new Date(now).toISOString(),
          waitMs: (startedAt ?? now) - queuedAt,
          executionMs: startedAt === undefined ? 0 : now - startedAt,
        })).catch(() => undefined)
      } catch { /* 审计失败不得影响队列和事务。 */ }
    }
    emit('queued')
    return new Promise<T>((resolve, reject) => {
      let expired = false
      const waitTimeoutMs = this.options.waitTimeoutMs ?? SESSION_CHECKOUT_QUEUE_WAIT_MS
      const expire = (): void => {
        if (expired) return
        expired = true
        emit('queue_timeout')
        reject(queueTimeoutError())
      }
      const waitTimer = setTimeout(expire, waitTimeoutMs)
      this.tail = this.tail.then(async () => {
        clearTimeout(waitTimer)
        // 事件循环繁忙时 Promise 回调可能先于超时 timer 获得执行，也必须遵守同一截止时间。
        if (Date.now() - queuedAt >= waitTimeoutMs) expire()
        if (expired) return
        startedAt = Date.now()
        emit('started')
        const executionTimer = setTimeout(() => emit('long_running'), this.options.longRunningMs ?? 15_000)
        try {
          const result = await operation()
          emit('finished')
          resolve(result)
        } catch (error) {
          emit('failed')
          reject(error)
        } finally {
          clearTimeout(executionTimer)
        }
      })
    })
  }
}

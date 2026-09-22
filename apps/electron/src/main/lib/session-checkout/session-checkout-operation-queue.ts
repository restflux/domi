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

export interface SessionCheckoutQueueScope {
  /** 缺失资源表示全局屏障；空数组也不能获得无锁写入权限。 */
  resources?: readonly string[]
  priority?: 'foreground' | 'maintenance'
}

interface PendingOperation {
  resources: ReadonlySet<string> | null
  maintenance: boolean
  start(): void
}

function conflicts(left: PendingOperation, right: PendingOperation): boolean {
  return !left.resources || !right.resources || [...left.resources].some((key) => right.resources!.has(key))
}

/** 按资源保留事务所有权：只取消尚未执行的请求，绝不以超时释放正在执行的写事务。 */
export class SessionCheckoutOperationQueue {
  private readonly pending: PendingOperation[] = []
  private readonly active = new Set<PendingOperation>()
  private pumping = false

  get hasForegroundWork(): boolean {
    return [...this.active, ...this.pending].some((entry) => !entry.maintenance)
  }

  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    queueMicrotask(() => {
      this.pumping = false
      const ordered = [...this.pending].sort((a, b) => Number(a.maintenance) - Number(b.maintenance))
      for (const entry of ordered) {
        if ([...this.active].some((other) => conflicts(entry, other))) {
          continue
        }
        this.pending.splice(this.pending.indexOf(entry), 1)
        this.active.add(entry)
        entry.start()
      }
    })
  }
  private nextId = 0

  constructor(private readonly options: SessionCheckoutOperationQueueOptions = {}) {}

  run<T>(operationName: string, sessionId: string | undefined, operation: () => Promise<T>, scope: SessionCheckoutQueueScope = {}): Promise<T> {
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
      const waitTimeoutMs = this.options.waitTimeoutMs ?? SESSION_CHECKOUT_QUEUE_WAIT_MS
      const entry: PendingOperation = {
        resources: scope.resources?.length ? new Set(scope.resources) : null,
        maintenance: scope.priority === 'maintenance',
        start: () => {
          clearTimeout(waitTimer)
          // Promise 微任务先于超时 timer 时仍遵守原截止时间。
          if (Date.now() - queuedAt >= waitTimeoutMs) {
            emit('queue_timeout')
            reject(queueTimeoutError())
            this.active.delete(entry)
            this.pump()
            return
          }
          startedAt = Date.now()
          emit('started')
          const executionTimer = setTimeout(() => emit('long_running'), this.options.longRunningMs ?? 15_000)
          void (async () => {
            try {
              const result = await operation()
              emit('finished')
              resolve(result)
            } catch (error) {
              emit('failed')
              reject(error)
            } finally {
              clearTimeout(executionTimer)
              this.active.delete(entry)
              this.pump()
            }
          })()
        },
      }
      const waitTimer = setTimeout(() => {
        const index = this.pending.indexOf(entry)
        if (index < 0) return
        this.pending.splice(index, 1)
        emit('queue_timeout')
        reject(queueTimeoutError())
        this.pump()
      }, waitTimeoutMs)
      this.pending.push(entry)
      this.pump()
    })
  }
}

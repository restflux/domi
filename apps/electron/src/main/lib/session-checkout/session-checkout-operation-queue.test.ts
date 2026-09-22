import { describe, expect, test } from 'bun:test'
import { SessionCheckoutOperationQueue, waitForSessionCheckoutSignal, type SessionCheckoutQueueEvent } from './session-checkout-operation-queue.ts'

function gate() {
  let release = (): void => undefined
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

describe('Session Checkout 排队恢复', () => {
  test('Given 清理挂起 When 无关资源请求到达 Then 不等待清理且同资源仍互斥', async () => {
    const queue = new SessionCheckoutOperationQueue({ waitTimeoutMs: 100 })
    const active = gate()
    const started = gate()
    const first = queue.run('cleanup', 'a', async () => { started.release(); await active.promise }, { resources: ['repo:a'] })
    await started.promise
    let sameRan = false
    const same = queue.run('bind', 'a', async () => { sameRan = true }, { resources: ['repo:a'] })
    try {
      await expect(queue.run('bind', 'b', async () => 'ready', { resources: ['repo:b'] })).resolves.toBe('ready')
      expect(sameRan).toBe(false)
    } finally {
      active.release()
      await Promise.allSettled([first, same])
    }
    expect(sameRan).toBe(true)
  })

  test('Given 操作运行超过告警时间 When 后项等待 Then 只告警不解锁并记录真实失败及恢复', async () => {
    const events: SessionCheckoutQueueEvent[] = []
    const warned = gate()
    const active = gate()
    const queue = new SessionCheckoutOperationQueue({
      waitTimeoutMs: 1_000, longRunningMs: 10,
      onEvent: (event) => {
        events.push(event)
        if (event.phase === 'long_running') warned.release()
      },
    })
    const first = queue.run('cleanup', 'a', async () => {
      await active.promise
      throw new Error('不可记录的原始路径和错误')
    }).catch(() => undefined)
    await warned.promise
    let secondRan = false
    const second = queue.run('bind', 'b', async () => { secondRan = true })
    expect(secondRan).toBe(false)
    active.release()
    await Promise.all([first, second])
    expect(secondRan).toBe(true)
    expect(events.filter((event) => event.operationId === 1).map((event) => event.phase))
      .toEqual(['queued', 'started', 'long_running', 'failed'])
    expect(events.filter((event) => event.operationId === 2).map((event) => event.phase))
      .toEqual(['queued', 'started', 'finished'])
    expect(JSON.stringify(events)).not.toContain('不可记录')
    expect(events.every((event) => event.waitMs >= 0 && event.executionMs >= 0)).toBe(true)
  })

  test('Given 同资源维护已排队 When 用户请求到达 Then 用户优先且维护随后执行', async () => {
    const queue = new SessionCheckoutOperationQueue()
    const active = gate()
    const started = gate()
    const order: string[] = []
    const first = queue.run('active', 'a', async () => { started.release(); await active.promise }, { resources: ['local:a'] })
    await started.promise
    const maintenance = queue.run('cleanup', 'a', async () => { order.push('maintenance') }, { resources: ['local:a'], priority: 'maintenance' })
    const user = queue.run('preview', 'b', async () => { order.push('user') }, { resources: ['local:a'] })
    active.release()
    await Promise.all([first, maintenance, user])
    expect(order).toEqual(['user', 'maintenance'])
  })

  test('Given 清理持 checkout 且前台等待该 checkout When 清理申请 Git 锁 Then 不发生等待队列反转死锁', async () => {
    const queue = new SessionCheckoutOperationQueue({ waitTimeoutMs: 500 })
    const start = gate()
    const proceed = gate()
    const cleanup = queue.run('cleanup', 'a', async () => {
      start.release()
      await proceed.promise
      await queue.run('cleanup_git', 'a', async () => undefined, { resources: ['git:a'], priority: 'maintenance' })
    }, { resources: ['checkout:a'], priority: 'maintenance' })
    await start.promise
    const user = queue.run('finish', 'a', async () => 'done', { resources: ['checkout:a', 'git:a'] })
    proceed.release()
    await cleanup
    expect(await user).toBe('done')
  })

  test('Given 审计同步或异步失败 When 连续操作 Then 不污染队列', async () => {
    for (const onEvent of [
      () => { throw new Error('审计不可用') },
      async () => { throw new Error('异步审计不可用') },
    ]) {
      const queue = new SessionCheckoutOperationQueue({ onEvent })
      await expect(queue.run('bind', 'a', async () => 'first')).resolves.toBe('first')
      await expect(queue.run('inspect', 'a', async () => 'second')).resolves.toBe('second')
    }
  })

  test('Given 只读等待超时 When 旧信号稍后恢复 Then 原请求不会迟到继续', async () => {
    const active = gate()
    let continued = false
    await expect((async () => {
      await waitForSessionCheckoutSignal(active.promise, 10)
      continued = true
    })()).rejects.toThrow('等待超时')
    active.release()
    await Promise.resolve()
    expect(continued).toBe(false)
  })

  test('Given 超时 timer 尚未调度 When 前项先以微任务完成 Then 过期请求仍不执行', async () => {
    const queue = new SessionCheckoutOperationQueue({ waitTimeoutMs: 20 })
    const active = gate()
    const started = gate()
    const first = queue.run('bind', 'a', async () => { started.release(); await active.promise })
    await started.promise
    let expiredRan = false
    const next = queue.run('bind', 'b', async () => { expiredRan = true }).catch((error: unknown) => error)
    const deadline = Date.now() + 25
    while (Date.now() < deadline) { /* 模拟短暂主线程繁忙，timer 尚未执行。 */ }
    active.release()
    await first
    expect(await next).toBeInstanceOf(Error)
    expect(expiredRan).toBe(false)
    await expect(queue.run('inspect', 'b', async () => 'recovered')).resolves.toBe('recovered')
  })

  test('Given 前项仍在执行 When 后项等待超时 Then 后项不会迟到执行或提前释放互斥', async () => {
    const queue = new SessionCheckoutOperationQueue({ waitTimeoutMs: 20 })
    const active = gate()
    const started = gate()
    const first = queue.run('bind', 'a', async () => {
      started.release()
      await active.promise
    })
    await started.promise
    let expiredRan = false
    const expired = queue.run('bind', 'b', async () => { expiredRan = true })
    const outcome = await Promise.race([
      expired.then(() => 'completed', (error: unknown) => error instanceof Error ? error.message : 'error'),
      Bun.sleep(100).then(() => 'still waiting'),
    ])
    try {
      expect(outcome).toContain('等待超时')
    } catch (error) {
      active.release()
      await Promise.allSettled([first, expired])
      throw error
    }
    let thirdRan = false
    const third = queue.run('bind', 'c', async () => { thirdRan = true })
    expect(thirdRan).toBe(false)
    active.release()
    await Promise.all([first, third])
    expect(expiredRan).toBe(false)
    expect(thirdRan).toBe(true)
  })
})

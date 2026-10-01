import { describe, expect, test } from 'bun:test'
import { startSideChatPolling } from './side-chat-polling'
import type { SideChatView } from '@domi/shared'

const view: SideChatView = { parentSessionId: 'parent', sessionId: 'child', messages: [], isRunning: false }
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => { resolve = done }), resolve: (value) => resolve(value) }
}
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10))

describe('侧聊面板轮询生命周期', () => {
  test('完成交接或新发送后，旧请求报错不覆盖当前反馈', async () => {
    let rejectRequest: (cause: Error) => void = () => {}
    const request = new Promise<SideChatView>((_resolve, reject) => { rejectRequest = reject })
    let revision = 0
    const errors: unknown[] = []
    const close = startSideChatPolling({
      open: () => request, list: async () => [view], onList: () => {}, onError: error => errors.push(error),
      revision: () => revision, isSending: () => false, consumeForceNew: () => false, intervalMs: 1000,
    })
    revision++
    rejectRequest(new Error('旧请求失败'))
    await tick()
    close()
    expect(errors).toEqual([])
  })
  test('关闭面板丢弃迟到响应，不继续轮询也不停止宿主会话', async () => {
    const pending = deferred<SideChatView>()
    let reads = 0
    const received: SideChatView[][] = []
    const close = startSideChatPolling({
      open: () => pending.promise, list: async () => { reads++; return [view] }, onList: (views) => { received.push(views) },
      onError: () => {}, revision: () => 0, isSending: () => false, consumeForceNew: () => false, intervalMs: 1,
    })
    close(); pending.resolve(view); await tick()
    expect(reads).toBe(0)
    expect(received).toHaveLength(0)
  })
  test('请求期间发生发送，不让旧 idle 快照覆盖发送状态', async () => {
    const pending = deferred<SideChatView>()
    let revision = 0
    const received: SideChatView[][] = []
    const close = startSideChatPolling({
      open: () => pending.promise, list: async () => [view], onList: (views) => { received.push(views) },
      onError: () => {}, revision: () => revision, isSending: () => false, consumeForceNew: () => false, intervalMs: 1000,
    })
    revision++; pending.resolve(view); await tick(); close()
    expect(received).toHaveLength(0)
  })
  test('请求未完成时不重叠轮询，完成后继续获取多轮消息', async () => {
    const open = deferred<SideChatView>()
    const list = deferred<SideChatView[]>()
    let reads = 0
    const received: SideChatView[][] = []
    const close = startSideChatPolling({
      open: () => open.promise, list: () => { reads++; return list.promise }, onList: (views) => { received.push(views) },
      onError: () => {}, revision: () => 0, isSending: () => false, consumeForceNew: () => false, intervalMs: 1,
    })
    await tick(); expect(reads).toBe(0)
    open.resolve(view); await tick(); expect(reads).toBe(1)
    await tick(); expect(reads).toBe(1)
    list.resolve([{ ...view, isRunning: true }]); await Promise.resolve(); close()
    expect(received.map(views => views[0]?.isRunning)).toEqual([true])
  })
  test('forceNew 意图触发一次强制新开，无意图时轮询只拉列表', async () => {
    const open = deferred<SideChatView>()
    const list = deferred<SideChatView[]>()
    let forceNewCalls: boolean[] = []
    let consumed = 0
    const close = startSideChatPolling({
      open: forceNew => { forceNewCalls.push(forceNew); return open.promise },
      list: () => list.promise, onList: () => {},
      onError: () => {}, revision: () => 0, isSending: () => false,
      consumeForceNew: () => { consumed += 1; return consumed === 1 },
      intervalMs: 1,
    })
    await tick()
    open.resolve(view)
    list.resolve([view])
    await tick()
    close()
    // 首轮 open(false)（建立子会话），之后 forceNew 意图消费一次 open(true)
    expect(forceNewCalls).toEqual([false, true])
  })
})

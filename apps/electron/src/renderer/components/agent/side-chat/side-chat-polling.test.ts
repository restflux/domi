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
  test('关闭面板丢弃迟到响应，不继续轮询也不停止宿主会话', async () => {
    const pending = deferred<SideChatView>()
    let reads = 0
    const received: SideChatView[] = []
    const close = startSideChatPolling({ open: () => pending.promise, get: async () => { reads++; return view }, onView: (value) => { if (value) received.push(value) }, onError: () => {}, revision: () => 0, isSending: () => false, intervalMs: 1 })
    close(); pending.resolve(view); await tick()
    expect(reads).toBe(0)
    expect(received).toHaveLength(0)
  })
  test('请求期间发生发送，不让旧 idle 快照覆盖发送状态', async () => {
    const pending = deferred<SideChatView>()
    let revision = 0
    const received: SideChatView[] = []
    const close = startSideChatPolling({ open: () => pending.promise, get: async () => view, onView: (value) => { if (value) received.push(value) }, onError: () => {}, revision: () => revision, isSending: () => false, intervalMs: 1000 })
    revision++; pending.resolve(view); await tick(); close()
    expect(received).toHaveLength(0)
  })
  test('请求未完成时不重叠轮询，完成后继续获取多轮消息', async () => {
    const first = deferred<SideChatView>()
    const second = deferred<SideChatView | null>()
    let reads = 0
    const received: (SideChatView | null)[] = []
    const close = startSideChatPolling({ open: () => first.promise, get: () => { reads++; return second.promise }, onView: (value) => received.push(value), onError: () => {}, revision: () => 0, isSending: () => false, intervalMs: 1 })
    await tick(); expect(reads).toBe(0)
    first.resolve(view); await tick(); expect(reads).toBe(1)
    await tick(); expect(reads).toBe(1)
    second.resolve({ ...view, isRunning: true }); await Promise.resolve(); close()
    expect(received.map((value) => value?.isRunning)).toEqual([false, true])
  })
})

import { describe, expect, test } from 'bun:test'
import {
  claimPendingNativeQueueDelivery,
  clearAndReplayNativeQueue,
  createNativeQueueDeliverySuppressionState,
  findAddedNativeQueueContent,
  orderMessagesForNativeQueue,
  processOrDeferNativeQueueSnapshot,
  selectItemsPresentInNativeQueue,
  withNativeQueueDeliverySuppressed,
} from './agent-message-queue-replay'

describe('native Agent message queue replay', () => {
  test('steering 始终排在 follow-up 前，并保留各自相对顺序', () => {
    const messages = [
      { id: 'f1', kind: 'followUp' as const },
      { id: 's1', kind: 'steering' as const },
      { id: 'f2', kind: 'followUp' as const },
      { id: 's2', kind: 'steering' as const },
    ]

    expect(orderMessagesForNativeQueue(messages).map((message) => message.id))
      .toEqual(['s1', 's2', 'f1', 'f2'])
  })

  test('修改队列时先整体清空，再按 SDK 规范顺序逐条重放', async () => {
    const operations: string[] = []
    const messages = [
      { id: 'f1', kind: 'followUp' as const },
      { id: 's1', kind: 'steering' as const },
      { id: 's2', kind: 'steering' as const },
    ]

    const ordered = await clearAndReplayNativeQueue(
      messages,
      async () => { operations.push('clear') },
      async (message) => { operations.push(`enqueue:${message.kind}:${message.id}`) },
    )

    expect(operations).toEqual([
      'clear',
      'enqueue:steering:s1',
      'enqueue:steering:s2',
      'enqueue:followUp:f1',
    ])
    expect(ordered.map((message) => message.id)).toEqual(['s1', 's2', 'f1'])
  })

  test('clear 瞬间已送达的旧镜像不会被重复 replay', async () => {
    const replayed: string[] = []
    const messages = [
      { id: 'delivered', kind: 'steering' as const },
      { id: 'pending', kind: 'followUp' as const },
    ]
    await clearAndReplayNativeQueue(
      messages,
      async () => [messages[1]!],
      async (message) => { replayed.push(message.id) },
    )
    expect(replayed).toEqual(['pending'])
  })

  test('queue_update 按实际内容匹配，不因 catch 中间 splice 后的长度差错调 callback', () => {
    // 模拟失败项已从中间 splice 后只剩 first/last；SDK 快照表明 first 仍在、last 已送达。
    // 旧的 length delta + shift 会错误回调 first；内容匹配应只判定 last 送达。
    const pending = [
      { id: 'first', content: '仍在队列' },
      { id: 'last', content: '实际已送达' },
    ]
    const remaining = selectItemsPresentInNativeQueue(pending, ['仍在队列'], (item) => item.content)
    expect(remaining.map((item) => item.id)).toEqual(['first'])
    expect(pending.filter((item) => !remaining.includes(item)).map((item) => item.id))
      .toEqual(['last'])
  })

  test('重复文本按 FIFO 将较早项判定为送达，保留较新项', () => {
    const pending = [
      { id: 'older', content: 'same' },
      { id: 'newer', content: 'same' },
    ]
    const remaining = selectItemsPresentInNativeQueue(pending, ['same'], (item) => item.content)
    expect(remaining.map((item) => item.id)).toEqual(['newer'])
  })

  test('真实 user message 优先按 steering、各队列 FIFO 原子认领 pending delivery', () => {
    const queues = {
      steering: [
        { id: 's1', content: 'same' },
        { id: 's2', content: 'same' },
      ],
      followUp: [{ id: 'f1', content: 'same' }],
    }

    expect(claimPendingNativeQueueDelivery(queues, 'same', (item) => item.content))
      .toEqual({ kind: 'steering', item: { id: 's1', content: 'same' } })
    expect(queues.steering.map((item) => item.id)).toEqual(['s2'])
    expect(queues.followUp.map((item) => item.id)).toEqual(['f1'])
  })

  test('真实 user event 与后续 queue_update 只能确认同一 delivery 一次', () => {
    const queues = {
      steering: [{ id: 'only', content: 'queued prompt' }],
      followUp: [] as Array<{ id: string; content: string }>,
    }

    expect(claimPendingNativeQueueDelivery(queues, 'queued prompt', (item) => item.content)?.item.id)
      .toBe('only')
    expect(claimPendingNativeQueueDelivery(queues, 'queued prompt', (item) => item.content))
      .toBeUndefined()
    expect(selectItemsPresentInNativeQueue(queues.steering, [], (item) => item.content))
      .toEqual([])
  })

  test('enqueue 后使用 SDK 实际新增文本校准 prompt template 展开内容', () => {
    expect(findAddedNativeQueueContent(['existing'], ['existing', 'expanded prompt']))
      .toBe('expanded prompt')
  })

  test('clear+replay 全程抑制 queue_update，最外层结束后仅按最终快照对账一次', async () => {
    type Snapshot = { steering: string[]; followUp: string[] }
    const state = createNativeQueueDeliverySuppressionState<Snapshot>()
    const processed: Snapshot[] = []
    let latest: Snapshot = { steering: [], followUp: [] }
    const process = (snapshot: Snapshot): void => { processed.push(snapshot) }

    await withNativeQueueDeliverySuppressed(
      state,
      async () => {
        latest = { steering: [], followUp: [] }
        processOrDeferNativeQueueSnapshot(state, latest, process) // clearQueue

        await withNativeQueueDeliverySuppressed(
          state,
          async () => {
            latest = { steering: ['s1'], followUp: [] }
            processOrDeferNativeQueueSnapshot(state, latest, process) // replay 第 1 条
          },
          () => latest,
          process,
        )

        latest = { steering: ['s1', 's2'], followUp: ['f1'] }
        processOrDeferNativeQueueSnapshot(state, latest, process) // replay 完成
        expect(processed).toEqual([])
      },
      () => latest,
      process,
    )

    expect(processed).toEqual([{ steering: ['s1', 's2'], followUp: ['f1'] }])
  })
})

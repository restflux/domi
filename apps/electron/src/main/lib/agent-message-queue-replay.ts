import type { AgentQueueMessageKind } from '@domi/shared'

export interface ReplayableAgentQueueMessage {
  kind: AgentQueueMessageKind
}

export interface NativeQueueDeliverySuppressionState<TSnapshot> {
  depth: number
  deferredSnapshot?: TSnapshot
}

export interface PendingNativeQueueDeliveryQueues<T> {
  steering: T[]
  followUp: T[]
}

/**
 * Pi 已真正开始处理一条 user message 时，从 pending delivery 中原子认领对应项。
 * 实际交付顺序与 SDK 一致：steering 优先，两类队列内部 FIFO。
 */
export function claimPendingNativeQueueDelivery<T>(
  queues: PendingNativeQueueDeliveryQueues<T>,
  content: string,
  getContent: (item: T) => string,
): { kind: AgentQueueMessageKind; item: T } | undefined {
  for (const kind of ['steering', 'followUp'] as const) {
    const queue = queues[kind]
    const index = queue.findIndex((item) => getContent(item) === content)
    if (index < 0) continue
    const [item] = queue.splice(index, 1)
    if (item) return { kind, item }
  }
  return undefined
}

export function createNativeQueueDeliverySuppressionState<TSnapshot>(): NativeQueueDeliverySuppressionState<TSnapshot> {
  return { depth: 0 }
}

/** queue_update 在事务中只记录最新快照，事务外才允许触发送达回调。 */
export function processOrDeferNativeQueueSnapshot<TSnapshot>(
  state: NativeQueueDeliverySuppressionState<TSnapshot>,
  snapshot: TSnapshot,
  process: (snapshot: TSnapshot) => void,
): void {
  if (state.depth > 0) {
    state.deferredSnapshot = snapshot
    return
  }
  process(snapshot)
}

/** 支持嵌套的 clear+replay 事务；最外层退出时仅按 SDK 最新权威快照对账一次。 */
export async function withNativeQueueDeliverySuppressed<TSnapshot, TResult>(
  state: NativeQueueDeliverySuppressionState<TSnapshot>,
  operation: () => Promise<TResult>,
  getLatestSnapshot: () => TSnapshot,
  process: (snapshot: TSnapshot) => void,
): Promise<TResult> {
  state.depth += 1
  try {
    return await operation()
  } finally {
    state.depth = Math.max(0, state.depth - 1)
    if (state.depth === 0) {
      state.deferredSnapshot = undefined
      process(getLatestSnapshot())
    }
  }
}

/**
 * 从宿主镜像中找出仍实际存在于 SDK 队列的项。按倒序消费同内容计数，确保重复文本时
 * 保留较新的待发送项，把较早的同文本项判定为已按 FIFO 送达。
 */
export function selectItemsPresentInNativeQueue<T>(
  items: readonly T[],
  nativeContents: readonly string[],
  getContent: (item: T) => string,
): T[] {
  const remainingCounts = new Map<string, number>()
  for (const content of nativeContents) {
    remainingCounts.set(content, (remainingCounts.get(content) ?? 0) + 1)
  }

  const selected = new Set<T>()
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    const content = getContent(item)
    const count = remainingCounts.get(content) ?? 0
    if (count <= 0) continue
    selected.add(item)
    if (count === 1) remainingCounts.delete(content)
    else remainingCounts.set(content, count - 1)
  }
  return items.filter((item) => selected.has(item))
}

/** 找出 enqueue 前后新增的 SDK 原生文本，用于兼容 Pi prompt template 展开。 */
export function findAddedNativeQueueContent(
  before: readonly string[],
  after: readonly string[],
): string | undefined {
  const previousCounts = new Map<string, number>()
  for (const content of before) previousCounts.set(content, (previousCounts.get(content) ?? 0) + 1)
  for (const content of after) {
    const count = previousCounts.get(content) ?? 0
    if (count <= 0) return content
    if (count === 1) previousCounts.delete(content)
    else previousCounts.set(content, count - 1)
  }
  return undefined
}

/**
 * Pi SDK 分别维护 steering/follow-up 两条 FIFO；展示镜像必须使用同一规范顺序，
 * 否则跨 kind 拖拽后 UI 顺序会与 SDK 的“steering 永远优先”不一致。
 */
export function orderMessagesForNativeQueue<T extends ReplayableAgentQueueMessage>(messages: readonly T[]): T[] {
  return [
    ...messages.filter((message) => message.kind === 'steering'),
    ...messages.filter((message) => message.kind === 'followUp'),
  ]
}

/** 修改/删除/排序原生队列的唯一入口：整体 clearQueue 后按规范顺序 replay。 */
export async function clearAndReplayNativeQueue<T extends ReplayableAgentQueueMessage>(
  messages: readonly T[],
  clearQueue: () => Promise<readonly T[] | void>,
  enqueue: (message: T) => Promise<void>,
): Promise<T[]> {
  // clearQueue 可以返回在清空瞬间仍确认未送达的子集，解决 queue_update 与用户编辑并发时
  // 把刚刚已送达的旧镜像再次 replay、造成重复消息的竞态。
  const confirmedPending = await clearQueue()
  const ordered = orderMessagesForNativeQueue(confirmedPending ?? messages)
  for (const message of ordered) {
    await enqueue(message)
  }
  return ordered
}

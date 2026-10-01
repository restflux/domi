import type { SideChatView } from '@domi/shared'

interface SideChatPollingOptions {
  open: (forceNew: boolean) => Promise<SideChatView>
  list: () => Promise<SideChatView[]>
  onList: (views: SideChatView[]) => void
  onError: (error: unknown) => void
  revision: () => number
  isSending: () => boolean
  consumeForceNew: () => boolean
  intervalMs?: number
}
/** 单个请求完成后再排下一次；关闭使迟到响应失效，但不取消宿主运行。 */
export function startSideChatPolling(options: SideChatPollingOptions): () => void {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let opened = false
  const poll = async (): Promise<void> => {
    const revision = options.revision()
    try {
      if (!opened) {
        const view = await options.open(false)
        opened = view !== null
      } else if (options.consumeForceNew()) {
        await options.open(true)
      }
      // 关闭后不再发起列表请求；迟到 open 响应直接丢弃。
      if (disposed) return
      const views = await options.list()
      if (!disposed && revision === options.revision() && !options.isSending()) options.onList(views)
    } catch (error) {
      if (!disposed && revision === options.revision() && !options.isSending()) options.onError(error)
    } finally {
      if (!disposed) timer = setTimeout(() => void poll(), options.intervalMs ?? 1500)
    }
  }
  void poll()
  return () => { disposed = true; clearTimeout(timer) }
}

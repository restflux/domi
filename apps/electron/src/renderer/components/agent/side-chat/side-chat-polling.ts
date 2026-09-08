import type { SideChatView } from '@domi/shared'

interface SideChatPollingOptions {
  open: () => Promise<SideChatView>
  get: () => Promise<SideChatView | null>
  onView: (view: SideChatView | null) => void
  onError: (error: unknown) => void
  revision: () => number
  isSending: () => boolean
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
      const next = opened ? await options.get() : await options.open()
      opened = next !== null
      if (!disposed && revision === options.revision() && !options.isSending()) options.onView(next)
    } catch (error) {
      if (!disposed) options.onError(error)
    } finally {
      if (!disposed) timer = setTimeout(() => void poll(), options.intervalMs ?? 1200)
    }
  }
  void poll()
  return () => { disposed = true; clearTimeout(timer) }
}

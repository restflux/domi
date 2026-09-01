export type WorkActivityRefresh = () => Promise<void>

/**
 * 同一时刻只执行一次工作动态刷新；刷新期间的任意数量请求合并为一次尾随刷新。
 * 这样既不会丢失运行中发生的状态变化，也不会让轮询与事件通知堆积 IPC 请求。
 */
export function createSingleFlightRefresh(run: WorkActivityRefresh): WorkActivityRefresh {
  let active: Promise<void> | null = null
  let trailingRequested = false

  return (): Promise<void> => {
    if (active) {
      trailingRequested = true
      return active
    }

    active = (async () => {
      do {
        trailingRequested = false
        await run()
      } while (trailingRequested)
    })().finally(() => {
      active = null
    })
    return active
  }
}

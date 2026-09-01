export function createBrowserLayoutRevisionSource(now = Date.now()): () => number {
  let revision = now * 1_000
  return () => {
    revision += 1
    return revision
  }
}

const nextRevision = createBrowserLayoutRevisionSource()

/** 主进程跨 renderer reload 存活，因此 revision 使用时间 epoch 而不是从零计数。 */
export function nextBrowserLayoutRevision(): number {
  return nextRevision()
}

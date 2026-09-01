export type FilePathStatus = 'file' | 'directory' | 'broken'

export interface ResolvedFilePathStatus {
  kind: 'file' | 'directory'
}

type ResolveFilePathStatus = () => Promise<ResolvedFilePathStatus | null>

interface FilePathStatusEntry {
  status?: FilePathStatus
  generation: number
  inFlight?: Promise<FilePathStatus>
}

interface FilePathStatusCacheOptions {
  maxAttempts?: number
  retryDelayMs?: number
}

export interface FilePathStatusCache {
  peek(key: string): FilePathStatus | undefined
  resolve(key: string, resolver: ResolveFilePathStatus): Promise<FilePathStatus>
  set(key: string, status: FilePathStatus): void
  clear(): void
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 300

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 为消息中的文件路径检查提供有界重试、进行中请求合并和最终结果缓存。
 * 流式 Markdown 即使反复挂载同一个芯片，也只会共享同一条检查流程。
 */
export function createFilePathStatusCache(options: FilePathStatusCacheOptions = {}): FilePathStatusCache {
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS))
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
  const entries = new Map<string, FilePathStatusEntry>()

  const getEntry = (key: string): FilePathStatusEntry => {
    const existing = entries.get(key)
    if (existing) return existing
    const created: FilePathStatusEntry = { generation: 0 }
    entries.set(key, created)
    return created
  }

  return {
    peek(key) {
      return entries.get(key)?.status
    },

    resolve(key, resolver) {
      const entry = getEntry(key)
      if (entry.status) return Promise.resolve(entry.status)
      if (entry.inFlight) return entry.inFlight

      const generationAtStart = entry.generation
      const inFlight = (async (): Promise<FilePathStatus> => {
        let resolvedStatus: FilePathStatus = 'broken'

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            const resolved = await resolver()
            if (resolved) {
              resolvedStatus = resolved.kind
              break
            }
          } catch {
            // IPC 暂时失败与路径尚不存在采用同一条有界重试策略。
          }

          if (attempt < maxAttempts) await delay(retryDelayMs)
        }

        // 用户点击可能在自动检查期间完成了更可靠的重新校验；旧结果不得覆盖它。
        if (entry.generation !== generationAtStart && entry.status) return entry.status
        entry.status = resolvedStatus
        return resolvedStatus
      })()

      entry.inFlight = inFlight
      void inFlight.finally(() => {
        if (entry.inFlight === inFlight) entry.inFlight = undefined
      })
      return inFlight
    },

    set(key, status) {
      const entry = getEntry(key)
      entry.generation++
      entry.status = status
    },

    clear() {
      entries.clear()
    },
  }
}

export const filePathStatusCache = createFilePathStatusCache()

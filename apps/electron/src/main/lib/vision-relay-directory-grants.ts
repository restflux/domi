import { realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const DEFAULT_GRANT_TTL_MS = 10 * 60_000

/** One-shot main-process grants proving a directory came from Domi's native picker. */
export class VisionRelayDirectoryGrantRegistry {
  private readonly pending = new Map<string, number>()

  constructor(
    private readonly ttlMs = DEFAULT_GRANT_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  register(sessionId: string, paths: string[]): void {
    this.prune()
    const expiresAt = this.now() + this.ttlMs
    for (const value of paths) {
      const canonicalPath = this.canonicalDirectory(value)
      if (canonicalPath) this.pending.set(this.key(sessionId, canonicalPath), expiresAt)
    }
  }

  consume(sessionId: string, directoryPath: string): string | undefined {
    this.prune()
    const canonicalPath = this.canonicalDirectory(directoryPath)
    if (!canonicalPath) return undefined
    const key = this.key(sessionId, canonicalPath)
    const expiresAt = this.pending.get(key)
    if (!expiresAt || expiresAt <= this.now()) return undefined
    this.pending.delete(key)
    return canonicalPath
  }

  private key(sessionId: string, canonicalPath: string): string {
    return JSON.stringify([sessionId, canonicalPath])
  }

  private prune(): void {
    const now = this.now()
    for (const [path, expiresAt] of this.pending) {
      if (expiresAt <= now) this.pending.delete(path)
    }
  }

  private canonicalDirectory(value: string): string | undefined {
    try {
      const canonicalPath = realpathSync(resolve(value))
      return statSync(canonicalPath).isDirectory() ? canonicalPath : undefined
    } catch {
      return undefined
    }
  }
}

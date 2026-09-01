import { describe, expect, test } from 'bun:test'
import { createFilePathStatusCache } from './file-path-status-cache'

describe('file path status cache', () => {
  test('bounds repeated missing-path checks and shares the in-flight result', async () => {
    const cache = createFilePathStatusCache({ maxAttempts: 3, retryDelayMs: 0 })
    let calls = 0
    const resolveMissingPath = async () => {
      calls++
      return null
    }

    const results = await Promise.all([
      cache.resolve('session-a\0/missing/path', resolveMissingPath),
      cache.resolve('session-a\0/missing/path', resolveMissingPath),
      cache.resolve('session-a\0/missing/path', resolveMissingPath),
      cache.resolve('session-a\0/missing/path', resolveMissingPath),
    ])

    expect(results).toEqual(['broken', 'broken', 'broken', 'broken'])
    expect(calls).toBe(3)
    expect(cache.peek('session-a\0/missing/path')).toBe('broken')

    await cache.resolve('session-a\0/missing/path', resolveMissingPath)
    expect(calls).toBe(3)
  })

  test('keeps retrying briefly when a path appears during streaming', async () => {
    const cache = createFilePathStatusCache({ maxAttempts: 3, retryDelayMs: 0 })
    let calls = 0

    const status = await cache.resolve('session-a\0/generated/report.md', async () => {
      calls++
      return calls === 3 ? { kind: 'file' as const } : null
    })

    expect(status).toBe('file')
    expect(calls).toBe(3)
    expect(cache.peek('session-a\0/generated/report.md')).toBe('file')
  })

  test('caps rejected checks instead of retrying forever across remounts', async () => {
    const cache = createFilePathStatusCache({ maxAttempts: 3, retryDelayMs: 0 })
    let calls = 0
    const rejectCheck = async (): Promise<null> => {
      calls++
      throw new Error('IPC unavailable')
    }

    expect(await cache.resolve('session-a\0/unavailable.md', rejectCheck)).toBe('broken')
    expect(await cache.resolve('session-a\0/unavailable.md', rejectCheck)).toBe('broken')
    expect(calls).toBe(3)
  })

  test('manual status updates win over an older automatic check', async () => {
    let releaseAttempt: (() => void) | undefined
    const cache = createFilePathStatusCache({ maxAttempts: 1, retryDelayMs: 0 })
    const pending = cache.resolve('session-a\0/report.md', async () => {
      await new Promise<void>((resolve) => { releaseAttempt = resolve })
      return null
    })

    cache.set('session-a\0/report.md', 'file')
    releaseAttempt?.()

    expect(await pending).toBe('file')
    expect(cache.peek('session-a\0/report.md')).toBe('file')
  })
})

import { describe, expect, test } from 'bun:test'
import {
  isHighNoisePath,
  normalizeWatchFilename,
  shouldNotifyForWatchFilename,
} from './workspace-watcher-utils.ts'

describe('workspace watcher path policy', () => {
  test('normalizes buffers and Windows separators', () => {
    expect(normalizeWatchFilename(Buffer.from('src\\feature.ts'))).toBe('src/feature.ts')
    expect(normalizeWatchFilename('./src/file.ts')).toBe('src/file.ts')
    expect(normalizeWatchFilename(null)).toBeNull()
  })

  test('filters Git metadata and dependency/build noise', () => {
    for (const path of [
      '.git/index',
      'packages/app/.git/HEAD',
      'node_modules/pkg/index.js',
      'apps/web/dist/app.js',
      'apps/web/.next/cache/data',
      'target/debug/app',
      'coverage/report.json',
    ]) {
      expect(isHighNoisePath(path)).toBeTrue()
      expect(shouldNotifyForWatchFilename(path)).toBeFalse()
    }
  })

  test('allows ordinary project source changes and rejects unknown filenames', () => {
    expect(shouldNotifyForWatchFilename('src/main.ts')).toBeTrue()
    expect(shouldNotifyForWatchFilename('docs/方案.md')).toBeTrue()
    expect(shouldNotifyForWatchFilename(undefined)).toBeFalse()
  })
})

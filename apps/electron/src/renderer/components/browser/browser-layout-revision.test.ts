import { describe, expect, test } from 'bun:test'
import { createBrowserLayoutRevisionSource } from './browser-layout-revision.ts'

describe('浏览器布局 revision', () => {
  test('Given a renderer epoch When publishing layouts Then revisions are globally ordered within that epoch', () => {
    const nextRevision = createBrowserLayoutRevisionSource(1_700_000_000_000)

    const first = nextRevision()
    const second = nextRevision()

    expect(second).toBeGreaterThan(first)
    expect(first).toBeGreaterThanOrEqual(1_700_000_000_000_000)
  })
})

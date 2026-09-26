import { expect, test } from 'bun:test'
import { shouldPublishBrowserLayout, type BrowserLayoutSnapshot } from './browser-layout-snapshot.ts'

test('Given noisy DOM mutations and panel drag When publishing native BrowserSlot bounds Then unchanged rectangles skip Main IPC but visibility and width changes publish', () => {
  const initial: BrowserLayoutSnapshot = { visible: true, bounds: { x: 12, y: 48, width: 390, height: 600 } }
  let previous: BrowserLayoutSnapshot | null = null
  let published = 0
  for (let i = 0; i < 500; i++) {
    if (shouldPublishBrowserLayout(previous, initial)) { published++; previous = initial }
  }
  expect(published).toBe(1)
  const narrower: BrowserLayoutSnapshot = { visible: true, bounds: { ...initial.bounds, width: 360 } }
  expect(shouldPublishBrowserLayout(previous, narrower)).toBe(true)
  expect(shouldPublishBrowserLayout(narrower, { ...narrower, visible: false })).toBe(true)
})

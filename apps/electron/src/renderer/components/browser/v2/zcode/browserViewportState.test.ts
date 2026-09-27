import { expect, test } from 'bun:test'
import { browserViewportKey, getBrowserViewportPreference, updateBrowserViewportPreference } from './browserViewportState.ts'

test('Given two owners and browser tabs When responsive size changes Then v2 tab preference survives unmount without leaking into another tab', () => {
  const first = browserViewportKey('owner-1', 'page-1')
  const second = browserViewportKey('owner-2', 'page-1')
  let preferences = new Map()
  preferences = updateBrowserViewportPreference(preferences, first, { responsive: true, size: { width: 768, height: 1024 } })
  expect(getBrowserViewportPreference(preferences, first)).toEqual({ responsive: true, size: { width: 768, height: 1024 } })
  expect(getBrowserViewportPreference(preferences, second)).toEqual({ responsive: false, size: { width: 390, height: 844 } })
  for (let index = 0; index < 34; index += 1) {
    preferences = updateBrowserViewportPreference(preferences, `owner:tab-${index}`, { responsive: false, size: { width: 390, height: 844 } })
  }
  expect(preferences.size).toBe(32)
  expect(preferences.has(first)).toBe(false)
})

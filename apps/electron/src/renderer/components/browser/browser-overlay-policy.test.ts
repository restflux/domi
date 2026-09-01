import { describe, expect, test } from 'bun:test'
import { rectanglesOverlap } from './browser-overlay-policy.ts'

describe('原生浏览器遮挡策略', () => {
  test('Given an app overlay crossing the native slot When checking geometry Then the slot is considered obscured', () => {
    expect(rectanglesOverlap(
      { left: 400, right: 900, top: 100, bottom: 700 },
      { left: 700, right: 980, top: 50, bottom: 300 },
    )).toBe(true)
  })

  test('Given an app overlay outside the native slot When checking geometry Then the slot can remain visible', () => {
    expect(rectanglesOverlap(
      { left: 400, right: 900, top: 100, bottom: 700 },
      { left: 20, right: 300, top: 50, bottom: 300 },
    )).toBe(false)
  })
})

import { describe, expect, test } from 'bun:test'
import { computeFitZoomPercent, nextBrowserZoomPercent } from './browser-zoom-policy.ts'

describe('浏览器缩放策略', () => {
  test('Given manual zoom actions When calculating Then zoom uses 10 percent steps within 50 to 200 percent', () => {
    expect(nextBrowserZoomPercent(100, 'decrease')).toBe(90)
    expect(nextBrowserZoomPercent(100, 'increase')).toBe(110)
    expect(nextBrowserZoomPercent(70, 'reset')).toBe(100)
    expect(nextBrowserZoomPercent(50, 'decrease')).toBe(50)
    expect(nextBrowserZoomPercent(200, 'increase')).toBe(200)
  })

  test('Given a fixed-width page wider than the slot When fitting Then it scales down without dropping below 50 percent', () => {
    expect(computeFitZoomPercent({ slotWidth: 650, contentWidth: 1000 })).toBe(65)
    expect(computeFitZoomPercent({ slotWidth: 300, contentWidth: 1200 })).toBe(50)
  })

  test('Given responsive or narrow content When fitting Then it never enlarges beyond 100 percent', () => {
    expect(computeFitZoomPercent({ slotWidth: 900, contentWidth: 700 })).toBe(100)
    expect(computeFitZoomPercent({ slotWidth: 0, contentWidth: 700 })).toBe(100)
  })
})

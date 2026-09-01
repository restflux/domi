import type { BrowserZoomAction } from '@domi/shared'

export const BROWSER_MIN_ZOOM_PERCENT = 50
export const BROWSER_MAX_ZOOM_PERCENT = 200
export const BROWSER_ZOOM_STEP_PERCENT = 10

export function nextBrowserZoomPercent(current: number, action: BrowserZoomAction): number {
  if (action === 'reset') return 100
  const delta = action === 'increase' ? BROWSER_ZOOM_STEP_PERCENT : -BROWSER_ZOOM_STEP_PERCENT
  return clampZoomPercent(current + delta)
}

export function computeFitZoomPercent(input: { slotWidth: number; contentWidth: number }): number {
  if (!Number.isFinite(input.slotWidth) || !Number.isFinite(input.contentWidth) || input.slotWidth <= 0 || input.contentWidth <= 0) {
    return 100
  }
  return Math.max(BROWSER_MIN_ZOOM_PERCENT, Math.min(100, Math.floor((input.slotWidth / input.contentWidth) * 100)))
}

export function clampZoomPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 100
  return Math.max(BROWSER_MIN_ZOOM_PERCENT, Math.min(BROWSER_MAX_ZOOM_PERCENT, Math.round(percent)))
}

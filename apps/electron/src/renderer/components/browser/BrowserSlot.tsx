import * as React from 'react'
import type { BrowserSessionView } from '@domi/shared'
import { nextBrowserLayoutRevision } from './browser-layout-revision.ts'
import { rectanglesOverlap } from './browser-overlay-policy.ts'

export function BrowserSlot({ state }: { state: BrowserSessionView }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null)
  const pageId = state.page?.pageId

  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element || !pageId) return
    let frame = 0

    const publish = (visible: boolean, immediate = false): void => {
      const commit = (): void => {
        frame = 0
        const rect = element.getBoundingClientRect()
        void window.electronAPI.browser.setLayout({
          ownerSessionId: state.ownerSessionId,
          browserSessionId: state.browserSessionId,
          pageId,
          revision: nextBrowserLayoutRevision(),
          visible: visible
            && document.visibilityState === 'visible'
            && !isObscuredByAppOverlay(element, rect)
            && rect.width > 4
            && rect.height > 4,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.max(0, Math.round(rect.width)),
            height: Math.max(0, Math.round(rect.height)),
          },
        }).catch((error) => console.warn('[浏览器] 同步原生视图布局失败:', error))
      }
      if (frame) cancelAnimationFrame(frame)
      if (immediate) commit()
      else frame = requestAnimationFrame(commit)
    }

    const observer = new ResizeObserver(() => publish(true))
    const overlayObserver = new MutationObserver(() => publish(true))
    const handleWindowLayout = (): void => publish(true)
    const handleVisibility = (): void => publish(document.visibilityState === 'visible', true)
    observer.observe(element)
    overlayObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'aria-hidden'] })
    window.addEventListener('resize', handleWindowLayout)
    document.addEventListener('visibilitychange', handleVisibility)
    publish(true, true)

    return () => {
      observer.disconnect()
      overlayObserver.disconnect()
      window.removeEventListener('resize', handleWindowLayout)
      document.removeEventListener('visibilitychange', handleVisibility)
      if (frame) cancelAnimationFrame(frame)
      void window.electronAPI.browser.setLayout({
        ownerSessionId: state.ownerSessionId,
        browserSessionId: state.browserSessionId,
        pageId,
        revision: nextBrowserLayoutRevision(),
        visible: false,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      }).catch(() => {})
    }
  }, [pageId, state.browserSessionId, state.ownerSessionId])

  return (
    <div
      ref={ref}
      className="flex-1 min-h-0 bg-muted/20 titlebar-no-drag"
      aria-label="内置浏览器页面"
    />
  )
}

function isObscuredByAppOverlay(slot: HTMLElement, slotRect: DOMRect): boolean {
  const candidates = document.querySelectorAll<HTMLElement>(
    '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"], [data-browser-native-overlay="true"]',
  )
  for (const candidate of candidates) {
    if (candidate === slot || candidate.contains(slot) || candidate.hidden) continue
    const style = window.getComputedStyle(candidate)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue
    const rect = candidate.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    if (rectanglesOverlap(slotRect, rect)) return true
  }
  return false
}

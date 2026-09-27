import { atom } from 'jotai'
import type { ViewportSize } from './viewportResizeFrameQueue.ts'

/** 仅 v2 的会话内显示偏好，不是浏览器页面配置或 Main 控制信号。 */
export interface BrowserViewportPreference { responsive: boolean; size: ViewportSize }
export const browserViewportPreferencesAtom = atom<Map<string, BrowserViewportPreference>>(new Map())
export const browserViewportKey = (ownerSessionId: string, browserSessionId: string): string => `${ownerSessionId}:${browserSessionId}`
const DEFAULT_PREFERENCE: BrowserViewportPreference = { responsive: false, size: { width: 390, height: 844 } }
export function getBrowserViewportPreference(current: Map<string, BrowserViewportPreference>, key: string): BrowserViewportPreference {
  return current.get(key) ?? DEFAULT_PREFERENCE
}
export function updateBrowserViewportPreference(
  current: Map<string, BrowserViewportPreference>, key: string, preference: BrowserViewportPreference,
): Map<string, BrowserViewportPreference> {
  const next = new Map(current)
  next.delete(key)
  next.set(key, preference)
  // 限制已关闭页面残留的临时 UI 偏好数量，不驱逐 Main 浏览器或用户数据。
  while (next.size > 32) next.delete(next.keys().next().value as string)
  return next
}

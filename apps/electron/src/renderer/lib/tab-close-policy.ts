import type { TabItem } from '@/atoms/tab-atoms'

/**
 * 主区标签关闭策略：草稿入口固定保留，当前正在使用的 Work 会话由会话菜单管理生命周期。
 * 非活动 Work 标签与 Chat / Preview 标签仍可作为临时入口关闭。
 */
export function canCloseMainTab(tab: TabItem | undefined, activeTabId: string | null): boolean {
  if (!tab || tab.type === 'scratch') return false
  return !(tab.type === 'agent' && tab.id === activeTabId)
}

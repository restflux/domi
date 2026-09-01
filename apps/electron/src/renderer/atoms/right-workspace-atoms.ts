import { atom } from 'jotai'
import {
  agentSidePanelOpenAtom,
  agentSidePanelWidthAtom,
} from './agent-atoms'
import {
  activateRightWorkspaceTab,
  activateRightWorkspaceTool,
  closeRightWorkspaceTool,
  type RightWorkspaceAvailability,
  type RightWorkspaceSessionState,
  type RightWorkspaceTabId,
  type RightWorkspaceTool,
} from '@/lib/right-workspace-model'

/** Right Workspace 的展开状态沿用原右侧面板偏好，避免升级后重置用户设置。 */
export const rightWorkspaceOpenAtom = agentSidePanelOpenAtom

/** Right Workspace 的宽度沿用原右侧面板偏好。 */
export const rightWorkspaceWidthAtom = agentSidePanelWidthAtom

export type RightWorkspaceFocusableTool = RightWorkspaceTool

export interface RightWorkspaceFocus {
  sessionId: string
  tool: RightWorkspaceFocusableTool
  tabId?: RightWorkspaceTabId
}

/** Right Workspace 聚焦模式同时绑定 owner Work Session 与工具，只改变布局宽度，不卸载内容。 */
export const rightWorkspaceFocusAtom = atom<RightWorkspaceFocus | null>(null)

export function resolveRightWorkspaceFocus(
  focus: RightWorkspaceFocus | null,
  sessionId: string | null,
  tabId: RightWorkspaceTabId,
): boolean {
  return Boolean(sessionId && focus?.sessionId === sessionId && (focus.tabId ?? focus.tool) === tabId)
}

export function toggleRightWorkspaceFocus(
  focus: RightWorkspaceFocus | null,
  sessionId: string,
  tabId: RightWorkspaceTabId,
): RightWorkspaceFocus | null {
  const tool: RightWorkspaceTool = tabId.startsWith('browser:') ? 'browser' : tabId as RightWorkspaceTool
  if (resolveRightWorkspaceFocus(focus, sessionId, tabId)) return null
  return tabId.startsWith('browser:') ? { sessionId, tool, tabId } : { sessionId, tool }
}

/** 只响应当前 owner Session 的对应 Browser 原生页面 Escape，不干扰其他标签或 Session。 */
export function resolveBrowserFocusEscape(
  focus: RightWorkspaceFocus | null,
  ownerSessionId: string,
  browserSessionId?: string,
): RightWorkspaceFocus | null {
  if (focus?.sessionId !== ownerSessionId || focus.tool !== 'browser') return focus
  if (!browserSessionId || (focus.tabId ?? 'browser') === `browser:${browserSessionId}`) return null
  return focus
}

/** 每个 Work Session 独立保存当前工具与返回目标。 */
export const rightWorkspaceSessionStateMapAtom = atom<Map<string, RightWorkspaceSessionState>>(new Map())

export function activateSessionRightWorkspaceTab(
  current: Map<string, RightWorkspaceSessionState>,
  sessionId: string,
  tabId: RightWorkspaceTabId,
): Map<string, RightWorkspaceSessionState> {
  const next = new Map(current)
  next.set(sessionId, activateRightWorkspaceTab(current.get(sessionId), tabId))
  return next
}

export function activateSessionRightWorkspaceTool(
  current: Map<string, RightWorkspaceSessionState>,
  sessionId: string,
  tool: RightWorkspaceTool,
): Map<string, RightWorkspaceSessionState> {
  const next = new Map(current)
  next.set(sessionId, activateRightWorkspaceTool(current.get(sessionId), tool))
  return next
}

export function closeSessionRightWorkspaceTool(
  current: Map<string, RightWorkspaceSessionState>,
  sessionId: string,
  tool: RightWorkspaceTool,
  availability: RightWorkspaceAvailability,
): Map<string, RightWorkspaceSessionState> {
  const next = new Map(current)
  next.set(sessionId, closeRightWorkspaceTool(current.get(sessionId), tool, availability))
  return next
}

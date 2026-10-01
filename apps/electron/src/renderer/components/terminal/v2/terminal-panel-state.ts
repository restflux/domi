import type { TerminalSessionView } from '@domi/shared'
import { selectDockTerminals } from '../terminal-dock-model.ts'
import {
  terminalTabId,
  toolFromRightWorkspaceTab,
  type RightWorkspaceSessionState,
  type RightWorkspaceTabId,
  type RightWorkspaceTool,
} from '@/lib/right-workspace-model.ts'

/**
 * ZCode terminalPanelState 的 Domi 投影。
 *
 * ZCode 将 workspace、active session 和 panel 可见性作为一个生命周期处理；
 * Domi 的 PTY 仍由 Main/utility 持有，因此这里只保存 renderer 的面板投影，
 * 不创建、关闭或重新归属 terminal。所有输入都先经过 owner/session 过滤。
 */
export interface TerminalPanelState {
  open: boolean
  activeTerminalId?: string
}

export type TerminalPanelEvent =
  | { type: 'open'; terminalId?: string }
  | { type: 'close-panel' }
  | { type: 'select'; terminalId: string }
  | { type: 'create'; terminalId: string }
  | { type: 'close-session'; terminalId: string; previousIds: readonly string[]; remainingIds: readonly string[] }
  | { type: 'sync'; terminals: readonly TerminalSessionView[] }

function firstTerminalId(terminals: readonly TerminalSessionView[]): string | undefined {
  return terminals[0]?.terminalId
}

/**
 * 将面板事件折叠为单一状态转换，避免 Dock、全局 IPC listener 和重开路径各自
 * 实现一套 active-tab fallback。不存在的 terminalId 永远不能成为 active tab。
 */
export function reduceTerminalPanelState(
  state: TerminalPanelState,
  event: TerminalPanelEvent,
): TerminalPanelState {
  switch (event.type) {
    case 'open':
      return {
        open: true,
        activeTerminalId: event.terminalId ?? state.activeTerminalId,
      }
    case 'close-panel':
      return { ...state, open: false }
    case 'select':
      return { ...state, open: true, activeTerminalId: event.terminalId }
    case 'create':
      return { open: true, activeTerminalId: event.terminalId }
    case 'close-session': {
      const nextActive = state.activeTerminalId === event.terminalId
        ? event.remainingIds[Math.max(0, event.previousIds.indexOf(event.terminalId) - 1)] ?? event.remainingIds[0]
        : event.remainingIds.includes(state.activeTerminalId ?? '') ? state.activeTerminalId : event.remainingIds[0]
      return { ...state, activeTerminalId: nextActive }
    }
    case 'sync': {
      const ids = new Set(event.terminals.map((terminal) => terminal.terminalId))
      if (state.activeTerminalId && ids.has(state.activeTerminalId)) return state
      return { ...state, activeTerminalId: firstTerminalId(event.terminals) }
    }
  }
}

export function getDockPanelState(
  state: TerminalPanelState,
  terminals: Iterable<TerminalSessionView>,
  ownerSessionId: string,
): TerminalPanelState {
  return reduceTerminalPanelState(state, {
    type: 'sync',
    terminals: selectDockTerminals(terminals, ownerSessionId),
  })
}

export function createInitialTerminalPanelState(open = false): TerminalPanelState {
  return { open }
}

/**
 * PTY 退出/关闭后同步右侧 terminal:<id> 标签。右侧工具栏的其它标签不参与
 * PTY 生命周期；只有引用已关闭 terminal 的 active/previous tab 才会回退。
 */
export function reconcileClosedWorkspaceTerminal(
  state: RightWorkspaceSessionState,
  closedTerminalId: string,
  remainingTerminalIds: readonly string[],
): RightWorkspaceSessionState {
  const closedTab = terminalTabId(closedTerminalId)
  const activeTabId = state.activeTabId
  const previousTabId = state.previousTabId
  if (activeTabId !== closedTab && previousTabId !== closedTab) return state

  const fallbackTabId: RightWorkspaceTabId = previousTabId && previousTabId !== closedTab
    ? previousTabId
    : remainingTerminalIds[0]
      ? terminalTabId(remainingTerminalIds[0])
      : state.activeTool === 'terminal'
        ? 'files'
        : state.activeTool

  return {
    ...state,
    activeTabId: activeTabId === closedTab ? fallbackTabId : activeTabId,
    previousTabId: previousTabId === closedTab ? undefined : previousTabId,
    activeTool: activeTabId === closedTab ? toolFromRightWorkspaceTab(fallbackTabId) : state.activeTool,
  }
}

export interface TerminalWorkspaceFocus {
  sessionId: string
  tool: RightWorkspaceTool
  tabId?: RightWorkspaceTabId
}

/** 终端标签关闭后同步聚焦模式，避免 focus 仍指向已释放的 terminal:<id>。 */
export function reconcileClosedWorkspaceFocus(
  focus: TerminalWorkspaceFocus | null,
  ownerSessionId: string,
  closedTerminalId: string,
  remainingTerminalIds: readonly string[],
): TerminalWorkspaceFocus | null {
  const closedTab = terminalTabId(closedTerminalId)
  if (!focus || focus.sessionId !== ownerSessionId || focus.tabId !== closedTab) return focus

  const fallbackTerminalId = remainingTerminalIds[0]
  if (!fallbackTerminalId) return null

  return {
    ...focus,
    tool: 'terminal',
    tabId: terminalTabId(fallbackTerminalId),
  }
}

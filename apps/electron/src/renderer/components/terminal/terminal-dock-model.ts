import type { TerminalSessionView } from '@domi/shared'

/** 底部 Dock 只承载顶部入口或 Dock 内部创建的手动 Shell。 */
export function selectDockTerminals(
  terminals: Iterable<TerminalSessionView>,
  ownerSessionId: string,
): TerminalSessionView[] {
  return [...terminals]
    .filter((terminal) => terminal.ownerSessionId === ownerSessionId
      && terminal.kind === 'user-shell'
      && terminal.presentation === 'dock')
    .sort((left, right) => left.startedAt - right.startedAt)
}

/** Right Workspace 同时承载 Agent Run 和从右侧菜单创建的手动 Shell。 */
export function selectWorkspaceTerminals(
  terminals: Iterable<TerminalSessionView>,
  ownerSessionId: string,
): TerminalSessionView[] {
  return [...terminals]
    .filter((terminal) => terminal.ownerSessionId === ownerSessionId && terminal.presentation === 'workspace')
    .sort((left, right) => left.startedAt - right.startedAt)
}

/**
 * 对齐 ZCode terminalPanelState：关闭当前 active tab 时优先回到前一个 tab，
 * 关闭非 active tab 时保留当前 active；没有前一个时才回到剩余列表首项。
 */
export function resolveClosedDockTerminalId(
  previousIds: readonly string[],
  remainingIds: readonly string[],
  closedId: string,
  activeId?: string,
): string | undefined {
  if (activeId && activeId !== closedId && remainingIds.includes(activeId)) return activeId
  const closedIndex = previousIds.indexOf(closedId)
  return remainingIds[Math.max(0, closedIndex - 1)] ?? remainingIds[0]
}

export function terminalStatusLabel(terminal: TerminalSessionView): string {
  if (terminal.sourceTarget?.stale) return '上一轮'
  if (terminal.status === 'starting') return '启动中'
  if (terminal.status === 'running') return '运行中'
  if (terminal.status === 'stopped') return '已停止'
  if (terminal.status === 'failed') return '启动失败'
  return terminal.exitCode === undefined ? '已退出' : `已退出 ${terminal.exitCode}`
}

export function countRunningTerminals(terminals: readonly TerminalSessionView[]): number {
  return terminals.filter((terminal) => terminal.status === 'starting' || terminal.status === 'running').length
}

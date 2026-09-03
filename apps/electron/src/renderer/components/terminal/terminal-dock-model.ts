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

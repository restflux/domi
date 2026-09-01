import type { TerminalSessionView } from '@domi/shared'

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

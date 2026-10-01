import type { TerminalCreateInput, TerminalProfile, TerminalSessionView } from '@domi/shared'

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

/**
 * 对齐 ZCode getTerminalSessionCloseAction：最后一个 tab 的关闭动作是收起面板，
 * 不主动关闭 PTY；只有多个 tab 时才关闭对应 session。
 */
export type DockTerminalCloseAction = 'none' | 'close-panel' | 'close-session'

export function getDockTerminalCloseAction(
  terminals: readonly TerminalSessionView[],
  terminalId: string,
): DockTerminalCloseAction {
  if (!terminals.some((terminal) => terminal.terminalId === terminalId)) return 'none'
  return terminals.length === 1 ? 'close-panel' : 'close-session'
}

/**
 * ZCode 在 shell ready 后用探测到的 shell 名称刷新 tab；宿主返回的 title 仍作为稳定回退。
 */
export function getTerminalTabTitle(terminal: TerminalSessionView, shellLabel?: string): string {
  return shellLabel?.trim() || terminal.title
}

/** 上游 lib/path getPathLeaf：取路径最后一段作为项目名，空路径返回空串。 */
export function getPathLeaf(path: string): string {
  const leaf = path.split(/[\\/]/).filter(Boolean).pop()
  return leaf ?? ''
}

/**
 * 上游 terminalPanelState formatTerminalTabTitle：首个 tab 只显示项目名，
 * 其余追加 owner 内序号（"domi"、"domi 2"）。
 */
export function formatTerminalTabTitle(projectName: string, index: number): string {
  return index === 1 ? projectName : `${projectName} ${index}`
}

/**
 * ZCode tab 标题：项目名（cwd leaf，回退宿主 title）+ owner 内创建序号。
 * 差异说明：上游序号持久在 session descriptor 上（关闭中间 tab 后保留缺口），
 * Domi 无持久序号，用 startedAt 排名替代，关闭中间 tab 后会重排。
 */
export function getZCodeTerminalTabTitle(terminal: TerminalSessionView, index: number): string {
  const projectName = getPathLeaf(terminal.cwd ?? '') || terminal.title
  return formatTerminalTabTitle(projectName, index)
}

/** ZCode SHORTCUT_COMMANDS toggleTerminal（CmdOrCtrl+j）触发的面板动作决策。 */
export type TerminalToggleAction = 'none' | 'collapse' | 'open' | 'open-and-create'

export function resolveTerminalToggleAction(
  hasOwner: boolean,
  panelOpen: boolean,
  terminalCount: number,
): TerminalToggleAction {
  if (!hasOwner) return 'none'
  if (panelOpen) return 'collapse'
  return terminalCount > 0 ? 'open' : 'open-and-create'
}

/** ZCode Dock 终端的创建请求：owner 绑定 + dock 展示 + zcode 引擎。 */
export function buildZCodeDockTerminalInput(ownerSessionId: string, profile: TerminalProfile): TerminalCreateInput {
  return { ownerSessionId, profile, presentation: 'dock', engine: 'zcode', cols: 100, rows: 28 }
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

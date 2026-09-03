export type RightWorkspaceTool = 'files' | 'changes' | 'browser' | 'terminal' | 'scratch' | 'preview' | 'side-chat'

export interface RightWorkspaceAvailability {
  hasPreview: boolean
  hasSideChat: boolean
}

export type RightWorkspaceTabId = RightWorkspaceTool | `browser:${string}` | `terminal:${string}`

export interface RightWorkspaceSessionState {
  activeTool: RightWorkspaceTool
  previousTool?: RightWorkspaceTool
  activeTabId?: RightWorkspaceTabId
  previousTabId?: RightWorkspaceTabId
  scratchVisible?: boolean
}

export function browserTabId(browserSessionId: string): `browser:${string}` {
  return `browser:${browserSessionId}`
}

export function browserSessionIdFromTab(tabId: RightWorkspaceTabId): string | null {
  return tabId.startsWith('browser:') ? tabId.slice('browser:'.length) : null
}

export function terminalTabId(terminalId: string): `terminal:${string}` {
  return `terminal:${terminalId}`
}

export function terminalIdFromTab(tabId: RightWorkspaceTabId): string | null {
  return tabId.startsWith('terminal:') ? tabId.slice('terminal:'.length) : null
}

export function toolFromRightWorkspaceTab(tabId: RightWorkspaceTabId): RightWorkspaceTool {
  if (tabId.startsWith('browser:')) return 'browser'
  if (tabId.startsWith('terminal:')) return 'terminal'
  return tabId as RightWorkspaceTool
}

export function resolveClosedTabFallback(
  tabIds: readonly RightWorkspaceTabId[],
  closingTabId: RightWorkspaceTabId,
  previousTabId?: RightWorkspaceTabId,
): RightWorkspaceTabId {
  if (previousTabId && previousTabId !== closingTabId && tabIds.includes(previousTabId)) return previousTabId
  const closingIndex = tabIds.indexOf(closingTabId)
  return tabIds[closingIndex - 1] ?? tabIds[closingIndex + 1] ?? 'files'
}

export const DEFAULT_RIGHT_WORKSPACE_TOOL: RightWorkspaceTool = 'files'

export const RIGHT_WORKSPACE_PRIMARY_TOOLS: readonly RightWorkspaceTool[] = [
  'files',
  'changes',
]

export const RIGHT_WORKSPACE_ADDABLE_TOOLS: readonly RightWorkspaceTool[] = [
  'browser',
  'scratch',
]

/** 文件与改动常驻；正在使用的低频工具临时出现在工具带中。 */
export function getRightWorkspaceToolbarTools(activeTool: RightWorkspaceTool): RightWorkspaceTool[] {
  return RIGHT_WORKSPACE_PRIMARY_TOOLS.includes(activeTool)
    ? [...RIGHT_WORKSPACE_PRIMARY_TOOLS]
    : [...RIGHT_WORKSPACE_PRIMARY_TOOLS, activeTool]
}

/** 添加菜单只创建 Browser 或恢复草稿；预览和问答继续由各自业务流程打开。 */
export function getRightWorkspaceMenuTools(): RightWorkspaceTool[] {
  return [...RIGHT_WORKSPACE_ADDABLE_TOOLS]
}

/** 标签可自然排列时，添加按钮紧跟标签；空间不足时固定到展开按钮左侧。 */
export function shouldPinRightWorkspaceMenu(
  containerWidth: number,
  toolsWidth: number,
  menuWidth = 32,
  gap = 4,
): boolean {
  return toolsWidth + menuWidth + gap > containerWidth
}

/** 只有真实持有可关闭内容的工具才显示关闭操作。 */
export function canCloseRightWorkspaceTool(
  tool: RightWorkspaceTool,
  hasBrowserSession: boolean,
): boolean {
  return tool === 'preview' || tool === 'side-chat' || (tool === 'browser' && hasBrowserSession)
}

export function isRightWorkspaceToolAvailable(
  tool: RightWorkspaceTool,
  availability: RightWorkspaceAvailability,
): boolean {
  if (tool === 'preview') return availability.hasPreview
  if (tool === 'side-chat') return availability.hasSideChat
  return true
}

export function resolveRightWorkspaceTool(
  state: RightWorkspaceSessionState | undefined,
  availability: RightWorkspaceAvailability,
): RightWorkspaceTool {
  const activeTool = state?.activeTool ?? DEFAULT_RIGHT_WORKSPACE_TOOL
  return isRightWorkspaceToolAvailable(activeTool, availability)
    ? activeTool
    : DEFAULT_RIGHT_WORKSPACE_TOOL
}

export function activateRightWorkspaceTab(
  state: RightWorkspaceSessionState | undefined,
  tabId: RightWorkspaceTabId,
): RightWorkspaceSessionState {
  const activeTool = state?.activeTool ?? DEFAULT_RIGHT_WORKSPACE_TOOL
  const activeTabId = state?.activeTabId ?? activeTool
  const tool = toolFromRightWorkspaceTab(tabId)
  if (activeTabId === tabId) return state ?? { activeTool, activeTabId }

  return {
    ...state,
    activeTool: tool,
    previousTool: activeTool,
    activeTabId: tabId,
    previousTabId: activeTabId,
    ...(tool === 'scratch' ? { scratchVisible: true } : {}),
  }
}

export function activateRightWorkspaceTool(
  state: RightWorkspaceSessionState | undefined,
  tool: RightWorkspaceTool,
): RightWorkspaceSessionState {
  const activeTool = state?.activeTool ?? DEFAULT_RIGHT_WORKSPACE_TOOL
  if (activeTool === tool) return state ?? { activeTool }
  return { activeTool: tool, previousTool: activeTool }
}

export interface RightWorkspaceVisibilityInput {
  appMode: 'chat' | 'agent' | 'scratch'
  hasSession: boolean
  open: boolean
  automationFormOpen: boolean
  activeView: string
}

export function shouldShowRightWorkspace({
  appMode,
  hasSession,
  open,
  automationFormOpen,
  activeView,
}: RightWorkspaceVisibilityInput): boolean {
  return appMode === 'agent'
    && hasSession
    && open
    && !automationFormOpen
    && activeView !== 'planning'
    && activeView !== 'work-activity'
    && activeView !== 'agent-skills'
}

export function closeRightWorkspaceTool(
  state: RightWorkspaceSessionState | undefined,
  tool: RightWorkspaceTool,
  availability: RightWorkspaceAvailability,
): RightWorkspaceSessionState {
  const activeTool = state?.activeTool ?? DEFAULT_RIGHT_WORKSPACE_TOOL
  if (activeTool !== tool) return state ?? { activeTool }

  const fallback = state?.previousTool
  return {
    activeTool: fallback && isRightWorkspaceToolAvailable(fallback, availability)
      ? fallback
      : DEFAULT_RIGHT_WORKSPACE_TOOL,
  }
}

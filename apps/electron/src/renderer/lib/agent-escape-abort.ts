export const AGENT_ESCAPE_ABORT_CONFIRM_WINDOW_MS = 2_000

export type AgentEscapeAbortDecision =
  | { action: 'confirm'; armedUntil: number }
  | { action: 'abort'; armedUntil: null }

export interface AgentEscapeAbortContext {
  sessionRootPresent: boolean
  sessionRootHidden: boolean
  hasOpenDialog: boolean
}

/**
 * 只有当前会话仍处于可交互前台、且没有更高优先级弹窗时，Escape 才可进入停止确认。
 */
export function shouldHandleAgentEscapeAbort({
  sessionRootPresent,
  sessionRootHidden,
  hasOpenDialog,
}: AgentEscapeAbortContext): boolean {
  return sessionRootPresent && !sessionRootHidden && !hasOpenDialog
}

/**
 * 将 Escape 停止操作变成短时双击确认，避免关闭浮层或取消输入时误停 Agent。
 */
export function decideAgentEscapeAbort(
  armedUntil: number | null,
  now = Date.now(),
): AgentEscapeAbortDecision {
  if (armedUntil !== null && now <= armedUntil) {
    return { action: 'abort', armedUntil: null }
  }

  return {
    action: 'confirm',
    armedUntil: now + AGENT_ESCAPE_ABORT_CONFIRM_WINDOW_MS,
  }
}

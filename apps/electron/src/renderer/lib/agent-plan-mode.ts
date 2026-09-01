import type { AgentPlanModeChangeSource, DomiPermissionMode } from '@domi/shared'

export interface PlanModeChange {
  active: boolean
  source: AgentPlanModeChangeSource
}

/** 从 SDK 工具名解析计划阶段变化。 */
export function getPlanModeChangeFromToolName(toolName: string): PlanModeChange | null {
  if (toolName === 'EnterPlanMode') {
    return { active: true, source: 'tool' }
  }
  // ExitPlanMode 只是发起退出计划的审批请求，不能在工具开始时视为已退出。
  // 真正退出由后端在用户批准后发送 plan_mode_changed(active=false)。
  return null
}

/** 更新计划阶段会话集合；无变化时复用原 Set，减少 Jotai 下游刷新。 */
export function updatePlanModeSessionSet(
  prev: Set<string>,
  sessionId: string,
  active: boolean,
): Set<string> {
  if (active) {
    if (prev.has(sessionId)) return prev
    const next = new Set(prev)
    next.add(sessionId)
    return next
  }

  if (!prev.has(sessionId)) return prev
  const next = new Set(prev)
  next.delete(sessionId)
  return next
}

/**
 * 只有精确 run 的真正终态才能清除 Plan 状态。后台任务软空闲仍属于同一 run；
 * 旧 run 的迟到 complete 也不能覆盖已经启动的新 run。
 */
export function shouldClearPlanModeAfterStreamComplete(
  currentRunStartedAt: number | undefined,
  completedRunStartedAt: number | undefined,
  backgroundTasksPending: boolean,
): boolean {
  if (backgroundTasksPending) return false
  if (currentRunStartedAt != null
    && (completedRunStartedAt == null || currentRunStartedAt > completedRunStartedAt)) {
    return false
  }
  return true
}

/** 输入区处于计划阶段时，权限按钮也优先展示计划模式图标。 */
export function getDisplayedPermissionMode(
  permissionMode: DomiPermissionMode,
  planModeActive: boolean,
): DomiPermissionMode {
  return planModeActive ? 'plan' : permissionMode
}

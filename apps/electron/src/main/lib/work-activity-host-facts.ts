import type {
  AgentSessionMeta,
  WorkActivityPendingActionFact,
  WorkActivitySource,
  WorktreeDeliveryView,
} from '@domi/shared'

export function projectSessionTargetPendingActions(
  delivery: WorktreeDeliveryView | undefined,
): WorkActivityPendingActionFact[] {
  if (!delivery) return []
  if (delivery.state === 'ready_for_review' || delivery.state === 'preview_active') {
    return [{
      kind: 'ready_for_review',
      summary: delivery.state === 'preview_active' ? '等待完成 Local 验收' : '等待验收',
      occurredAt: delivery.state === 'preview_active' ? delivery.previewedAt : delivery.review.preparedAt,
    }]
  }
  if (delivery.state === 'preview_detached') {
    return [{
      kind: 'conflict',
      summary: delivery.reason === 'preview_modified' ? 'Local 验收内容已变化，需要处理' : 'Local 已变化，需要处理',
      occurredAt: delivery.detachedAt,
    }]
  }
  if (delivery.state === 'finalized' && delivery.cleanup === 'blocked') {
    return [{
      kind: 'conflict',
      summary: delivery.cleanupMessage?.trim() || 'Worktree 清理需要处理',
      occurredAt: delivery.review.preparedAt,
    }]
  }
  if (delivery.state === 'retained' && delivery.cleanup === 'blocked') {
    return [{
      kind: 'conflict',
      summary: delivery.cleanupMessage?.trim() || '保留环境清理需要处理',
      occurredAt: delivery.review.preparedAt,
    }]
  }
  return []
}

export function projectWorkActivitySource(
  session: Pick<AgentSessionMeta, 'sourceAutomationId' | 'automationGraduated'>,
  automationName?: string,
): { source: WorkActivitySource; automationName?: string } {
  if (!session.sourceAutomationId || session.automationGraduated) return { source: 'manual' }
  return {
    source: 'automation',
    ...(automationName?.trim() ? { automationName: automationName.trim() } : {}),
  }
}

interface WorkActivityHostMetadataDependencies {
  getWorkspaceName: (workspaceId: string) => string | undefined
  getAutomationName: (automationId: string) => string | undefined
  warn?: (message: string, error: unknown) => void
}

export function describeWorkActivityHostFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error)
  return `读取工作动态失败：${reason.trim() || '未知宿主错误'}`
}

/**
 * 按会话隔离可选宿主元数据读取。工作区或 Automation 的历史索引即使损坏，
 * 也只会让当前条目降级为兜底文案，不能让全局 Work Activity 投影失败。
 */
export function resolveWorkActivityHostMetadata(
  session: Pick<AgentSessionMeta, 'id' | 'workspaceId' | 'sourceAutomationId' | 'automationGraduated'>,
  dependencies: WorkActivityHostMetadataDependencies,
): { workspaceName: string; source: WorkActivitySource; automationName?: string } {
  let workspaceName = '未分组项目'
  if (session.workspaceId) {
    try {
      workspaceName = dependencies.getWorkspaceName(session.workspaceId)?.trim() || workspaceName
    } catch (error) {
      dependencies.warn?.(`[Work Activity] 读取工作区失败: ${session.id}`, error)
    }
  }

  let automationName: string | undefined
  if (session.sourceAutomationId && !session.automationGraduated) {
    try {
      automationName = dependencies.getAutomationName(session.sourceAutomationId)
    } catch (error) {
      dependencies.warn?.(`[Work Activity] 读取 Automation 失败: ${session.id}`, error)
    }
  }

  return {
    workspaceName,
    ...projectWorkActivitySource(session, automationName),
  }
}

import type { AgentSessionHandoffResult } from '@domi/shared'

export interface SessionHandoffFeedback {
  title: string
  description: string
}

export function getSessionHandoffFeedback(
  result: Pick<AgentSessionHandoffResult, 'mode' | 'reused'>,
  targetKind: 'local' | 'isolated',
): SessionHandoffFeedback {
  if (result.mode === 'degraded') {
    return {
      title: result.reused ? '已打开现有降级接力会话' : '已降级交接到新会话',
      description: targetKind === 'isolated'
        ? '未继承完整 Pi 历史；新 Agent 会结合有界会话上下文和 retained Git 证据恢复缺失增量。'
        : '未继承完整 Pi 历史；新 Agent 会读取宿主导出的有界会话上下文和 durable handoff。',
    }
  }
  return {
    title: result.reused ? '已打开现有接力会话' : '已交接到新会话',
    description: targetKind === 'isolated'
      ? '新 Agent 会在 fresh managed Worktree 中自动继续。'
      : '新 Agent 会继续使用当前 Local，并读取 durable handoff。',
  }
}

import type { SessionCheckoutOperationResult, SessionTargetView, WorktreeRetentionMode } from '@domi/shared'
import { normalizeAgentCommitMessage } from './agent-commit-message.ts'
import { SessionCheckoutError } from './session-checkout/index.ts'

export interface AgentWorktreeApplyAvailabilityInput {
  targetKind?: 'local' | 'isolated'
  ownership?: 'owner' | 'inherited'
  triggeredBy?: 'user' | 'automation' | 'delegation' | 'bridge' | 'channel'
  sourceDelegationId?: string
}

export interface AgentWorktreeApplyDependencies {
  inspectTarget(sessionId: string): Promise<SessionTargetView>
  operateApply(input: {
    action: 'apply'
    sessionId: string
    expectedRevision: number
  }): Promise<SessionCheckoutOperationResult>
  operateFinish(input: {
    action: 'finish'
    sessionId: string
    expectedRevision: number
    commitMessage: string
    retention?: WorktreeRetentionMode
  }): Promise<SessionCheckoutOperationResult>
  persistPreviewNotice?(sessionId: string, target: SessionTargetView): void
}

async function getProductionDependencies(): Promise<AgentWorktreeApplyDependencies> {
  // 延迟加载 production wiring，避免纯策略/单元测试导入 Electron 主进程模块。
  const [{ getSessionCheckoutModule }, { appendSDKMessages }, { createWorktreeReviewNotice }] = await Promise.all([
    import('./session-checkout/production.ts'),
    import('./agent-session-manager.ts'),
    import('./agent-worktree-review.ts'),
  ])
  const module = getSessionCheckoutModule()
  return {
    inspectTarget: (sessionId) => module.inspect(sessionId),
    operateApply: (input) => module.operate(input),
    operateFinish: (input) => module.operate(input),
    persistPreviewNotice: (sessionId, target) => appendSDKMessages(sessionId, [createWorktreeReviewNotice(sessionId, target)]),
  }
}

/** 只向直接交互的 owner Isolated 会话开放回写能力。 */
export function canOfferAgentWorktreeApply(input: AgentWorktreeApplyAvailabilityInput): boolean {
  return input.targetKind === 'isolated'
    && input.ownership === 'owner'
    && (input.triggeredBy ?? 'user') === 'user'
    && !input.sourceDelegationId
}

/**
 * Agent 只能调用 Domi 的确定性 Apply 生命周期，不能拿到 Local 绝对路径或绕过冲突检查。
 * 冲突结果携带 Local HEAD，供 Agent 在当前 Isolated Checkout 内 merge 解决后重新生成 ReadyForReview 验收卡。
 */
export async function applyAgentWorktree(
  sessionId: string,
  dependencies?: AgentWorktreeApplyDependencies,
): Promise<SessionCheckoutOperationResult> {
  const resolvedDependencies = dependencies ?? await getProductionDependencies()
  const target = await resolvedDependencies.inspectTarget(sessionId)
  if (target.checkout.kind !== 'isolated') {
    throw new SessionCheckoutError('operation_not_allowed', 'ApplyWorktree 仅适用于 managed Worktree 会话')
  }
  if (target.ownership !== 'owner') {
    throw new SessionCheckoutError('not_owner', '继承 Session Target 的会话不能执行 ApplyWorktree')
  }
  const result = await resolvedDependencies.operateApply({
    action: 'apply',
    sessionId,
    expectedRevision: target.revision,
  })
  const resultTarget = 'target' in result ? result.target : undefined
  if (
    target.delivery?.state !== 'ready_for_review'
    && resultTarget?.delivery?.state === 'preview_active'
  ) {
    resolvedDependencies.persistPreviewNotice?.(sessionId, resultTarget)
  }
  return result
}

/** 用户明确跳过验收时，一次完成单提交与 Worktree 清理。 */
export async function finishAgentWorktree(
  sessionId: string,
  commitMessage: string,
  retentionOrDependencies: WorktreeRetentionMode | AgentWorktreeApplyDependencies = 'cleanup',
  explicitDependencies?: AgentWorktreeApplyDependencies,
): Promise<SessionCheckoutOperationResult> {
  const retention = typeof retentionOrDependencies === 'string' ? retentionOrDependencies : 'cleanup'
  const dependencies = typeof retentionOrDependencies === 'string' ? explicitDependencies : retentionOrDependencies
  const message = normalizeAgentCommitMessage(commitMessage)
  if (!message) throw new SessionCheckoutError('invalid_input', '提交信息不能为空')
  const resolvedDependencies = dependencies ?? await getProductionDependencies()
  const target = await resolvedDependencies.inspectTarget(sessionId)
  if (target.checkout.kind !== 'isolated') {
    throw new SessionCheckoutError('operation_not_allowed', 'FinishWorktree 仅适用于 managed Worktree 会话')
  }
  if (target.ownership !== 'owner') {
    throw new SessionCheckoutError('not_owner', '继承 Session Target 的会话不能执行 FinishWorktree')
  }
  return resolvedDependencies.operateFinish({
    action: 'finish',
    sessionId,
    expectedRevision: target.revision,
    commitMessage: message,
    retention,
  })
}

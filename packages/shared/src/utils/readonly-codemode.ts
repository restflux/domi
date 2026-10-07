import type { AgentSessionMeta } from '../types/agent.ts'

export type ReadonlyCodemodeUnavailableReason = 'not-main-session' | 'minimal-preset'

/** 会话选项的可用性，不进行工具授权；实际调用仍由 Main 最终门禁决定。 */
export function getReadonlyCodemodeUnavailableReason(session: AgentSessionMeta | undefined): ReadonlyCodemodeUnavailableReason | undefined {
  if (!session || session.sideChatParentSessionId || session.parentSessionId || session.rootSessionId
    || session.sourceDelegationId || session.independentReviewId || (session.delegationDepth ?? 0) > 0) {
    return 'not-main-session'
  }
  if (session.modelPresentationPreset === 'minimal') return 'minimal-preset'
  return undefined
}

/** 只消费 Main 持有的会话快照；缺失/非法旧值不隐式开启。 */
export function resolveReadonlyCodemodeForRun(session: AgentSessionMeta | undefined): boolean {
  return session?.readonlyCodemode === true && getReadonlyCodemodeUnavailableReason(session) === undefined
}

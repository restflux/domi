import type { AgentSessionMeta } from '@domi/shared'

/** 新 Pi 的 unselected/isolated 意图不得被历史 Local 兼容策略吞掉。 */
export function resolveUnboundSessionTargetPolicy(
  session: Pick<AgentSessionMeta, 'sessionTarget'>,
): 'unselected' | 'local' {
  return session.sessionTarget === undefined || session.sessionTarget.kind === 'local'
    ? 'local'
    : 'unselected'
}

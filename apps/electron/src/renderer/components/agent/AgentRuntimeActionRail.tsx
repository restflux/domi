import * as React from 'react'
import type { SDKMessage } from '@domi/shared'
import type { AgentStreamState } from '@/atoms/agent-atoms'
import {
  AGENT_RUNNING_ORB_STATES,
  RotatingAgentActivityOrb,
} from '@/components/ui/agent-activity-orb'
import { ComposerActionRail } from './ComposerActionRail'
import { formatAgentUsageTokens } from './agent-session-usage'
import {
  formatAgentRuntimeDuration,
  useAgentRuntimeTelemetry,
  type AgentRuntimeProviderUsageSnapshot,
  type AgentRuntimeTelemetry,
} from './agent-runtime-telemetry'

export interface AgentRuntimeActionRailProps {
  visible: boolean
  streamState: AgentStreamState | undefined
  liveMessages: readonly SDKMessage[]
  providerUsage: AgentRuntimeProviderUsageSnapshot
  onTelemetry: (telemetry: AgentRuntimeTelemetry) => void
}

/**
 * Runtime 的时钟与 token-rate 状态被限制在这个小组件内。即使 500ms 时钟更新，昂贵的
 * AgentView、消息列表和 Composer 输入树也不会因此重新渲染。
 */
export const AgentRuntimeActionRail = React.memo(function AgentRuntimeActionRail({
  visible,
  streamState,
  liveMessages,
  providerUsage,
  onTelemetry,
}: AgentRuntimeActionRailProps): React.ReactElement | null {
  const runtimeTelemetry = useAgentRuntimeTelemetry({
    streaming: true,
    streamState,
    liveMessages,
    providerUsage,
  })

  React.useEffect(() => {
    onTelemetry(runtimeTelemetry)
  }, [
    onTelemetry,
    runtimeTelemetry.cacheCreationTokens,
    runtimeTelemetry.cacheReadTokens,
    runtimeTelemetry.elapsedSeconds,
    runtimeTelemetry.inputTokens,
    runtimeTelemetry.outputTokens,
    runtimeTelemetry.outputTokensEstimated,
    runtimeTelemetry.phase.detail,
    runtimeTelemetry.phase.kind,
    runtimeTelemetry.phase.label,
    runtimeTelemetry.providerRequestCount,
    runtimeTelemetry.tokensPerSecond,
  ])

  if (!visible) return null

  return (
    <ComposerActionRail
      dataKind="agent_runtime"
      dataTestId="agent-runtime-rail"
      icon={<RotatingAgentActivityOrb states={AGENT_RUNNING_ORB_STATES} size={20} speed={1.8} intervalMs={2400} />}
      iconClassName="size-5"
      contentClassName="max-w-[48%] flex-none"
      actions={(
        <>
          {runtimeTelemetry.inputTokens !== null && (
            <span
              data-testid="agent-runtime-input-tokens"
              className="composer-runtime-tokens hidden shrink-0 tabular-nums text-sky-700/80 min-[680px]:inline dark:text-sky-300/75"
            >
              输入 {formatAgentUsageTokens(runtimeTelemetry.inputTokens)}
            </span>
          )}
          {runtimeTelemetry.outputTokens !== null && (
            <span
              data-testid="agent-runtime-output-tokens"
              className="composer-runtime-tokens hidden shrink-0 tabular-nums text-emerald-700/80 min-[600px]:inline dark:text-emerald-300/75"
            >
              输出 {runtimeTelemetry.outputTokensEstimated ? '~' : ''}{formatAgentUsageTokens(runtimeTelemetry.outputTokens)}
            </span>
          )}
          {runtimeTelemetry.tokensPerSecond !== null && (
            <span
              data-testid="agent-runtime-token-rate"
              className="composer-runtime-rate hidden shrink-0 tabular-nums text-violet-700/80 min-[760px]:inline dark:text-violet-300/75"
            >
              ~{runtimeTelemetry.tokensPerSecond.toFixed(1)} tok/s
            </span>
          )}
          <span
            data-testid="agent-runtime-duration"
            className="shrink-0 tabular-nums text-muted-foreground/80"
          >
            {formatAgentRuntimeDuration(runtimeTelemetry.elapsedSeconds)}
          </span>
        </>
      )}
    >
      <span className="composer-runtime-title inline-block whitespace-nowrap font-medium">Domi is working…</span>
      <span className="composer-runtime-detail hidden min-[520px]:inline">
        {' · '}{runtimeTelemetry.phase.label}
        {runtimeTelemetry.phase.detail ? ` · ${runtimeTelemetry.phase.detail}` : ''}
      </span>
    </ComposerActionRail>
  )
})

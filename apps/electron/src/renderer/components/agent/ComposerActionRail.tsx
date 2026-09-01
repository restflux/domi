import * as React from 'react'
import type {
  SessionCheckoutPhase,
  WorktreeApplyPreflightBlockedReason,
  WorktreeApplyPreflightView,
  WorktreeDeliveryView,
} from '@domi/shared'
import { cn } from '@/lib/utils'

export type ComposerActionRailKind =
  | 'worktree_active'
  | 'agent_issue'
  | 'agent_runtime'
  | 'agent_summary'
  | 'channel_setup'
  | 'worktree_settled'

export type WorktreeRailPriority = 'urgent' | 'active' | 'settled'

interface WorktreeRailContext {
  preflightStatus?: WorktreeApplyPreflightView['status']
  preflightBlockedReason?: WorktreeApplyPreflightBlockedReason
  checkoutPhase?: SessionCheckoutPhase
}

export function composerRailOwnsRunningIndicator(kind: ComposerActionRailKind | null): boolean {
  return kind === 'agent_runtime'
}

export function resolveWorktreeRailPriority(
  delivery: Pick<WorktreeDeliveryView, 'state'> & { cleanup?: 'pending' | 'blocked' | 'scheduled' } | undefined,
  context: WorktreeRailContext = {},
): WorktreeRailPriority | null {
  if (!delivery || delivery.state === 'working') return null

  if (delivery.state === 'ready_for_review') {
    if (context.preflightStatus === 'conflict') return 'urgent'
    if (context.preflightStatus === 'blocked' && context.preflightBlockedReason !== 'project_acceptance_busy') return 'urgent'
    return 'active'
  }

  if (delivery.state === 'preview_active') {
    return context.checkoutPhase === 'recovery_required' ? 'urgent' : 'active'
  }

  if (delivery.state === 'preview_detached' || delivery.state === 'finalized') return 'urgent'
  if (delivery.state === 'retained' && delivery.cleanup === 'blocked') return 'urgent'
  return 'settled'
}

export function resolveComposerActionRailKind({
  modern,
  hasUrgentWorktreeAction,
  hasActiveWorktreeAction,
  hasAgentIssue,
  hasAgentRuntime,
  hasAgentSummary,
  hasChannelSetupAction,
  hasSettledWorktreeAction,
}: {
  modern: boolean
  hasUrgentWorktreeAction: boolean
  hasActiveWorktreeAction: boolean
  hasAgentIssue: boolean
  hasAgentRuntime: boolean
  hasAgentSummary: boolean
  hasChannelSetupAction: boolean
  hasSettledWorktreeAction: boolean
}): ComposerActionRailKind | null {
  if (!modern) return null
  if (hasAgentIssue) return 'agent_issue'
  if (hasAgentRuntime) return 'agent_runtime'
  if (hasUrgentWorktreeAction) return 'worktree_active'
  if (hasActiveWorktreeAction) return 'worktree_active'
  if (hasAgentSummary) return 'agent_summary'
  if (hasChannelSetupAction) return 'channel_setup'
  if (hasSettledWorktreeAction) return 'worktree_settled'
  return null
}

export function ComposerActionRail({
  icon,
  children,
  actions,
  className,
  dataKind,
  dataTestId,
  iconClassName,
  contentClassName,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  actions?: React.ReactNode
  className?: string
  dataKind: ComposerActionRailKind
  dataTestId?: string
  iconClassName?: string
  contentClassName?: string
}): React.ReactElement {
  return (
    <div
      data-composer-action-rail={dataKind}
      data-testid={dataTestId}
      className={cn(
        'composer-action-rail flex items-center gap-2 rounded-[10px] border border-transparent bg-transparent px-2.5 py-1.5 text-xs text-muted-foreground',
        className,
      )}
    >
      <span className={cn('inline-flex size-3.5 shrink-0 items-center justify-center', iconClassName)} aria-hidden="true">
        {icon}
      </span>
      <span className={cn('min-w-0 flex-1 truncate', contentClassName)}>
        {children}
      </span>
      {actions ? <span className="ml-auto flex shrink-0 items-center gap-1">{actions}</span> : null}
    </div>
  )
}

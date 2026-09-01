import type {
  RendererSessionTargetChoice,
  SessionCheckoutAction,
  SessionCheckoutKind,
  SessionCheckoutPhase,
  SessionTargetView,
  WorktreeDeliveryView,
  WorktreeCheckpointView,
} from '@domi/shared'

export type SessionTargetChoice = RendererSessionTargetChoice['kind']
export type SessionTargetKind = SessionCheckoutKind | 'unselected'
export type SessionTargetPhase = SessionCheckoutPhase | 'unselected'
export type SessionTargetOwnership = SessionTargetView['ownership']
export type SessionTargetPendingAction = SessionCheckoutAction

export interface SessionTargetProjectDisplayInput {
  name: string
}

export interface SessionTargetCheckoutDisplayInput {
  id: string
  kind: SessionTargetKind
  phase: SessionTargetPhase
}

export interface SessionTargetSourceDisplayInput {
  ref: string
  oid: string
}

export interface SessionTargetCurrentDisplayInput {
  branch: string | null
  oid: string
}

/**
 * Renderer 所需的最小结构。已选择目标必须携带 main 投影的 ownership 与 dirty；
 * 未选择状态用 null ownership 表达尚无 owner。
 */
export interface SessionTargetDisplayInput {
  project: SessionTargetProjectDisplayInput
  checkout: SessionTargetCheckoutDisplayInput
  source: SessionTargetSourceDisplayInput | null
  current: SessionTargetCurrentDisplayInput | null
  ownership: SessionTargetOwnership | null
  dirty: boolean
  pendingAction?: SessionTargetPendingAction | null
  running?: boolean
  delivery?: WorktreeDeliveryView
  checkpoints?: WorktreeCheckpointView[]
}

export interface SessionTargetIdentityViewModel {
  projectName: string
  targetLabel: string
  branchLabel: string
  headLabel: string
  sourceLabel: string | null
}

export interface SessionTargetActionViewModel {
  visible: boolean
  enabled: boolean
  pending: boolean
}

export interface SessionTargetActionsViewModel {
  apply: SessionTargetActionViewModel
  discard: SessionTargetActionViewModel
  recover: SessionTargetActionViewModel
}

export interface SessionTargetStatusViewModel {
  label: string
  tone: 'neutral' | 'progress' | 'ready' | 'warning' | 'muted'
}

export interface SessionTargetChoiceViewModel {
  choice: SessionTargetChoice
  label: string
  description: string
}

export interface SessionTargetChooserViewModel {
  visible: boolean
  options: SessionTargetChoiceViewModel[]
}

export interface SessionTargetInteractionInput {
  hasTarget: boolean
  selectionRequired: boolean
}

export interface SessionTargetInteraction {
  showControls: boolean
  requireChoiceBeforeSend: boolean
}

/** 新会话未绑定时不阻止发送，由 AgentView 在发送前自动绑定默认 Local 或已勾选的 Worktree。 */
export function getSessionTargetInteraction(input: SessionTargetInteractionInput): SessionTargetInteraction {
  return {
    showControls: true,
    requireChoiceBeforeSend: false,
  }
}

export interface RetryInNewSessionIntent {
  prompt: string
  mentionedSessionIds: string[]
  markAsDraft: true
  delivery: 'after_target_selection'
}

/** 新 Pi 草稿保留 retry prompt，由 target chooser 完成绑定后统一发送。 */
export function buildRetryInNewSessionIntent(sourceSessionId: string): RetryInNewSessionIntent {
  return {
    prompt: `请读取 &session:${sourceSessionId} 的历史，然后从上个会话停止的位置继续。`,
    mentionedSessionIds: [sourceSessionId],
    markAsDraft: true,
    delivery: 'after_target_selection',
  }
}

export interface SessionTargetViewModel {
  identity: SessionTargetIdentityViewModel
  status: SessionTargetStatusViewModel
  chooser: SessionTargetChooserViewModel
  actions: SessionTargetActionsViewModel
  inheritanceLabel: string | null
  discardNeedsConfirmation: boolean
}

function getStatus(input: SessionTargetDisplayInput): SessionTargetStatusViewModel {
  const { phase } = input.checkout
  const delivery = input.delivery
  // Checkout 生命周期终态优先于可能来自旧 registry/异步快照的交付状态。
  if (phase === 'discarded') return { label: delivery?.state === 'delivered' ? '已交付' : '已放弃', tone: 'muted' }
  if (delivery?.state === 'ready_for_review') return { label: '待验收', tone: 'warning' }
  if (delivery?.state === 'preview_active') return { label: 'Local 验收中', tone: 'progress' }
  if (delivery?.state === 'finalized') return delivery.cleanup === 'blocked'
    ? { label: '需要处理', tone: 'warning' }
    : { label: '清理中', tone: 'progress' }
  if (delivery?.state === 'retained') return delivery.cleanup === 'blocked'
    ? { label: '需要处理', tone: 'warning' }
    : { label: '已保留', tone: 'muted' }
  if (delivery?.state === 'delivered') return { label: '已交付', tone: 'muted' }
  if (delivery?.state === 'working' && input.checkout.kind === 'isolated') return { label: '修改中', tone: 'ready' }
  switch (phase) {
    case 'unselected':
      return { label: '选择会话代码位置', tone: 'neutral' }
    case 'preparing':
      return { label: '正在准备 Worktree', tone: 'progress' }
    case 'ready':
      return { label: input.checkout.kind === 'local' ? 'Local' : '修改中', tone: 'ready' }
    case 'applying':
      return { label: '正在应用修改', tone: 'progress' }
    case 'mutating':
      return { label: '正在更新 Local', tone: 'progress' }
    case 'finalized':
      return { label: '已交付，等待清理', tone: 'warning' }
    case 'retained':
      return { label: '已保留', tone: 'muted' }
    case 'recovery_required':
      return { label: '需要恢复', tone: 'warning' }
  }
}

function displaySourceRef(ref: string): string {
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
}

export function buildSessionTargetViewModel(input: SessionTargetDisplayInput): SessionTargetViewModel {
  const { checkout, current } = input
  const isIsolated = checkout.kind === 'isolated'
  const isOwner = input.ownership === 'owner'
  const isReady = checkout.phase === 'ready'
  const canDiscard = isReady || checkout.phase === 'recovery_required'
  const isDirty = input.dirty
  const pendingAction = input.pendingAction ?? null
  const hasPendingAction = pendingAction !== null || checkout.phase === 'applying' || checkout.phase === 'mutating'
  const destructiveActionBlocked = hasPendingAction || input.running === true

  return {
    identity: {
      projectName: input.project.name,
      targetLabel: checkout.kind === 'unselected'
        ? 'Local'
        : isIsolated
          ? 'Worktree'
          : 'Local',
      branchLabel: checkout.kind === 'unselected'
        ? ''
        : current?.branch ?? 'Detached',
      headLabel: checkout.kind === 'unselected'
        ? ''
        : current?.oid.slice(0, 7) || '未知 HEAD',
      sourceLabel: isIsolated && input.source
        ? `来自 ${displaySourceRef(input.source.ref)}`
        : null,
    },
    status: getStatus(input),
    chooser: {
      visible: checkout.kind === 'unselected',
      options: [
        { choice: 'local', label: 'Local', description: '直接在当前项目中工作' },
        { choice: 'isolated', label: 'Worktree', description: '基于当前 HEAD 创建，不复制 Local 未提交修改' },
      ],
    },
    actions: {
      apply: {
        visible: isIsolated && isOwner,
        enabled: isIsolated && isOwner && isReady && !destructiveActionBlocked,
        pending: pendingAction === 'apply' || checkout.phase === 'applying' || checkout.phase === 'mutating',
      },
      discard: {
        visible: isIsolated && isOwner,
        enabled: isIsolated && isOwner && canDiscard && !destructiveActionBlocked,
        pending: pendingAction === 'discard',
      },
      recover: {
        visible: isIsolated && isOwner && checkout.phase === 'recovery_required',
        enabled: isIsolated && isOwner && checkout.phase === 'recovery_required' && !destructiveActionBlocked,
        pending: pendingAction === 'recover',
      },
    },
    inheritanceLabel: isIsolated && !isOwner ? '共享父会话 Worktree' : null,
    discardNeedsConfirmation: isIsolated && isOwner && isDirty,
  }
}

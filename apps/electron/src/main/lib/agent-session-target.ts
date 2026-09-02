import type {
  AgentCwdMode,
  AgentWorkspace,
  ForkSessionTargetChoice,
  SessionTargetBindChoice,
  SessionTargetView,
} from '@domi/shared'
import { SessionCheckoutError, type CheckoutLease, type SessionCheckoutModule, type VerifiedIsolatedBindProof } from './session-checkout/index.ts'

export interface AgentSessionTargetInput {
  sessionId: string
  workspace?: Pick<AgentWorkspace, 'slug'>
  agentCwdMode?: AgentCwdMode
}

export interface AgentSessionTargetDependencies {
  checkout: Pick<SessionCheckoutModule, 'lease'>
}

export interface AgentSessionTarget {
  /** Adapter SDK 的 cwd。 */
  cwd: string
  /** Prompt 中声明的 cwd，必须与 Adapter cwd 同源。 */
  promptCwd: string
  /** Workspace Boundary root，仅授权当前 checkout。 */
  workspaceRoot: string
  /** 真实 Local Checkout root，仅用于捕获 Local Baseline。 */
  localBaselineRoot: string
  /** 当前交付迭代的原始稳定基线。 */
  deliveryBaseOid?: string
  /** 冲突整合后宿主确认的有效验收基线。 */
  reviewBaseOid?: string
  /** 有效验收基线的选择策略。 */
  reviewBaseStrategy?: CheckoutLease['reviewBaseStrategy']
  /** 建立有效验收基线时观察到的 Local HEAD。 */
  reviewLocalHeadOid?: string
  /** 最近一版验收，仅作为累计总结的辅助线索。 */
  previousReview?: CheckoutLease['previousReview']
  /** 已交付、已保留或正在验收的会话借用 Local 回答普通问题时，所有 mutation tool 必须保持只读。 */
  followupOnly: boolean
  followupReason?: CheckoutLease['followupReason']
  lease: CheckoutLease
}

/**
 * 解析 Pi 运行目标。SDK cwd、prompt cwd 与 Execution Policy root 均来自同一个 checkout lease。
 */
export async function resolveAgentSessionTarget(
  input: AgentSessionTargetInput,
  dependencies: AgentSessionTargetDependencies,
): Promise<AgentSessionTarget> {
  const lease = await dependencies.checkout.lease(input.sessionId)
  return {
    cwd: lease.cwd,
    promptCwd: lease.cwd,
    workspaceRoot: lease.allowedRoot,
    localBaselineRoot: lease.localRoot,
    ...(lease.deliveryBaseOid ? { deliveryBaseOid: lease.deliveryBaseOid } : {}),
    ...(lease.reviewBaseOid ? { reviewBaseOid: lease.reviewBaseOid } : {}),
    ...(lease.reviewBaseStrategy ? { reviewBaseStrategy: lease.reviewBaseStrategy } : {}),
    ...(lease.reviewLocalHeadOid ? { reviewLocalHeadOid: lease.reviewLocalHeadOid } : {}),
    ...(lease.previousReview ? { previousReview: lease.previousReview } : {}),
    followupOnly: lease.followupOnly === true,
    ...(lease.followupReason ? { followupReason: lease.followupReason } : {}),
    lease,
  }
}

export type PiForkResolvedTargetChoice =
  | Extract<SessionTargetBindChoice, { kind: 'inherit' | 'local' | 'isolated' }>
  | { kind: 'isolated-copy'; parentSessionId: string; expectedSourceRevision: number }

/** 将 Fork 意图收敛成明确的 bind 或 Isolated snapshot copy；不在调用方散落来源规则。 */
export function resolvePiForkTargetChoice(
  parentSessionId: string,
  requestedTarget: ForkSessionTargetChoice | undefined,
  sourceTarget: SessionTargetView,
): PiForkResolvedTargetChoice {
  if (!requestedTarget || requestedTarget.kind === 'inherit') {
    return { kind: 'inherit', parentSessionId }
  }
  if (requestedTarget.kind === 'local') {
    return { kind: 'local' }
  }
  if (requestedTarget.kind === 'isolated-copy') {
    if (sourceTarget.checkout.kind !== 'isolated') {
      throw new SessionCheckoutError(
        'operation_not_allowed',
        '复制当前 Worktree 仅支持从 Isolated Checkout 发起。',
      )
    }
    return {
      kind: 'isolated-copy',
      parentSessionId,
      expectedSourceRevision: sourceTarget.revision,
    }
  }
  if (sourceTarget.checkout.kind !== 'local') {
    throw new SessionCheckoutError(
      'operation_not_allowed',
      'Fork 到新 Worktree 仅支持从 Local Checkout 发起；Isolated 会话请复制当前 Worktree。',
    )
  }
  if (sourceTarget.dirty && !requestedTarget.confirmDirty) {
    throw new SessionCheckoutError(
      'dirty_confirmation_required',
      'Local Checkout 存在未提交修改；新 Worktree 将从已提交 HEAD 创建且不会复制这些修改。',
    )
  }
  return { kind: 'isolated' }
}

export interface AgentSessionTargetLaunchBinding {
  sessionId: string
  choice: SessionTargetBindChoice
}

/** 非交互 Pi 会话必须在启动前完成 Local 或父目标绑定。 */
export async function bindAgentSessionTargetForLaunch(
  input: AgentSessionTargetLaunchBinding,
  checkout: Pick<SessionCheckoutModule, 'bind'>,
): Promise<SessionTargetView> {
  return checkout.bind(input.sessionId, input.choice)
}

/** 生产调用的轻量入口。 */
export async function resolveProductionAgentSessionTarget(
  input: AgentSessionTargetInput,
): Promise<AgentSessionTarget> {
  const { getSessionCheckoutModule } = await import('./session-checkout/production.ts')
  return resolveAgentSessionTarget(input, {
    checkout: getSessionCheckoutModule(),
  })
}

/** 非交互生产创建点使用的统一绑定入口。 */
export async function bindProductionAgentSessionTargetForLaunch(
  input: AgentSessionTargetLaunchBinding,
): Promise<SessionTargetView> {
  const [{ getSessionCheckoutModule }, { updateAgentSessionMeta }] = await Promise.all([
    import('./session-checkout/production.ts'),
    import('./agent-session-manager.ts'),
  ])
  const target = await bindAgentSessionTargetForLaunch(input, getSessionCheckoutModule())
  updateAgentSessionMeta(input.sessionId, {
    sessionTarget: target.checkout.kind === 'local'
      ? { kind: 'local' }
      : { kind: 'isolated', checkoutId: target.checkout.id },
  })
  return target
}

/** Agent handoff 专用：最终 HEAD/dirty 校验与 Isolated 创建在同一 checkout binding lock 内完成。 */
export async function bindProductionVerifiedIsolatedTarget(
  sessionId: string,
  proof: VerifiedIsolatedBindProof,
): Promise<SessionTargetView> {
  const [{ getSessionCheckoutModule }, { updateAgentSessionMeta }] = await Promise.all([
    import('./session-checkout/production.ts'),
    import('./agent-session-manager.ts'),
  ])
  const target = await getSessionCheckoutModule().bindVerifiedIsolated(sessionId, proof)
  updateAgentSessionMeta(sessionId, {
    sessionTarget: { kind: 'isolated', checkoutId: target.checkout.id },
  })
  return target
}


/** 主进程文件访问调用方复用的目标根解析入口。 */
export async function resolveSessionTargetRoot(sessionId: string): Promise<string> {
  const { getAgentSessionMeta } = await import('./agent-session-manager.ts')
  if (!getAgentSessionMeta(sessionId)) throw new Error(`Agent 会话不存在: ${sessionId}`)
  const target = await resolveProductionAgentSessionTarget({ sessionId })
  return target.workspaceRoot
}

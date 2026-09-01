import type { SessionTargetView } from '@domi/shared'
import { SessionCheckoutError } from './index.ts'

export interface SessionCheckoutOperationGuardDependencies {
  listSessionIds(): string[]
  isSessionActive(sessionId: string): boolean
  inspect(sessionId: string): Promise<SessionTargetView>
  stopSession?(sessionId: string): void
}

export interface SessionCheckoutOperationGuardOptions {
  ownerHandoffTimeoutMs?: number
  ownerHandoffPollMs?: number
  stopTimeoutMs?: number
  sleep?: (milliseconds: number) => Promise<void>
}

const DEFAULT_OWNER_HANDOFF_TIMEOUT_MS = 1_500
const DEFAULT_OWNER_HANDOFF_POLL_MS = 25
const DEFAULT_STOP_TIMEOUT_MS = 5_000

function canAwaitOwnerHandoff(target: SessionTargetView): boolean {
  return target.checkout.kind === 'isolated' && (
    target.delivery?.state === 'ready_for_review'
    || target.delivery?.state === 'preview_active'
    || target.delivery?.state === 'preview_detached'
    || target.delivery?.state === 'finalized'
  )
}

/** 主进程运行态门禁：破坏性 checkout 动作不能与同一 target 的任何 Agent run 竞争。 */
export class SessionCheckoutOperationGuard {
  private readonly ownerHandoffTimeoutMs: number
  private readonly ownerHandoffPollMs: number
  private readonly stopTimeoutMs: number
  private readonly sleep: (milliseconds: number) => Promise<void>

  constructor(
    private readonly dependencies: SessionCheckoutOperationGuardDependencies,
    options: SessionCheckoutOperationGuardOptions = {},
  ) {
    this.ownerHandoffTimeoutMs = Math.max(0, options.ownerHandoffTimeoutMs ?? DEFAULT_OWNER_HANDOFF_TIMEOUT_MS)
    this.ownerHandoffPollMs = Math.max(1, options.ownerHandoffPollMs ?? DEFAULT_OWNER_HANDOFF_POLL_MS)
    this.stopTimeoutMs = Math.max(0, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  private async awaitTerminatingOwnerHandoff(sessionId: string): Promise<void> {
    const deadline = Date.now() + this.ownerHandoffTimeoutMs
    while (this.dependencies.isSessionActive(sessionId) && Date.now() < deadline) {
      await this.sleep(Math.min(this.ownerHandoffPollMs, Math.max(1, deadline - Date.now())))
    }
  }

  async getActiveSessionIds(sessionId: string): Promise<string[]> {
    const target = await this.dependencies.inspect(sessionId)
    const active: string[] = []
    for (const candidateId of this.dependencies.listSessionIds()) {
      if (!this.dependencies.isSessionActive(candidateId)) continue
      try {
        const candidate = await this.dependencies.inspect(candidateId)
        const sameTarget = target.checkout.kind === 'isolated'
          ? candidate.checkout.kind === 'isolated' && candidate.checkout.id === target.checkout.id
          : candidate.checkout.kind === 'local' && candidate.project.id === target.project.id
        if (sameTarget) active.push(candidateId)
      } catch {
        // 无法证明属于当前 Checkout/Local project 的 active 会话不能由此次确认静默停止。
      }
    }
    return active
  }

  /** 用户已在同一张放弃确认卡中授权：先停止列出的真实运行，再等待 idle。 */
  async stopAndAssertIdle(sessionId: string): Promise<void> {
    const active = await this.getActiveSessionIds(sessionId)
    if (active.length > 0 && !this.dependencies.stopSession) {
      throw new SessionCheckoutError('operation_not_allowed', 'Agent 仍在运行，但宿主停止通道不可用')
    }
    for (const activeSessionId of active) this.dependencies.stopSession?.(activeSessionId)
    const deadline = Date.now() + this.stopTimeoutMs
    while (active.some((activeSessionId) => this.dependencies.isSessionActive(activeSessionId)) && Date.now() < deadline) {
      await this.sleep(Math.min(this.ownerHandoffPollMs, Math.max(1, deadline - Date.now())))
    }
    if (active.some((activeSessionId) => this.dependencies.isSessionActive(activeSessionId))) {
      throw new SessionCheckoutError('operation_not_allowed', '相关 Agent 未能在限定时间内停止，未执行 Worktree 放弃')
    }
    await this.assertIdle(sessionId)
  }

  async assertIdle(sessionId: string, options: { awaitOwnerHandoff?: boolean } = {}): Promise<void> {
    let target = await this.dependencies.inspect(sessionId)
    if (this.dependencies.isSessionActive(sessionId)) {
      // ReadyForReview / Preview revision cards can become visible a few milliseconds before
      // their terminating Agent run releases the active slot. Briefly join that handoff so the
      // user's first click is not consumed by a transient operation_not_allowed response.
      if (options.awaitOwnerHandoff || canAwaitOwnerHandoff(target)) {
        await this.awaitTerminatingOwnerHandoff(sessionId)
      }
      if (this.dependencies.isSessionActive(sessionId)) {
        throw new SessionCheckoutError('operation_not_allowed', 'Agent 仍在运行或等待后台任务，不能操作 Checkout')
      }
      // The terminating run may have advanced delivery/revision while we waited.
      target = await this.dependencies.inspect(sessionId)
    }

    for (const candidateId of this.dependencies.listSessionIds()) {
      if (candidateId === sessionId || !this.dependencies.isSessionActive(candidateId)) continue
      let candidate: SessionTargetView
      try {
        candidate = await this.dependencies.inspect(candidateId)
      } catch {
        // 无法 inspect 的其它会话不证明它共享当前 checkout；其自身运行仍由自己的门禁保护。
        continue
      }
      const sharesTarget = target.checkout.kind === 'isolated'
        ? candidate.checkout.kind === 'isolated' && candidate.checkout.id === target.checkout.id
        : candidate.checkout.kind === 'local' && candidate.project.id === target.project.id
      if (sharesTarget) {
        throw new SessionCheckoutError(
          'operation_not_allowed',
          `${target.checkout.kind === 'isolated' ? 'Checkout' : 'Local'} 仍被运行中的关联会话使用: ${candidateId}`,
        )
      }
    }
  }
}

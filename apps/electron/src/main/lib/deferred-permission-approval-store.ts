import { readFileSync, writeFileSync } from 'node:fs'
import type {
  OperateSessionCheckoutInput,
  PermissionRequest,
  PermissionResponseResult,
  SessionCheckoutOperationResult,
  SessionTargetView,
  WorktreeApplyPreflightView,
} from '@domi/shared'
import type { PermissionResult } from './agent-permission-types.ts'
import { acceptBoundedProductInput } from './permission-request-factory.ts'

export interface DeferredWorktreeApprovalAdapter {
  inspect(sessionId: string): Promise<SessionTargetView>
  assertIdle(sessionId: string, options?: { awaitOwnerHandoff?: boolean }): Promise<void>
  preflight?(sessionId: string, expectedRevision: number): Promise<WorktreeApplyPreflightView>
  operate(input: OperateSessionCheckoutInput): Promise<SessionCheckoutOperationResult>
  captureLocalMaintenance?(sessionId: string): Promise<{
    checkoutId: string
    expectedRevision: number
    expectedWorktreeOid: string
    localHeadOid: string
    localBranch: string | null
    localStatusHash: string
    createdAt: number
  }>
  startLocalMaintenance?(sessionId: string, goal: string, snapshot: {
    checkoutId: string
    expectedRevision: number
    expectedWorktreeOid: string
    localHeadOid: string
    localBranch: string | null
    localStatusHash: string
    createdAt: number
  }): Promise<{ id: string }>
}

interface PersistedDeferredPermissions {
  version: 1
  requests: PermissionRequest[]
}

const DEFERRED_TOOLS = new Set(['ApplyWorktree', 'FinishWorktree', 'RequestLocalMaintenance'])

export class DeferredPermissionApprovalStore {
  private readonly pending = new Map<string, PermissionRequest>()
  private adapter: DeferredWorktreeApprovalAdapter | null = null

  constructor(private readonly persistencePath?: string) {
    this.load()
  }

  configure(adapter: DeferredWorktreeApprovalAdapter): void {
    this.adapter = adapter
  }

  canHandle(toolName: string): boolean {
    return Boolean(this.persistencePath && this.adapter && DEFERRED_TOOLS.has(toolName))
  }

  async request(
    request: PermissionRequest,
    sendToRenderer: (request: PermissionRequest) => void,
  ): Promise<PermissionResult> {
    const adapter = this.adapter
    if (!this.persistencePath || !adapter || !DEFERRED_TOOLS.has(request.toolName)) {
      return { behavior: 'deny', message: 'Deferred Worktree 确认执行器尚未就绪' }
    }

    if (request.toolName === 'RequestLocalMaintenance') {
      const goal = typeof request.toolInput.goal === 'string' ? request.toolInput.goal.trim() : ''
      if (!goal) return { behavior: 'deny', message: 'Local 维修目标不能为空' }
      if (!adapter.captureLocalMaintenance) return { behavior: 'deny', message: 'Local 维修执行器尚未就绪' }
      const snapshot = await adapter.captureLocalMaintenance(request.sessionId)
      const existing = [...this.pending.values()].find((candidate) => (
        candidate.sessionId === request.sessionId
        && candidate.toolName === request.toolName
        && candidate.deferred?.kind === 'local_maintenance'
        && candidate.deferred.checkoutId === snapshot.checkoutId
        && candidate.deferred.expectedRevision === snapshot.expectedRevision
        && candidate.deferred.localHeadOid === snapshot.localHeadOid
        && candidate.deferred.localStatusHash === snapshot.localStatusHash
      ))
      if (existing) {
        sendToRenderer(existing)
        return { behavior: 'deny', message: 'Local 维修事务已在等待用户确认；批准后 Domi 会自动续跑原任务。' }
      }
      request.deferred = { kind: 'local_maintenance', ...snapshot }
      this.pending.set(request.requestId, request)
      this.persist()
      sendToRenderer(request)
      return { behavior: 'deny', message: '已创建非阻塞 Local 维修确认卡；批准后 Domi 会自动续跑并开放受控 Local 工具。' }
    }

    const target = await adapter.inspect(request.sessionId)
    if (target.checkout.kind !== 'isolated' || target.ownership !== 'owner') {
      return { behavior: 'deny', message: '当前会话不能创建 Worktree 交付确认' }
    }
    if (request.toolName === 'ApplyWorktree'
      && target.delivery?.state === 'ready_for_review'
      && adapter.preflight) {
      let preflight: WorktreeApplyPreflightView
      try {
        preflight = await adapter.preflight(request.sessionId, target.revision)
      } catch (error) {
        return {
          behavior: 'deny',
          message: `Apply 只读预检失败，未创建 Local 写入确认：${error instanceof Error ? error.message : String(error)}`,
        }
      }
      if (preflight.status === 'conflict') {
        const visibleFiles = preflight.conflictingFiles.slice(0, 20)
        const remaining = preflight.conflictingFiles.length - visibleFiles.length
        return {
          behavior: 'deny',
          message: [
            'Apply 只读预检已检测到真实冲突，Local 未修改，也未创建无效的 Local 写入确认。',
            `localHeadOid: ${preflight.localHeadOid}`,
            `conflictingFiles: ${visibleFiles.join('、')}${remaining > 0 ? `（另有 ${remaining} 个）` : ''}`,
            '请立即在当前 managed Worktree 中基于该 Local HEAD 解决冲突并验证；禁止直接修改 Local。完成后重新调用 ReadyForReview，生成基于新 Worktree 快照的新的验收卡；不要再次调用 ApplyWorktree，也不要调用 FinishWorktree。',
          ].join('\n'),
        }
      }
      if (preflight.status === 'blocked') {
        return { behavior: 'deny', message: `Apply 只读预检暂时阻塞，未创建 Local 写入确认：${preflight.message}` }
      }
    }

    const existing = [...this.pending.values()].find((candidate) => (
      candidate.sessionId === request.sessionId
      && candidate.toolName === request.toolName
      && candidate.deferred?.kind === 'worktree'
      && candidate.deferred.checkoutId === target.checkout.id
      && candidate.deferred.expectedRevision === target.revision
      && candidate.deferred.expectedCurrentOid === target.current.oid
    ))
    if (existing) {
      sendToRenderer(existing)
      return { behavior: 'deny', message: '该 Worktree 操作已在等待用户确认；Agent 可继续其他工作或正常结束本轮。' }
    }
    request.deferred = {
      kind: 'worktree',
      checkoutId: target.checkout.id,
      expectedRevision: target.revision,
      expectedCurrentOid: target.current.oid,
      createdAt: Date.now(),
    }
    this.pending.set(request.requestId, request)
    this.persist()
    sendToRenderer(request)
    return { behavior: 'deny', message: '已创建非阻塞确认卡；用户稍后批准后 Domi 会基于当前快照执行，Agent 无需等待。' }
  }

  async respond(
    requestId: string,
    behavior: 'allow' | 'deny',
    updatedInput?: Record<string, unknown>,
  ): Promise<PermissionResponseResult | undefined> {
    const request = this.pending.get(requestId)
    if (!request) return undefined
    if (behavior === 'deny') {
      this.pending.delete(requestId)
      this.persist()
      return { ok: true, sessionId: request.sessionId, consumed: true }
    }
    const result = request.deferred?.kind === 'local_maintenance'
      ? await this.executeLocalMaintenance(request)
      : await this.executeWorktree(request, updatedInput)
    if (result.consumed !== false) {
      this.pending.delete(requestId)
      this.persist()
    }
    return result
  }

  removeSession(sessionId: string): void {
    let changed = false
    for (const [requestId, request] of this.pending) {
      if (request.sessionId !== sessionId) continue
      this.pending.delete(requestId)
      changed = true
    }
    if (changed) this.persist()
  }

  requests(): PermissionRequest[] {
    return [...this.pending.values()]
  }

  private async executeLocalMaintenance(request: PermissionRequest): Promise<PermissionResponseResult> {
    const snapshot = request.deferred
    const adapter = this.adapter
    if (!snapshot || snapshot.kind !== 'local_maintenance' || !adapter?.startLocalMaintenance) {
      return { ok: false, sessionId: request.sessionId, message: 'Local 维修确认执行器尚未就绪，请重新发起' }
    }
    try {
      await adapter.assertIdle(request.sessionId, { awaitOwnerHandoff: true })
    } catch (error) {
      return {
        ok: false,
        sessionId: request.sessionId,
        consumed: false,
        message: `${error instanceof Error ? error.message : String(error)}；本次确认仍保留，请等待当前 Agent 结束后重试。`,
      }
    }
    try {
      const goal = typeof request.toolInput.goal === 'string' ? request.toolInput.goal.trim() : ''
      const transaction = await adapter.startLocalMaintenance(request.sessionId, goal, snapshot)
      return {
        ok: true,
        sessionId: request.sessionId,
        consumed: true,
        message: 'Local 维修事务已开启；Domi 正在自动续跑原任务。',
        continuation: {
          kind: 'local_maintenance', requestId: request.requestId, transactionId: transaction.id, goal,
        },
      }
    } catch (error) {
      return {
        ok: false, sessionId: request.sessionId, consumed: true,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async executeWorktree(
    request: PermissionRequest,
    updatedInput?: Record<string, unknown>,
  ): Promise<PermissionResponseResult> {
    const snapshot = request.deferred
    const adapter = this.adapter
    if (!snapshot || snapshot.kind !== 'worktree' || !adapter) {
      return { ok: false, sessionId: request.sessionId, message: 'Worktree 确认执行器尚未就绪，请刷新后重新发起' }
    }
    try {
      await adapter.assertIdle(request.sessionId)
      const target = await adapter.inspect(request.sessionId)
      if (target.checkout.kind !== 'isolated'
        || target.ownership !== 'owner'
        || target.checkout.id !== snapshot.checkoutId
        || target.revision !== snapshot.expectedRevision
        || target.current.oid !== snapshot.expectedCurrentOid) {
        return {
          ok: false, sessionId: request.sessionId,
          message: 'Worktree revision、HEAD 或身份已变化，旧确认已失效；请基于最新状态重新确认',
        }
      }
      const acceptedInput = acceptBoundedProductInput(request, 'allow', updatedInput)
      const operation: OperateSessionCheckoutInput = request.toolName === 'FinishWorktree'
        ? {
            action: 'finish', sessionId: request.sessionId, expectedRevision: snapshot.expectedRevision,
            commitMessage: typeof acceptedInput.commitMessage === 'string' ? acceptedInput.commitMessage : '',
            retention: acceptedInput.retention === 'retain_24h'
              || acceptedInput.retention === 'retain_3d'
              || acceptedInput.retention === 'retain_manual'
              ? acceptedInput.retention : 'cleanup',
          }
        : { action: 'apply', sessionId: request.sessionId, expectedRevision: snapshot.expectedRevision }
      const result = await adapter.operate(operation)
      if (result.status === 'error') return { ok: false, sessionId: request.sessionId, message: result.message }
      if (result.status === 'conflict') {
        return {
          ok: true, sessionId: request.sessionId, consumed: true,
          message: 'Apply 检测到真实冲突，Local 未修改；Domi 正在让原 Agent 自动继续解决冲突。',
          continuation: {
            kind: 'worktree_apply_conflict', requestId: request.requestId,
            checkoutId: result.target.checkout.id, revision: result.target.revision,
            localHeadOid: result.localHeadOid, conflictingFiles: result.conflictingFiles.slice(0, 500),
          },
        }
      }
      return { ok: true, sessionId: request.sessionId }
    } catch (error) {
      return {
        ok: false, sessionId: request.sessionId,
        message: error instanceof Error ? error.message : 'Worktree 操作执行失败',
      }
    }
  }

  private load(): void {
    if (!this.persistencePath) return
    try {
      const parsed = JSON.parse(readFileSync(this.persistencePath, 'utf8')) as Partial<PersistedDeferredPermissions>
      if (parsed.version !== 1 || !Array.isArray(parsed.requests)) return
      for (const request of parsed.requests) {
        if (!request
          || typeof request.requestId !== 'string'
          || typeof request.sessionId !== 'string'
          || !DEFERRED_TOOLS.has(request.toolName)
          || (request.deferred?.kind !== 'worktree' && request.deferred?.kind !== 'local_maintenance')) continue
        this.pending.set(request.requestId, request)
      }
    } catch {
      // 文件不存在或损坏时 fail closed：不猜测恢复任何 Local 写入授权。
    }
  }

  private persist(): void {
    if (!this.persistencePath) return
    const payload: PersistedDeferredPermissions = { version: 1, requests: [...this.pending.values()] }
    try {
      writeFileSync(this.persistencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } catch (error) {
      console.error('[DeferredPermissionApprovalStore] 持久化 Worktree 待确认动作失败:', error)
    }
  }
}

/**
 * Pi 权限交互门面。
 *
 * 最终授权分类只由 PiExecutionController + ExecutionPolicy 完成；本门面不解析命令、
 * 不维护 allow-always 白名单，只负责把已经作出的宿主决策转换为阻塞审批、
 * deferred Local/Worktree transaction 或兼容的 session capability approval。
 */

import type {
  GitPushSessionTrustView,
  PermissionRequest,
  PermissionResponseResult,
} from '@domi/shared'
import { getPendingWorktreeApprovalsPath } from './config-paths.ts'
import { BlockingPermissionApprovalStore } from './blocking-permission-approval-store.ts'
import {
  DeferredPermissionApprovalStore,
  type DeferredWorktreeApprovalAdapter,
} from './deferred-permission-approval-store.ts'
import { buildPermissionRequest } from './permission-request-factory.ts'
import { SessionCapabilityApprovalService } from './session-capability-approval-service.ts'
import {
  gitPushSessionTrustService,
  type GitPushSessionTrustProposal,
  type GitPushSessionTrustService,
} from './execution-policy/git-push-session-trust.ts'
import type {
  CanUseToolOptions,
  PermissionResult,
  PermissionUpdate,
} from './agent-permission-types.ts'

export type { CanUseToolOptions, PermissionResult, PermissionUpdate } from './agent-permission-types.ts'
export type { DeferredWorktreeApprovalAdapter } from './deferred-permission-approval-store.ts'

/**
 * 宿主权限交互 facade。职责保持刻意狭窄：
 * - blocking single approval；
 * - deferred Worktree / Local transaction；
 * - legacy process-local session capability compatibility。
 */
export class AgentPermissionService {
  private readonly blocking = new BlockingPermissionApprovalStore()
  private readonly deferred: DeferredPermissionApprovalStore
  private readonly capabilities: SessionCapabilityApprovalService

  constructor(
    persistencePath?: string,
    gitPushTrust: Pick<GitPushSessionTrustService, 'grant' | 'list' | 'revoke' | 'clear'> = gitPushSessionTrustService,
  ) {
    this.deferred = new DeferredPermissionApprovalStore(persistencePath)
    this.capabilities = new SessionCapabilityApprovalService(this.blocking, gitPushTrust)
  }

  configureDeferredWorktreeApprovals(adapter: DeferredWorktreeApprovalAdapter): void {
    this.deferred.configure(adapter)
  }

  /**
   * 为 Execution Policy 或宿主产品事务创建不可白名单化的单次确认。
   */
  async requestSingleApproval(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
    sendToRenderer: (request: PermissionRequest) => void,
  ): Promise<PermissionResult> {
    const request = buildPermissionRequest(sessionId, toolName, input, options, {
      dangerLevel: 'dangerous', allowAlways: false,
    })
    if (this.deferred.canHandle(toolName)) {
      return this.deferred.request(request, sendToRenderer)
    }
    sendToRenderer(request)
    return this.blocking.wait(request, options.signal)
  }

  /** 兼容旧 host push capability；新 Full Access Agent run 不再暴露对应工具。 */
  requestGitPushSessionTrustApproval(
    sessionId: string,
    proposal: GitPushSessionTrustProposal,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
    sendToRenderer: (request: PermissionRequest) => void,
  ): Promise<PermissionResult> {
    return this.capabilities.requestGitPushApproval(sessionId, proposal, input, options, sendToRenderer)
  }

  listSessionCapabilityGrants(sessionId: string): GitPushSessionTrustView[] {
    return this.capabilities.list(sessionId)
  }

  revokeSessionCapabilityGrant(sessionId: string, grantId: string): boolean {
    return this.capabilities.revoke(sessionId, grantId)
  }

  async respondToPermission(
    requestId: string,
    behavior: 'allow' | 'deny',
    _alwaysAllow: boolean,
    updatedInput?: Record<string, unknown>,
  ): Promise<PermissionResponseResult> {
    const deferred = await this.deferred.respond(requestId, behavior, updatedInput)
    if (deferred) return deferred
    const blocking = await this.blocking.respond(requestId, behavior, updatedInput)
    return blocking ?? { ok: false, message: '确认请求已失效或已处理' }
  }

  /** 清理会阻塞当前 SDK tool call 的请求；deferred intent 刻意保留。 */
  clearSessionPending(sessionId: string): void {
    this.blocking.clearSession(sessionId)
  }

  removeSessionDeferred(sessionId: string): void {
    this.deferred.removeSession(sessionId)
  }

  getPendingRequests(): PermissionRequest[] {
    return [...this.blocking.requests(), ...this.deferred.requests()]
  }

  hasBlockingRequest(sessionId: string): boolean {
    return this.blocking.requests().some((request) => request.sessionId === sessionId)
  }

  clearSessionCapabilities(sessionId: string): void {
    this.capabilities.clear(sessionId)
  }
}

/** 全局权限服务实例 */
export const permissionService = new AgentPermissionService(getPendingWorktreeApprovalsPath())

import type { GitPushSessionTrustView, PermissionRequest } from '@domi/shared'
import type { CanUseToolOptions, PermissionResult } from './agent-permission-types.ts'
import { BlockingPermissionApprovalStore } from './blocking-permission-approval-store.ts'
import { buildPermissionRequest } from './permission-request-factory.ts'
import {
  gitPushSessionTrustService,
  type GitPushSessionTrustProposal,
  type GitPushSessionTrustService,
} from './execution-policy/git-push-session-trust.ts'

export class SessionCapabilityApprovalService {
  constructor(
    private readonly blocking: BlockingPermissionApprovalStore,
    private readonly trust: Pick<GitPushSessionTrustService, 'grant' | 'list' | 'revoke' | 'clear'> = gitPushSessionTrustService,
  ) {}

  requestGitPushApproval(
    sessionId: string,
    proposal: GitPushSessionTrustProposal,
    input: Record<string, unknown>,
    options: CanUseToolOptions,
    sendToRenderer: (request: PermissionRequest) => void,
  ): Promise<PermissionResult> {
    const request = buildPermissionRequest(sessionId, 'RequestGitPushSessionTrust', input, options, {
      dangerLevel: 'dangerous', allowAlways: false, sessionCapability: proposal.view,
    })
    sendToRenderer(request)
    return this.blocking.wait(request, options.signal, async () => {
      await this.trust.grant(proposal)
    })
  }

  list(sessionId: string): GitPushSessionTrustView[] {
    return this.trust.list(sessionId)
  }

  revoke(sessionId: string, grantId: string): boolean {
    return this.trust.revoke(sessionId, grantId)
  }

  clear(sessionId: string): void {
    this.trust.clear(sessionId)
  }
}

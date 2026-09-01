import type { PermissionRequest, PermissionResponseResult } from '@domi/shared'
import type { PermissionResult } from './agent-permission-types.ts'
import { acceptBoundedProductInput } from './permission-request-factory.ts'

interface PendingPermission {
  resolve: (result: PermissionResult) => void
  request: PermissionRequest
  onApprove?: () => Promise<void>
}

export class BlockingPermissionApprovalStore {
  private readonly pending = new Map<string, PendingPermission>()

  wait(
    request: PermissionRequest,
    signal: AbortSignal,
    onApprove?: () => Promise<void>,
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(request.requestId, { resolve, request, ...(onApprove && { onApprove }) })
      signal.addEventListener('abort', () => {
        if (!this.pending.has(request.requestId)) return
        this.pending.delete(request.requestId)
        resolve({ behavior: 'deny', message: '操作已中止' })
      }, { once: true })
    })
  }

  async respond(
    requestId: string,
    behavior: 'allow' | 'deny',
    updatedInput?: Record<string, unknown>,
  ): Promise<PermissionResponseResult | undefined> {
    const pending = this.pending.get(requestId)
    if (!pending) return undefined
    const sessionId = pending.request.sessionId

    if (behavior === 'allow' && pending.onApprove) {
      try {
        await pending.onApprove()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        pending.resolve({ behavior: 'deny', message })
        this.pending.delete(requestId)
        return { ok: false, sessionId, consumed: true, message }
      }
    }

    const acceptedInput = acceptBoundedProductInput(pending.request, behavior, updatedInput)
    pending.resolve(behavior === 'allow'
      ? { behavior: 'allow', updatedInput: acceptedInput }
      : { behavior: 'deny', message: '用户拒绝了此操作' })
    this.pending.delete(requestId)
    return { ok: true, sessionId }
  }

  clearSession(sessionId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.request.sessionId !== sessionId) continue
      pending.resolve({ behavior: 'deny', message: '会话已结束' })
      this.pending.delete(requestId)
    }
  }

  requests(): PermissionRequest[] {
    return [...this.pending.values()].map((pending) => pending.request)
  }
}

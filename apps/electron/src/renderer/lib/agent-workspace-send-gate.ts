export interface AgentWorkspaceSendState {
  hasSnapshot: boolean
  loading: boolean
  errorMessage?: string | null
}

export type DeferredWorkspaceSendResolution = 'wait' | 'send' | 'fail'

export function shouldDeferWorkspaceSend(state: AgentWorkspaceSendState): boolean {
  return !state.hasSnapshot && state.loading
}

export function resolveDeferredWorkspaceSend(state: AgentWorkspaceSendState): DeferredWorkspaceSendResolution {
  if (shouldDeferWorkspaceSend(state)) return 'wait'
  if (!state.hasSnapshot && state.errorMessage) return 'fail'
  return 'send'
}

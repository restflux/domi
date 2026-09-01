import type {
  PiExtensionCandidatePreview,
  PiExtensionTrustEntry,
} from '@domi/shared'

export interface ExtensionTrustViewState {
  workspaceId: string
  extensions: PiExtensionTrustEntry[]
  candidate: PiExtensionCandidatePreview | null
  confirmed: boolean
  busy: boolean
  error: string | null
  operationId: number
}

export type ExtensionTrustViewAction =
  | { type: 'reset'; operationId: number }
  | { type: 'started'; operationId: number }
  | { type: 'confirmationChanged'; confirmed: boolean }
  | { type: 'candidateSelected'; operationId: number; candidate: PiExtensionCandidatePreview | null }
  | { type: 'listSucceeded'; operationId: number; extensions: PiExtensionTrustEntry[] }
  | { type: 'approveSucceeded'; operationId: number; extensions: PiExtensionTrustEntry[] }
  | { type: 'failed'; operationId: number; error: string }

export function createExtensionTrustViewState(workspaceId: string): ExtensionTrustViewState {
  return {
    workspaceId,
    extensions: [],
    candidate: null,
    confirmed: false,
    busy: false,
    error: null,
    operationId: 0,
  }
}

function isExpiredOperation(
  state: ExtensionTrustViewState,
  action: ExtensionTrustViewAction,
): boolean {
  return action.type !== 'reset'
    && action.type !== 'started'
    && action.type !== 'confirmationChanged'
    && action.operationId !== state.operationId
}

export function reduceExtensionTrustView(
  state: ExtensionTrustViewState,
  action: ExtensionTrustViewAction,
): ExtensionTrustViewState {
  if (isExpiredOperation(state, action)) return state

  switch (action.type) {
    case 'reset':
      return { ...createExtensionTrustViewState(state.workspaceId), operationId: action.operationId }
    case 'started':
      return { ...state, operationId: action.operationId, busy: true, error: null }
    case 'confirmationChanged':
      return { ...state, confirmed: action.confirmed }
    case 'candidateSelected':
      return {
        ...state,
        candidate: action.candidate,
        confirmed: false,
        busy: false,
        error: null,
      }
    case 'listSucceeded':
      return { ...state, extensions: action.extensions, busy: false, error: null }
    case 'approveSucceeded':
      return {
        ...state,
        extensions: action.extensions,
        candidate: null,
        confirmed: false,
        busy: false,
        error: null,
      }
    case 'failed':
      return { ...state, busy: false, error: action.error }
  }
}

export function formatPiExtensionTrustError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'Extension Trust 操作失败'
}

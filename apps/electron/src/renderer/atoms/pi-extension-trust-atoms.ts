import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { PiExtensionCandidateKind } from '@domi/shared'
import {
  createExtensionTrustViewState,
  formatPiExtensionTrustError,
  reduceExtensionTrustView,
} from '../lib/pi-extension-trust-view-model.ts'

export const piExtensionTrustStateAtomFamily = atomFamily((workspaceId: string) =>
  atom(createExtensionTrustViewState(workspaceId)),
)

export const resetPiExtensionTrustAtomFamily = atomFamily((workspaceId: string) => {
  const stateAtom = piExtensionTrustStateAtomFamily(workspaceId)
  return atom(null, (get, set): void => {
    const operationId = get(stateAtom).operationId + 1
    set(stateAtom, (state) => reduceExtensionTrustView(state, { type: 'reset', operationId }))
  })
})

export const piExtensionTrustConfirmedAtomFamily = atomFamily((workspaceId: string) => {
  const stateAtom = piExtensionTrustStateAtomFamily(workspaceId)
  return atom(
    (get) => get(stateAtom).confirmed,
    (_get, set, confirmed: boolean) => {
      set(stateAtom, (state) => reduceExtensionTrustView(state, {
        type: 'confirmationChanged',
        confirmed,
      }))
    },
  )
})

export const refreshPiExtensionTrustAtomFamily = atomFamily((workspaceId: string) => {
  const stateAtom = piExtensionTrustStateAtomFamily(workspaceId)
  return atom(null, async (get, set): Promise<void> => {
    const operationId = get(stateAtom).operationId + 1
    set(stateAtom, (state) => reduceExtensionTrustView(state, { type: 'started', operationId }))
    try {
      const extensions = await window.electronAPI.piExtensionTrust.list({ workspaceId })
      set(stateAtom, (state) => reduceExtensionTrustView(state, {
        type: 'listSucceeded',
        operationId,
        extensions,
      }))
    } catch (error) {
      set(stateAtom, (state) => reduceExtensionTrustView(state, {
        type: 'failed',
        operationId,
        error: formatPiExtensionTrustError(error),
      }))
    }
  })
})

export const pickPiExtensionCandidateAtomFamily = atomFamily((workspaceId: string) => {
  const stateAtom = piExtensionTrustStateAtomFamily(workspaceId)
  return atom(null, async (get, set, kind: PiExtensionCandidateKind): Promise<void> => {
    const operationId = get(stateAtom).operationId + 1
    set(stateAtom, (state) => reduceExtensionTrustView(state, { type: 'started', operationId }))
    try {
      const candidate = await window.electronAPI.piExtensionTrust.pickCandidate({ workspaceId, kind })
      set(stateAtom, (state) => reduceExtensionTrustView(state, {
        type: 'candidateSelected',
        operationId,
        candidate,
      }))
    } catch (error) {
      set(stateAtom, (state) => reduceExtensionTrustView(state, {
        type: 'failed',
        operationId,
        error: formatPiExtensionTrustError(error),
      }))
    }
  })
})

export const approvePiExtensionCandidateAtomFamily = atomFamily((workspaceId: string) => {
  const stateAtom = piExtensionTrustStateAtomFamily(workspaceId)
  return atom(null, async (get, set): Promise<void> => {
    const current = get(stateAtom)
    if (!current.candidate || !current.confirmed) return

    const operationId = current.operationId + 1
    const candidateToken = current.candidate.candidateToken
    set(stateAtom, (state) => reduceExtensionTrustView(state, { type: 'started', operationId }))
    try {
      await window.electronAPI.piExtensionTrust.approve({ workspaceId, candidateToken })
      const extensions = await window.electronAPI.piExtensionTrust.list({ workspaceId })
      set(stateAtom, (state) => reduceExtensionTrustView(state, {
        type: 'approveSucceeded',
        operationId,
        extensions,
      }))
    } catch (error) {
      set(stateAtom, (state) => reduceExtensionTrustView(state, {
        type: 'failed',
        operationId,
        error: formatPiExtensionTrustError(error),
      }))
    }
  })
})

export const revokePiExtensionTrustAtomFamily = atomFamily((workspaceId: string) => {
  const stateAtom = piExtensionTrustStateAtomFamily(workspaceId)
  return atom(null, async (get, set, extensionId: string): Promise<void> => {
    const operationId = get(stateAtom).operationId + 1
    set(stateAtom, (state) => reduceExtensionTrustView(state, { type: 'started', operationId }))
    try {
      await window.electronAPI.piExtensionTrust.revoke({ workspaceId, extensionId })
      const extensions = await window.electronAPI.piExtensionTrust.list({ workspaceId })
      set(stateAtom, (state) => reduceExtensionTrustView(state, {
        type: 'listSucceeded',
        operationId,
        extensions,
      }))
    } catch (error) {
      set(stateAtom, (state) => reduceExtensionTrustView(state, {
        type: 'failed',
        operationId,
        error: formatPiExtensionTrustError(error),
      }))
    }
  })
})

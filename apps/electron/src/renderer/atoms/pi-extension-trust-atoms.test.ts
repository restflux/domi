import { afterEach, describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type {
  PiExtensionCandidatePreview,
  PiExtensionTrustApi,
  PiExtensionTrustEntry,
} from '@domi/shared'
import {
  approvePiExtensionCandidateAtomFamily,
  piExtensionTrustConfirmedAtomFamily,
  piExtensionTrustStateAtomFamily,
  pickPiExtensionCandidateAtomFamily,
  refreshPiExtensionTrustAtomFamily,
  resetPiExtensionTrustAtomFamily,
  revokePiExtensionTrustAtomFamily,
} from './pi-extension-trust-atoms.ts'

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')

const candidate: PiExtensionCandidatePreview = {
  candidateToken: 'opaque-token',
  path: 'C:\\extensions\\sample.ts',
  digest: `sha256:${'a'.repeat(64)}`,
  kind: 'file',
}

const validExtension: PiExtensionTrustEntry = {
  extensionId: 'extension-id',
  path: candidate.path,
  digest: candidate.digest,
  approvedAt: '2026-08-01T00:00:00.000Z',
  status: 'valid',
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  }
}

function installApi(overrides: Partial<PiExtensionTrustApi> = {}): PiExtensionTrustApi {
  const api: PiExtensionTrustApi = {
    pickCandidate: async () => null,
    list: async () => [],
    approve: async () => validExtension,
    revoke: async () => undefined,
    ...overrides,
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { electronAPI: { piExtensionTrust: api } },
  })
  return api
}

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'window')
  }
})

describe('Pi Extension Trust atoms', () => {
  test('Given two workspaces When an older workspace refresh finishes last Then their view states stay isolated', async () => {
    const workspaceAResult = deferred<PiExtensionTrustEntry[]>()
    installApi({
      list: async ({ workspaceId }) => workspaceId === 'workspace-a'
        ? workspaceAResult.promise
        : [{ ...validExtension, extensionId: 'workspace-b-extension' }],
    })
    const store = createStore()

    const refreshingA = store.set(refreshPiExtensionTrustAtomFamily('workspace-a'))
    store.set(resetPiExtensionTrustAtomFamily('workspace-a'))
    await store.set(refreshPiExtensionTrustAtomFamily('workspace-b'))
    workspaceAResult.resolve([validExtension])
    await refreshingA

    expect(store.get(piExtensionTrustStateAtomFamily('workspace-a')).extensions).toEqual([])
    expect(store.get(piExtensionTrustStateAtomFamily('workspace-b')).extensions)
      .toEqual([{ ...validExtension, extensionId: 'workspace-b-extension' }])
  })

  test('Given two refreshes for one workspace When the older request finishes last Then it cannot overwrite the current result', async () => {
    const oldResult = deferred<PiExtensionTrustEntry[]>()
    let callCount = 0
    installApi({
      list: async () => {
        callCount += 1
        return callCount === 1
          ? oldResult.promise
          : [{ ...validExtension, extensionId: 'current-extension' }]
      },
    })
    const store = createStore()

    const olderRefresh = store.set(refreshPiExtensionTrustAtomFamily('workspace-a'))
    await store.set(refreshPiExtensionTrustAtomFamily('workspace-a'))
    oldResult.resolve([{ ...validExtension, extensionId: 'expired-extension' }])
    await olderRefresh

    expect(store.get(piExtensionTrustStateAtomFamily('workspace-a')).extensions)
      .toEqual([{ ...validExtension, extensionId: 'current-extension' }])
    expect(store.get(piExtensionTrustStateAtomFamily('workspace-a')).busy).toBe(false)
  })

  test('Given a picked candidate When selection completes Then it is not implicitly approved', async () => {
    let approveCalls = 0
    installApi({
      pickCandidate: async () => candidate,
      approve: async () => {
        approveCalls += 1
        return validExtension
      },
    })
    const store = createStore()

    await store.set(pickPiExtensionCandidateAtomFamily('workspace-a'), 'file')

    expect(store.get(piExtensionTrustStateAtomFamily('workspace-a')).candidate).toEqual(candidate)
    expect(store.get(piExtensionTrustStateAtomFamily('workspace-a')).confirmed).toBe(false)
    expect(store.get(piExtensionTrustStateAtomFamily('workspace-b')).candidate).toBeNull()
    expect(approveCalls).toBe(0)
  })

  test('Given a stale authorization When refreshed Then it remains visible but no approval or revoke continues automatically', async () => {
    let mutations = 0
    const staleExtension: PiExtensionTrustEntry = { ...validExtension, status: 'stale' }
    installApi({
      list: async () => [staleExtension],
      approve: async () => {
        mutations += 1
        return validExtension
      },
      revoke: async () => {
        mutations += 1
      },
    })
    const store = createStore()

    await store.set(refreshPiExtensionTrustAtomFamily('workspace-a'))

    expect(store.get(piExtensionTrustStateAtomFamily('workspace-a')).extensions).toEqual([staleExtension])
    expect(store.get(piExtensionTrustStateAtomFamily('workspace-a')).busy).toBe(false)
    expect(mutations).toBe(0)
  })

  test('Given explicit confirmation When approve and revoke complete Then each list is reloaded from the main process', async () => {
    let extensions: PiExtensionTrustEntry[] = []
    const approvedTokens: string[] = []
    const revokedIds: string[] = []
    installApi({
      pickCandidate: async () => candidate,
      list: async () => extensions,
      approve: async ({ candidateToken }) => {
        approvedTokens.push(candidateToken)
        extensions = [validExtension]
        return validExtension
      },
      revoke: async ({ extensionId }) => {
        revokedIds.push(extensionId)
        extensions = []
      },
    })
    const store = createStore()

    await store.set(pickPiExtensionCandidateAtomFamily('workspace-a'), 'file')
    store.set(piExtensionTrustConfirmedAtomFamily('workspace-a'), true)
    await store.set(approvePiExtensionCandidateAtomFamily('workspace-a'))

    expect(approvedTokens).toEqual(['opaque-token'])
    expect(store.get(piExtensionTrustStateAtomFamily('workspace-a'))).toEqual(expect.objectContaining({
      extensions: [validExtension],
      candidate: null,
      confirmed: false,
      error: null,
    }))

    await store.set(revokePiExtensionTrustAtomFamily('workspace-a'), validExtension.extensionId)

    expect(revokedIds).toEqual(['extension-id'])
    expect(store.get(piExtensionTrustStateAtomFamily('workspace-a')).extensions).toEqual([])
  })

  test('Given an approve IPC failure When approval settles Then loading stops and the error is visible', async () => {
    installApi({
      pickCandidate: async () => candidate,
      approve: async () => {
        throw new Error('候选 token 已过期')
      },
    })
    const store = createStore()

    await store.set(pickPiExtensionCandidateAtomFamily('workspace-a'), 'file')
    store.set(piExtensionTrustConfirmedAtomFamily('workspace-a'), true)
    await store.set(approvePiExtensionCandidateAtomFamily('workspace-a'))

    expect(store.get(piExtensionTrustStateAtomFamily('workspace-a'))).toEqual(expect.objectContaining({
      busy: false,
      error: '候选 token 已过期',
      candidate,
      confirmed: true,
    }))
  })
})

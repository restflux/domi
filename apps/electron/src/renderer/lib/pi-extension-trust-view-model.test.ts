import { describe, expect, test } from 'bun:test'
import {
  createExtensionTrustViewState,
  reduceExtensionTrustView,
} from './pi-extension-trust-view-model.ts'

const candidate = {
  candidateToken: 'opaque',
  path: 'C:\\extensions\\sample.ts',
  digest: `sha256:${'a'.repeat(64)}`,
  kind: 'file' as const,
}

const staleExtension = {
  extensionId: 'extension-id',
  path: 'C:\\extensions\\sample.ts',
  digest: `sha256:${'b'.repeat(64)}`,
  approvedAt: '2026-08-01T00:00:00.000Z',
  status: 'stale' as const,
}

describe('Pi Extension Trust view model', () => {
  test('Given a newer operation When an expired result arrives Then current state remains unchanged', () => {
    const current = reduceExtensionTrustView(createExtensionTrustViewState('workspace-a'), {
      type: 'started',
      operationId: 2,
    })

    expect(reduceExtensionTrustView(current, {
      type: 'listSucceeded',
      operationId: 1,
      extensions: [staleExtension],
    })).toBe(current)
  })

  test('Given stale 授权 When refresh succeeds Then 保留 stale 状态且不产生可继续加载动作', () => {
    const loading = reduceExtensionTrustView(createExtensionTrustViewState('workspace-a'), {
      type: 'started',
      operationId: 1,
    })
    const state = reduceExtensionTrustView(loading, {
      type: 'listSucceeded',
      operationId: 1,
      extensions: [staleExtension],
    })

    expect(state.extensions).toEqual([staleExtension])
    expect(state.extensions[0]?.status).toBe('stale')
    expect(state.busy).toBe(false)
  })

  test('Given approve 成功 When reducer 更新 Then 清除候选与确认并刷新授权列表', () => {
    const selecting = reduceExtensionTrustView(createExtensionTrustViewState('workspace-a'), {
      type: 'candidateSelected',
      operationId: 0,
      candidate,
    })
    const confirmed = reduceExtensionTrustView(selecting, {
      type: 'confirmationChanged',
      confirmed: true,
    })
    const loading = reduceExtensionTrustView(confirmed, { type: 'started', operationId: 1 })

    const approved = reduceExtensionTrustView(loading, {
      type: 'approveSucceeded',
      operationId: 1,
      extensions: [{ ...staleExtension, status: 'valid' }],
    })

    expect(approved.candidate).toBeNull()
    expect(approved.confirmed).toBe(false)
    expect(approved.extensions[0]?.status).toBe('valid')
  })

  test('Given 操作失败 When reducer 更新 Then 停止 loading 并暴露错误', () => {
    const loading = reduceExtensionTrustView(createExtensionTrustViewState('workspace-a'), {
      type: 'started',
      operationId: 1,
    })

    expect(reduceExtensionTrustView(loading, {
      type: 'failed',
      operationId: 1,
      error: 'store 损坏',
    })).toEqual(expect.objectContaining({ busy: false, error: 'store 损坏' }))
  })
})

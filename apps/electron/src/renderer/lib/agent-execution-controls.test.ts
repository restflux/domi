import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@domi/shared'
import {
  buildAgentSendControlOverrides,
  buildAgentWorkflowUpdate,
  formatExecutionControlsError,
  getExecutionIsolationIndicator,
  resolveAgentExecutionControls,
  updateTemporaryExecutionRunTokens,
} from './agent-execution-controls.ts'

function session(overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return {
    id: 'session-1',
    title: '测试会话',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('Renderer Execution Controls domain', () => {
  test('Given a new Pi session When controls are resolved Then Execute with Full Access is the default', () => {
    expect(resolveAgentExecutionControls(session())).toEqual({
      executionPolicy: 'full-access',
      workflow: 'direct',
    })
  })

  test('Given legacy typed controls When controls are resolved Then they collapse into the two persistent modes', () => {
    expect(resolveAgentExecutionControls(session({
      executionPolicy: 'autonomous',
      workflow: 'plan-first',
      permissionMode: 'bypassPermissions',
    }))).toEqual({ executionPolicy: 'full-access', workflow: 'read-only' })
  })

  test('Given an old Pi session When controls are resolved Then legacy Plan maps safely to Research', () => {
    expect(resolveAgentExecutionControls(session({ permissionMode: 'plan' }))).toEqual({
      executionPolicy: 'full-access',
      workflow: 'read-only',
    })
  })

  test('Given a pre-migration Pi tool profile When controls are resolved Then it maps to the supported workflow', () => {
    expect(resolveAgentExecutionControls(session({ piToolProfile: 'readOnly' }))).toEqual({
      executionPolicy: 'full-access',
      workflow: 'read-only',
    })
    expect(resolveAgentExecutionControls(session({
      workflow: 'plan-first',
      piToolProfile: 'noBash',
    }))).toEqual({ executionPolicy: 'full-access', workflow: 'direct' })
  })

  test('Given Research When Execute is selected Then the direct update is ready immediately without an approval state', () => {
    expect(buildAgentWorkflowUpdate('direct')).toEqual({ workflow: 'direct' })
    expect(buildAgentWorkflowUpdate('read-only')).toEqual({ workflow: 'read-only' })
    expect(buildAgentWorkflowUpdate('plan-first')).toEqual({ workflow: 'read-only' })
  })

  test('Given a run-scoped execution lease When events arrive Then only its exact run can clear the temporary state', () => {
    const granted = updateTemporaryExecutionRunTokens(new Map(), 'session-1', { active: true, runToken: 7 })
    expect(granted.get('session-1')).toBe(7)

    const replacement = updateTemporaryExecutionRunTokens(granted, 'session-1', { active: true, runToken: 8 })
    const staleRevoke = updateTemporaryExecutionRunTokens(replacement, 'session-1', { active: false, runToken: 7 })
    expect(staleRevoke).toBe(replacement)
    expect(staleRevoke.get('session-1')).toBe(8)

    const staleGrant = updateTemporaryExecutionRunTokens(staleRevoke, 'session-1', { active: true, runToken: 7 })
    expect(staleGrant).toBe(staleRevoke)
    expect(staleGrant.get('session-1')).toBe(8)

    const revoked = updateTemporaryExecutionRunTokens(staleGrant, 'session-1', { active: false, runToken: 8 })
    expect(revoked.has('session-1')).toBe(false)
  })

  test('Given Pi sends a run When overrides are built Then only normalized typed controls are emitted', () => {
    const overrides = buildAgentSendControlOverrides({ executionPolicy: 'full-access', workflow: 'direct' })

    expect(overrides).toEqual({ executionPolicyOverride: 'full-access', workflowOverride: 'direct' })
    expect(overrides).not.toHaveProperty('permissionModeOverride')
  })

  test('Given an immediate mode update fails When the error is formatted Then the user receives an understandable message', () => {
    expect(formatExecutionControlsError(new Error('计划审批仍在等待处理'))).toBe('计划审批仍在等待处理')
    expect(formatExecutionControlsError('network down')).toBe('工作方式或安全保护更新失败，请重试')
  })

  test('Given any execution policy When its isolation indicator is rendered Then the lack of an OS sandbox stays explicit', () => {
    expect(getExecutionIsolationIndicator('controlled')).toEqual({
      label: '策略边界（非OS沙箱）',
      emphasis: 'bounded',
    })
    expect(getExecutionIsolationIndicator('autonomous')).toEqual({
      label: '策略边界（非OS沙箱）',
      emphasis: 'bounded',
    })
    expect(getExecutionIsolationIndicator('full-access')).toEqual({
      label: '未沙箱化',
      emphasis: 'danger',
    })
  })
})

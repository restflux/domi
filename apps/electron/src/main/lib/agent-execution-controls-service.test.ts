import { describe, expect, test } from 'bun:test'
import { AgentExecutionControlsService } from './agent-execution-controls-service.ts'

function createHarness(options: { pending?: boolean; active?: boolean } = {}) {
  const persisted: unknown[] = []
  const rememberedPolicies: unknown[] = []
  const rememberedWorkflows: unknown[] = []
  const runtimeUpdates: unknown[] = []
  const clearedCapabilities: string[] = []
  const baseSession = {
    id: 'session-1',
    title: 'Execution controls test',
    executionPolicy: 'controlled' as const,
    workflow: 'plan-first' as const,
    createdAt: 1,
    updatedAt: 1,
  }
  const service = new AgentExecutionControlsService({
    getSession: () => baseSession,
    persist: (_sessionId, controls) => {
      persisted.push(controls)
      return {
        ...baseSession,
        executionPolicy: controls.executionPolicy ?? baseSession.executionPolicy,
        workflow: controls.workflow ?? baseSession.workflow,
      }
    },
    isActive: () => options.active ?? false,
    hasPendingExitPlan: () => options.pending ?? false,
    rememberExecutionPolicy: (executionPolicy) => { rememberedPolicies.push(executionPolicy) },
    rememberWorkflow: (workflow) => { rememberedWorkflows.push(workflow) },
    updateRuntime: async (_sessionId, controls) => { runtimeUpdates.push(controls) },
    clearSessionCapabilities: (sessionId) => { clearedCapabilities.push(sessionId) },
  })
  return { service, persisted, rememberedPolicies, rememberedWorkflows, runtimeUpdates, clearedCapabilities }
}

describe('AgentExecutionControlsService', () => {
  test('Given legacy controls When updated Then they normalize into Full Access plus one of two persistent workflows', async () => {
    const { service, persisted } = createHarness()

    const result = await service.updateSessionExecutionControls('session-1', {
      executionPolicy: 'autonomous',
      workflow: 'plan-first',
      permissionMode: 'bypassPermissions',
    } as { executionPolicy: 'autonomous'; workflow: 'plan-first' })

    expect(persisted).toEqual([{ executionPolicy: 'full-access', workflow: 'read-only' }])
    expect(result).toMatchObject({ executionPolicy: 'full-access', workflow: 'read-only' })
    expect(result).not.toHaveProperty('permissionMode')
  })

  test('Given policy or workflow is actively selected When controls are persisted Then each becomes the matching new-session default', async () => {
    const { service, rememberedPolicies, rememberedWorkflows } = createHarness()

    await service.updateSessionExecutionControls('session-1', { executionPolicy: 'full-access' })
    await service.updateSessionExecutionControls('session-1', { workflow: 'read-only' })

    expect(rememberedPolicies).toEqual(['full-access'])
    expect(rememberedWorkflows).toEqual(['read-only'])
  })

  test('Given a legacy policy is selected When controls are persisted Then it cannot downgrade Execute permissions', async () => {
    const { service, persisted, clearedCapabilities } = createHarness()

    await service.updateSessionExecutionControls('session-1', { executionPolicy: 'autonomous' })

    expect(persisted).toEqual([{ executionPolicy: 'full-access' }])
    expect(clearedCapabilities).toEqual([])
  })

  test('Given renderer sends an invalid enum When controls are updated Then main process rejects without persistence', async () => {
    const { service, persisted } = createHarness()

    await expect(service.updateSessionExecutionControls('session-1', {
      executionPolicy: 'dangerous' as 'controlled',
    })).rejects.toThrow('无效的 Execution Policy')
    expect(persisted).toEqual([])
  })

  test('Given a running session When legacy controls are selected Then runtime receives normalized two-mode controls', async () => {
    const { service, runtimeUpdates } = createHarness({ active: true })

    await service.updateSessionExecutionControls('session-1', { executionPolicy: 'full-access' })
    await service.updateSessionExecutionControls('session-1', { workflow: 'plan-first' })

    expect(runtimeUpdates).toEqual([
      { executionPolicy: 'full-access' },
      { workflow: 'read-only' },
    ])
  })

  test('Given ExitPlan approval is pending When renderer switches to Direct Then it cannot bypass the pending decision', async () => {
    const { service, persisted, runtimeUpdates } = createHarness({ active: true, pending: true })

    await expect(service.updateSessionExecutionControls('session-1', { workflow: 'direct' })).rejects.toThrow('计划审批仍在等待处理')
    expect(persisted).toEqual([])
    expect(runtimeUpdates).toEqual([])
  })
})

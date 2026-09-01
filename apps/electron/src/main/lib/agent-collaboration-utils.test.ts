import { describe, expect, test } from 'bun:test'
import {
  buildDelegationListPayload,
  buildDelegationRunControlOverrides,
  createDelegationRuntimeTimer,
  createToolCallIdempotencyCache,
  resolveDelegationExecutionControls,
  resolveDelegationMaxRuntimeSeconds,
  resolveDelegationPermissionMode,
  shouldExposeCollaborationTools,
} from './agent-collaboration-utils'

describe('协作工具可见性', () => {
  test('仅顶层工作区会话可注入协作工具，手动继续的子会话仍保持禁用', () => {
    expect(shouldExposeCollaborationTools({
      enabled: true,
      workspaceId: 'workspace-a',
      triggeredBy: 'user',
      delegationDepth: 0,
    })).toBe(true)
    expect(shouldExposeCollaborationTools({
      enabled: true,
      workspaceId: 'workspace-a',
      triggeredBy: 'user',
      delegationDepth: 1,
    })).toBe(false)
    expect(shouldExposeCollaborationTools({
      enabled: true,
      workspaceId: 'workspace-a',
      triggeredBy: 'delegation',
      delegationDepth: 0,
    })).toBe(false)
  })
})

describe('协作委派重放保护', () => {
  test('相同父会话和 toolCallId 只执行一次副作用', () => {
    const cache = createToolCallIdempotencyCache<{ delegationId: string }>()
    let creations = 0

    const first = cache.getOrCreate('parent-a', 'call-1', () => {
      creations += 1
      return { delegationId: 'delegation-1' }
    })
    const replay = cache.getOrCreate('parent-a', 'call-1', () => {
      creations += 1
      return { delegationId: 'delegation-2' }
    })

    expect(creations).toBe(1)
    expect(replay).toBe(first)
    expect(replay.delegationId).toBe('delegation-1')
  })

  test('不同父会话或 toolCallId 仍可创建独立委派', () => {
    const cache = createToolCallIdempotencyCache<number>()
    let creations = 0
    const create = () => ++creations

    expect(cache.getOrCreate('parent-a', 'call-1', create)).toBe(1)
    expect(cache.getOrCreate('parent-a', 'call-2', create)).toBe(2)
    expect(cache.getOrCreate('parent-b', 'call-1', create)).toBe(3)
  })

})

describe('协作委派列表成本控制', () => {
  const items = [
    {
      delegationId: 'completed-new',
      childSessionId: 'child-completed-new',
      title: '较新的完成项',
      role: 'review' as const,
      modelId: 'model-a',
      status: 'completed' as const,
      startedAt: 3_000,
      completedAt: 4_000,
      goal: '不应进入列表',
      resultSummary: '不应进入列表',
      executionPolicy: 'full-access',
    },
    {
      delegationId: 'running-new',
      childSessionId: 'child-running-new',
      title: '较新的运行项',
      role: 'research' as const,
      modelId: 'model-b',
      status: 'running' as const,
      startedAt: 2_000,
      pendingBlockedEvents: [{ id: 'blocked-1' }],
    },
    {
      delegationId: 'running-old',
      childSessionId: 'child-running-old',
      title: '较旧的运行项',
      role: 'explore' as const,
      status: 'running' as const,
      startedAt: 1_000,
    },
  ]

  test('默认只返回运行中委派，并按开始时间倒序输出紧凑字段', () => {
    const payload = buildDelegationListPayload(items, {}, 5_000)

    expect(payload.totalMatched).toBe(2)
    expect(payload.returnedCount).toBe(2)
    expect(payload.runningCount).toBe(2)
    expect(payload.truncated).toBe(false)
    expect(payload.delegations).toEqual([
      {
        delegationId: 'running-new',
        childSessionId: 'child-running-new',
        title: '较新的运行项',
        role: 'research',
        modelId: 'model-b',
        status: 'running',
        startedAt: 2_000,
        completedAt: undefined,
        durationMs: 3_000,
        pendingBlockedEventCount: 1,
      },
      {
        delegationId: 'running-old',
        childSessionId: 'child-running-old',
        title: '较旧的运行项',
        role: 'explore',
        modelId: undefined,
        status: 'running',
        startedAt: 1_000,
        completedAt: undefined,
        durationMs: 4_000,
        pendingBlockedEventCount: 0,
      },
    ])
    expect(payload.delegations[0]).not.toHaveProperty('goal')
    expect(payload.delegations[0]).not.toHaveProperty('resultSummary')
    expect(payload.delegations[0]).not.toHaveProperty('executionPolicy')
  })

  test('显式包含完成项时默认最多返回最新 20 条，显式 limit 最大裁剪到 50', () => {
    const manyItems = Array.from({ length: 60 }, (_, index) => ({
      delegationId: `delegation-${index}`,
      childSessionId: `child-${index}`,
      title: `委派 ${index}`,
      role: 'review' as const,
      status: 'completed' as const,
      startedAt: index,
      completedAt: index + 10,
    }))

    const defaultLimited = buildDelegationListPayload(manyItems, { includeCompleted: true }, 100)
    expect(defaultLimited.totalMatched).toBe(60)
    expect(defaultLimited.returnedCount).toBe(20)
    expect(defaultLimited.truncated).toBe(true)
    expect(defaultLimited.delegations[0]?.delegationId).toBe('delegation-59')

    const maxLimited = buildDelegationListPayload(manyItems, { includeCompleted: true, limit: 100 }, 100)
    expect(maxLimited.returnedCount).toBe(50)
  })
})

describe('协作审查运行预算', () => {
  test('review 默认 15 分钟，其他角色默认不设上限，显式值限制在 60 到 7200 秒', () => {
    expect(resolveDelegationMaxRuntimeSeconds('review')).toBe(900)
    expect(resolveDelegationMaxRuntimeSeconds('implement')).toBeUndefined()
    expect(resolveDelegationMaxRuntimeSeconds('review', 10)).toBe(60)
    expect(resolveDelegationMaxRuntimeSeconds('review', 600)).toBe(600)
    expect(resolveDelegationMaxRuntimeSeconds('review', 10_000)).toBe(7_200)
  })

  test('运行时 timer 只触发一次，取消后不再触发', async () => {
    let fired = 0
    const startedAt = Date.now()
    await new Promise<void>((resolve) => {
      createDelegationRuntimeTimer(10, () => {
        fired += 1
        resolve()
      })
    })
    expect(fired).toBe(1)

    const cancelled = createDelegationRuntimeTimer(10, () => {
      fired += 1
    })
    expect(cancelled.deadlineAt).toBeGreaterThanOrEqual(startedAt + 10)
    cancelled.cancel()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fired).toBe(1)
  })
})

describe('协作子会话执行控制继承', () => {
  test.each(['controlled', 'autonomous', 'full-access'] as const)(
    'Pi 子会话继承父会话 %s Execution Policy，并固定使用 Direct typed overrides',
    (executionPolicy) => {
      const controls = resolveDelegationExecutionControls({
        parentExecutionPolicy: executionPolicy,
        parentPermissionMode: 'bypassPermissions',
        requestedPermissionMode: 'bypassPermissions',
      })

      expect(controls).toEqual({ executionPolicy, workflow: 'direct' })
      expect(buildDelegationRunControlOverrides(controls)).toEqual({
        executionPolicyOverride: executionPolicy,
        workflowOverride: 'direct',
      })
      expect(buildDelegationRunControlOverrides(controls)).not.toHaveProperty('permissionModeOverride')
    },
  )

  test('legacy permission resolver no longer upgrades Pi to bypass', () => {
    expect(resolveDelegationPermissionMode('plan', 'bypassPermissions')).toBe('plan')
  })
})

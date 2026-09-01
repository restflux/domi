import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentExitPlanService } from './agent-exit-plan-service.ts'
import { CURRENT_PLAN_FILE_NAME } from './agent-plan-sidecar.ts'

const tempRoots: string[] = []

function activeSignal(): AbortSignal {
  return new AbortController().signal
}

function makeContext(
  executionPolicy: 'controlled' | 'autonomous' | 'full-access' = 'controlled',
  isRunActive: () => boolean = () => true,
  runToken = 1,
) {
  const root = mkdtempSync(join(tmpdir(), 'domi-exit-plan-'))
  tempRoots.push(root)
  return {
    executionPolicy,
    planSidecarDir: join(root, '.context', 'plan'),
    runToken,
    isRunActive,
  } as const
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('AgentExitPlanService', () => {
  test('Given a complete plan When approval opens Then current-plan.md exists before renderer notification', async () => {
    const service = new AgentExitPlanService()
    const context = makeContext('autonomous')
    let planVisibleWhenNotified = false
    const resultPromise = service.handleExitPlanMode(
      'session-pi',
      { plan: '  implement safely\r\n\r\n- run tests  ' },
      context,
      activeSignal(),
      () => {
        planVisibleWhenNotified = readFileSync(
          join(context.planSidecarDir, CURRENT_PLAN_FILE_NAME),
          'utf8',
        ) === 'implement safely\n\n- run tests\n'
      },
    )
    const request = service.getPendingRequests()[0]!

    const resolution = service.respondToExitPlanMode({ requestId: request.requestId, action: 'approve_current' })

    expect(planVisibleWhenNotified).toBe(true)
    expect(request).toMatchObject({
      executionPolicy: 'autonomous',
      toolInput: { plan: 'implement safely\n\n- run tests' },
    })
    expect(resolution).toEqual({ sessionId: 'session-pi', workflow: 'direct', executionScope: 'run' })
    expect(await resultPromise).toEqual({
      behavior: 'allow',
      updatedInput: { plan: 'implement safely\n\n- run tests' },
      workflow: 'direct',
      executionScope: 'run',
    })
    expect(JSON.stringify(await resultPromise)).not.toContain('bypassPermissions')

    const snapshots = readdirSync(join(context.planSidecarDir, 'approved'))
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]!.endsWith(`-${request.requestId}.md`)).toBe(true)
    expect(readFileSync(join(context.planSidecarDir, 'approved', snapshots[0]!), 'utf8'))
      .toBe('implement safely\n\n- run tests\n')
  })

  test('Given the user explicitly switches to Execute When approving Then the resolution is session-scoped', async () => {
    const service = new AgentExitPlanService()
    const context = makeContext('full-access')
    const resultPromise = service.handleExitPlanMode(
      'session-switch', { plan: 'implement persistently' }, context, activeSignal(), () => {},
    )
    const request = service.getPendingRequests()[0]!

    expect(service.respondToExitPlanMode({ requestId: request.requestId, action: 'approve_and_switch' }))
      .toEqual({ sessionId: 'session-switch', workflow: 'direct', executionScope: 'session' })
    expect(await resultPromise).toMatchObject({ behavior: 'allow', executionScope: 'session' })
  })

  test('Given a pending approval belongs to an ended run When the response arrives Then it cannot authorize or create an approved snapshot', async () => {
    const service = new AgentExitPlanService()
    let active = true
    const context = makeContext('full-access', () => active)
    const resultPromise = service.handleExitPlanMode(
      'session-stale', { plan: 'must not execute' }, context, activeSignal(), () => {},
    )
    const request = service.getPendingRequests()[0]!

    active = false
    expect(service.respondToExitPlanMode({ requestId: request.requestId, action: 'approve_and_switch' }))
      .toEqual({ sessionId: 'session-stale', workflow: 'plan-first' })
    expect(await resultPromise).toEqual({
      behavior: 'deny',
      message: '审批对应的 run 已结束，未授权执行',
      workflow: 'plan-first',
      stop: true,
    })
    expect(existsSync(join(context.planSidecarDir, 'approved'))).toBe(false)
  })

  test('Given an old run finalizes after a replacement run opens approval When clearing by token Then the replacement request survives', async () => {
    const service = new AgentExitPlanService()
    const oldResult = service.handleExitPlanMode(
      'same-session', { plan: 'old run plan' }, makeContext('full-access', () => false, 1), activeSignal(), () => {},
    )
    const newResult = service.handleExitPlanMode(
      'same-session', { plan: 'new run plan' }, makeContext('full-access', () => true, 2), activeSignal(), () => {},
    )

    service.clearSessionPending('same-session', 1)
    expect(await oldResult).toMatchObject({ behavior: 'deny', message: '会话已结束' })
    expect(service.getPendingRequests()).toHaveLength(1)
    const current = service.getPendingRequests()[0]!
    service.respondToExitPlanMode({ requestId: current.requestId, action: 'approve_current' })
    expect(await newResult).toMatchObject({ behavior: 'allow', executionScope: 'run' })
  })

  test('Given the run is already aborted When ExitPlanMode starts Then it denies without writing or opening renderer approval', async () => {
    const service = new AgentExitPlanService()
    const context = makeContext()
    const controller = new AbortController()
    controller.abort()
    let requestCount = 0

    const result = await service.handleExitPlanMode(
      'session-aborted',
      { plan: 'do not persist' },
      context,
      controller.signal,
      () => { requestCount += 1 },
    )

    expect(result).toEqual({ behavior: 'deny', message: '操作已中止', workflow: 'plan-first', stop: true })
    expect(requestCount).toBe(0)
    expect(existsSync(join(context.planSidecarDir, CURRENT_PLAN_FILE_NAME))).toBe(false)
  })

  test('Given a pending plan When the user requests changes and a revision is submitted Then the fixed entry updates without an approved snapshot for the rejected draft', async () => {
    const service = new AgentExitPlanService()
    const context = makeContext()
    const firstResult = service.handleExitPlanMode(
      'session-2', { plan: 'draft one' }, context, activeSignal(), () => {},
    )
    const firstRequest = service.getPendingRequests()[0]!

    const resolution = service.respondToExitPlanMode({
      requestId: firstRequest.requestId,
      action: 'feedback',
      feedback: '补充回滚步骤',
    })

    expect(resolution).toEqual({ sessionId: 'session-2', workflow: 'plan-first' })
    expect(await firstResult).toEqual({
      behavior: 'deny', message: '补充回滚步骤', workflow: 'plan-first', stop: false,
    })
    expect(existsSync(join(context.planSidecarDir, 'approved'))).toBe(false)

    const revisedResult = service.handleExitPlanMode(
      'session-2', { plan: 'draft two\n\n- rollback' }, context, activeSignal(), () => {},
    )
    const revisedRequest = service.getPendingRequests()[0]!
    expect(readFileSync(join(context.planSidecarDir, CURRENT_PLAN_FILE_NAME), 'utf8'))
      .toBe('draft two\n\n- rollback\n')

    service.respondToExitPlanMode({ requestId: revisedRequest.requestId, action: 'approve_current' })
    expect((await revisedResult).behavior).toBe('allow')
    expect(readdirSync(join(context.planSidecarDir, 'approved'))).toHaveLength(1)
  })

  test('Given a pending plan When the user denies it Then current execution stops and no approved snapshot is created', async () => {
    const service = new AgentExitPlanService()
    const context = makeContext('full-access')
    const resultPromise = service.handleExitPlanMode(
      'session-3', { plan: 'proposal' }, context, activeSignal(), () => {},
    )
    const request = service.getPendingRequests()[0]!

    expect(service.hasPendingRequest('session-3')).toBe(true)
    const resolution = service.respondToExitPlanMode({ requestId: request.requestId, action: 'deny' })

    expect(resolution).toEqual({ sessionId: 'session-3', workflow: 'plan-first' })
    expect(await resultPromise).toEqual({
      behavior: 'deny', message: '用户拒绝了计划', workflow: 'plan-first', stop: true,
    })
    expect(service.hasPendingRequest('session-3')).toBe(false)
    expect(readFileSync(join(context.planSidecarDir, CURRENT_PLAN_FILE_NAME), 'utf8')).toBe('proposal\n')
    expect(existsSync(join(context.planSidecarDir, 'approved'))).toBe(false)
  })

  test('Given a missing or blank plan When ExitPlanMode starts Then it remains in Plan First without opening approval', async () => {
    for (const plan of [undefined, ' \r\n ']) {
      const service = new AgentExitPlanService()
      const context = makeContext()
      let requestCount = 0

      const result = await service.handleExitPlanMode(
        'session-empty', { plan }, context, activeSignal(), () => { requestCount += 1 },
      )

      expect(result).toEqual({
        behavior: 'deny',
        message: '请在 ExitPlanMode.plan 中提供非空的完整计划正文',
        workflow: 'plan-first',
        stop: false,
      })
      expect(requestCount).toBe(0)
      expect(existsSync(join(context.planSidecarDir, CURRENT_PLAN_FILE_NAME))).toBe(false)
    }
  })

  test('Given the sidecar path cannot be created When ExitPlanMode starts Then persistence failure is visible and approval does not open', async () => {
    const service = new AgentExitPlanService()
    const context = makeContext()
    mkdirSync(join(context.planSidecarDir, '..'), { recursive: true })
    writeFileSync(context.planSidecarDir, 'not a directory')
    let requestCount = 0

    const result = await service.handleExitPlanMode(
      'session-write-failure',
      { plan: 'must be durable' },
      context,
      activeSignal(),
      () => { requestCount += 1 },
    )

    expect(result).toEqual({
      behavior: 'deny',
      message: '计划文件写入失败，请检查会话工作台后重试',
      workflow: 'plan-first',
      stop: false,
    })
    expect(requestCount).toBe(0)
    expect(service.getPendingRequests()).toEqual([])
  })
})

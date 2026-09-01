import { describe, expect, test } from 'bun:test'
import type { AskUserRequest, ExitPlanModeRequest, PermissionRequest } from '@domi/shared'
import {
  BridgeInteractionCoordinator,
  formatBridgeInteractionText,
  isBridgeSafeAskUserRequest,
  type BridgeInteractionScheduler,
} from './bridge-interaction-coordinator'

interface ScheduledTask {
  id: number
  callback: () => void
  delayMs: number
}

class FakeScheduler implements BridgeInteractionScheduler {
  private nextId = 1
  private currentTime = 0
  readonly tasks = new Map<number, ScheduledTask>()

  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++
    this.tasks.set(id, { id, callback, delayMs })
    return id as unknown as ReturnType<typeof setTimeout>
  }

  clearTimeout(handle: ReturnType<typeof setTimeout>): void {
    this.tasks.delete(handle as unknown as number)
  }

  now(): number {
    return this.currentTime
  }

  runAll(): void {
    const tasks = [...this.tasks.values()]
    this.tasks.clear()
    for (const task of tasks) {
      this.currentTime += task.delayMs
      task.callback()
    }
  }
}

function askRequest(overrides: Partial<AskUserRequest> = {}): AskUserRequest {
  return {
    requestId: 'ask-1',
    sessionId: 'session-1',
    toolInput: {},
    questions: [{
      question: '选择处理范围',
      header: '范围',
      options: [
        { label: '仅前端', description: '只改界面' },
        { label: '前后端', description: '同时调整接口' },
      ],
      multiSelect: false,
      allowCustom: true,
    }],
    ...overrides,
  }
}

function planRequest(): ExitPlanModeRequest {
  return {
    requestId: 'plan-1',
    sessionId: 'session-1',
    toolInput: { plan: '实施当前计划。' },
    allowedPrompts: [],
    executionPolicy: 'full-access',
  }
}

function createHarness() {
  const scheduler = new FakeScheduler()
  const askResponses: Array<{ requestId: string; answers: Record<string, string> }> = []
  const planResponses: Array<{ requestId: string; action: string; feedback?: string }> = []
  const timeouts: string[] = []
  let acceptAsk = true
  let acceptPlan = true
  const coordinator = new BridgeInteractionCoordinator({
    scheduler,
    timeoutMs: 100,
    respondAskUser: (requestId, answers) => {
      askResponses.push({ requestId, answers })
      return acceptAsk
    },
    respondExitPlan: (response) => {
      planResponses.push(response)
      return acceptPlan
    },
    onTimeout: (sessionId) => timeouts.push(sessionId),
  })
  coordinator.beginRun('session-1', 'chat-1')
  return {
    coordinator,
    scheduler,
    askResponses,
    planResponses,
    timeouts,
    rejectNextAsk: () => { acceptAsk = false },
    rejectNextPlan: () => { acceptPlan = false },
  }
}

describe('BridgeInteractionCoordinator AskUser', () => {
  test('Given 单选请求 When 用户回复序号 Then 提交对应选项标签', () => {
    const harness = createHarness()
    harness.coordinator.registerAskUser(askRequest())

    const result = harness.coordinator.handleText('chat-1', '1')

    expect(result.status).toBe('accepted')
    expect(harness.askResponses).toEqual([{
      requestId: 'ask-1',
      answers: { 选择处理范围: '仅前端' },
    }])
  })

  test('Given 单选请求 When 用户回复完整选项文字 Then 确定性提交该选项', () => {
    const harness = createHarness()
    harness.coordinator.registerAskUser(askRequest())

    harness.coordinator.handleText('chat-1', '前后端')

    expect(harness.askResponses[0]?.answers).toEqual({ 选择处理范围: '前后端' })
  })

  test('Given 多选请求 When 用户回复逗号或空格序号 Then 去重后提交多个标签', () => {
    const harness = createHarness()
    harness.coordinator.registerAskUser(askRequest({
      questions: [{
        question: '选择模块',
        options: [{ label: '消息' }, { label: '媒体' }, { label: '命令' }],
        multiSelect: true,
        allowCustom: false,
      }],
    }))

    harness.coordinator.handleText('chat-1', '1, 3 1')

    expect(harness.askResponses[0]?.answers).toEqual({ 选择模块: '消息, 命令' })
  })

  test('Given 自由文本问题 When 用户直接回复自然语言 Then 原样作为答案', () => {
    const harness = createHarness()
    harness.coordinator.registerAskUser(askRequest({
      questions: [{ question: '补充要求', options: [], allowCustom: true }],
    }))

    harness.coordinator.handleText('chat-1', '只改前端，不改接口。')

    expect(harness.askResponses[0]?.answers).toEqual({ 补充要求: '只改前端，不改接口。' })
  })

  test('Given 多题请求 When 回答第一题 Then 推进并在第二题后一次提交', () => {
    const harness = createHarness()
    harness.coordinator.registerAskUser(askRequest({
      questions: [
        { question: '第一题', options: [{ label: 'A' }], allowCustom: false },
        { question: '第二题', options: [], allowCustom: true },
      ],
    }))

    const first = harness.coordinator.handleText('chat-1', '1')
    const second = harness.coordinator.handleText('chat-1', '补充说明')

    expect(first.status).toBe('advanced')
    expect(first.view?.questionIndex).toBe(1)
    expect(second.status).toBe('accepted')
    expect(harness.askResponses[0]?.answers).toEqual({ 第一题: 'A', 第二题: '补充说明' })
  })

  test('Given Direct Workflow When 选择调整后再确认 Then 第二条自然语言走专用调整字段', () => {
    const harness = createHarness()
    harness.coordinator.registerAskUser(askRequest({
      toolInput: { presentation: { kind: 'direct-workflow', summary: '实施摘要', details: '实施详情' } },
      questions: [{
        question: '实施反馈已展示在主会话区。如何继续？',
        options: [{ label: '仅执行本次' }, { label: '切换到执行' }, { label: '保持研究' }],
        allowCustom: true,
      }],
    }))

    const first = harness.coordinator.handleText('chat-1', '4')
    const second = harness.coordinator.handleText('chat-1', '只改前端，不改后端。')

    expect(first.status).toBe('awaiting_text')
    expect(second.status).toBe('accepted')
    expect(harness.askResponses[0]?.answers).toEqual({
      __direct_workflow_adjustment__: '只改前端，不改后端。',
    })
  })
})

describe('BridgeInteractionCoordinator Plan 与安全边界', () => {
  test('Given 计划审批 When 选择仅执行本次 Then 提交 approve_current', () => {
    const harness = createHarness()
    harness.coordinator.registerExitPlan(planRequest())

    harness.coordinator.handleText('chat-1', '1')

    expect(harness.planResponses).toEqual([{ requestId: 'plan-1', action: 'approve_current' }])
  })

  test('Given 计划审批 When 选择调整后再确认 Then 收集反馈后提交', () => {
    const harness = createHarness()
    harness.coordinator.registerExitPlan(planRequest())

    const first = harness.coordinator.handleAction('chat-1', 'plan-1', 'plan:feedback')
    const second = harness.coordinator.handleText('chat-1', '先补充回归测试。')

    expect(first.status).toBe('awaiting_text')
    expect(second.status).toBe('accepted')
    expect(harness.planResponses).toEqual([{
      requestId: 'plan-1',
      action: 'feedback',
      feedback: '先补充回归测试。',
    }])
  })

  test('Given 未知宿主 presentation When 注册 AskUser Then 只允许回桌面处理', () => {
    const harness = createHarness()
    const request = askRequest({ toolInput: { presentation: { kind: 'local-maintenance' } } })

    expect(isBridgeSafeAskUserRequest(request)).toBe(false)
    const view = harness.coordinator.registerAskUser(request)
    const result = harness.coordinator.handleText('chat-1', '1')

    expect(view?.desktopOnly).toBe(true)
    expect(result.status).toBe('invalid')
    expect(harness.askResponses).toHaveLength(0)
  })

  test('Given Execution Policy 权限请求 When 注册 Then 不向 IM 下放批准能力', () => {
    const harness = createHarness()
    const request: PermissionRequest = {
      requestId: 'permission-1',
      sessionId: 'session-1',
      toolName: 'Bash',
      toolInput: {},
      description: '测试权限请求',
      dangerLevel: 'normal',
    }

    const view = harness.coordinator.registerPermission(request)

    expect(view?.desktopOnly).toBe(true)
    expect(formatBridgeInteractionText(view!)).toContain('请回 Domi 桌面处理')
  })
})

describe('BridgeInteractionCoordinator 生命周期与竞态', () => {
  test('Given 桌面先回答 When 收到 resolved Then IM 请求关闭且迟到序号不会成为新任务', () => {
    const harness = createHarness()
    harness.coordinator.registerAskUser(askRequest())

    const resolution = harness.coordinator.resolveRequest('ask-1')
    const late = harness.coordinator.handleText('chat-1', '1')

    expect(resolution).toEqual({ submittedByThisCoordinator: false })
    expect(late.status).toBe('expired')
    expect(harness.askResponses).toHaveLength(0)
  })

  test('Given IM 提交时桌面已经抢答 When 服务拒绝 Then 返回失效而不重复提交', () => {
    const harness = createHarness()
    harness.rejectNextAsk()
    harness.coordinator.registerAskUser(askRequest())

    const result = harness.coordinator.handleText('chat-1', '1')

    expect(result.status).toBe('expired')
  })

  test('Given 请求超时 When 定时器触发 Then 清理并停止对应会话', () => {
    const harness = createHarness()
    harness.coordinator.registerAskUser(askRequest())

    harness.scheduler.runAll()

    expect(harness.timeouts).toEqual(['session-1'])
    expect(harness.coordinator.getPendingView('chat-1')).toBeNull()
    expect(harness.coordinator.handleText('chat-1', '1').status).toBe('expired')
  })

  test('Given 停止或断线 When 清理 Then 旧请求不能进入下一轮', () => {
    const harness = createHarness()
    harness.coordinator.registerAskUser(askRequest())
    harness.coordinator.endRun('session-1')
    harness.coordinator.beginRun('session-1', 'chat-1')

    expect(harness.coordinator.handleText('chat-1', '1').status).toBe('expired')
  })

  test('Given Bridge 断线 When 清空协调器 Then 所有旧请求和定时器都失效', () => {
    const harness = createHarness()
    harness.coordinator.registerAskUser(askRequest())

    harness.coordinator.clearAll()
    harness.scheduler.runAll()

    expect(harness.coordinator.getPendingView('chat-1')).toBeNull()
    expect(harness.timeouts).toEqual([])
    expect(harness.coordinator.handleText('chat-1', '1').handled).toBe(false)
  })

  test('Given 新一轮已开始 When 旧 requestId 的卡片按钮到达 Then 拒绝迟到操作', () => {
    const harness = createHarness()
    harness.coordinator.registerAskUser(askRequest())
    harness.coordinator.beginRun('session-1', 'chat-1')
    harness.coordinator.registerAskUser(askRequest({ requestId: 'ask-2' }))

    const result = harness.coordinator.handleAction('chat-1', 'ask-1', 'option:1')

    expect(result.status).toBe('expired')
    expect(harness.askResponses).toHaveLength(0)
  })

  test('Given 等待请求 When 查询当前状态 Then 可重新获得完整问题和选项', () => {
    const harness = createHarness()
    harness.coordinator.registerAskUser(askRequest())

    const view = harness.coordinator.getPendingView('chat-1')

    expect(view?.prompt).toBe('选择处理范围')
    expect(view?.options.map((option) => option.label)).toEqual(['仅前端', '前后端', '其他（直接输入）'])
  })
})

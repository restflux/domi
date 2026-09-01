import { describe, expect, test } from 'bun:test'
import {
  assertAgentPlanCommandMayBeQueued,
  isAgentPlanCommand,
  parseAgentPlanCommand,
  resolveAgentPlanCommandWorkflow,
} from './agent-plan-command.ts'

describe('parseAgentPlanCommand', () => {
  test('recognizes an explicit /plan task and removes only the visible command marker from the model prompt', () => {
    expect(parseAgentPlanCommand('/plan 设计新的权限流程')).toEqual({
      matched: true,
      task: '设计新的权限流程',
      promptMessage: '设计新的权限流程',
    })
  })

  test('preserves leading attachment and quote context while recognizing the visible task command', () => {
    const message = [
      '<attached_files>',
      '- spec.md: C:\\tmp\\spec.md',
      '</attached_files>',
      '',
      '<quoted_context>现有方案</quoted_context>',
      '',
      '/plan 根据附件完善方案',
    ].join('\n')

    expect(parseAgentPlanCommand(message)).toEqual({
      matched: true,
      task: '根据附件完善方案',
      promptMessage: [
        '<attached_files>',
        '- spec.md: C:\\tmp\\spec.md',
        '</attached_files>',
        '',
        '<quoted_context>现有方案</quoted_context>',
        '',
        '根据附件完善方案',
      ].join('\n'),
    })
  })

  test('recognizes bare /plan but asks for a concrete task instead of submitting an empty plan', () => {
    expect(parseAgentPlanCommand('/plan')).toEqual({
      matched: true,
      promptMessage: '用户输入了 /plan，但没有提供要规划的具体任务。请简短提示用户在 /plan 后补充任务；不要提交空计划。',
    })
  })

  test.each(['/planning 做方案', '/Plan 做方案', '请使用 /plan 做方案', ''])('rejects %j', (message) => {
    expect(parseAgentPlanCommand(message)).toEqual({ matched: false })
    expect(isAgentPlanCommand(message)).toBe(false)
  })
})

describe('assertAgentPlanCommandMayBeQueued', () => {
  test('rejects an exact /plan command from an active-run queue', () => {
    expect(() => assertAgentPlanCommandMayBeQueued('/plan 设计新的权限流程'))
      .toThrow('/plan 只能在会话空闲时启动新任务，请等待当前任务结束后发送')
  })

  test('allows ordinary queued messages and embedded /plan text', () => {
    expect(() => assertAgentPlanCommandMayBeQueued('继续执行')).not.toThrow()
    expect(() => assertAgentPlanCommandMayBeQueued('请使用 /plan 做方案')).not.toThrow()
  })
})

describe('resolveAgentPlanCommandWorkflow', () => {
  test('forces only the exact command run into Plan First without changing the persistent workflow', () => {
    expect(resolveAgentPlanCommandWorkflow('direct', true)).toEqual({
      runWorkflow: 'plan-first',
      persistentWorkflow: 'direct',
    })
    expect(resolveAgentPlanCommandWorkflow('read-only', true)).toEqual({
      runWorkflow: 'plan-first',
      persistentWorkflow: 'read-only',
    })
  })

  test('normal runs collapse legacy persisted Plan First back to Research', () => {
    expect(resolveAgentPlanCommandWorkflow('plan-first', false)).toEqual({
      runWorkflow: 'read-only',
      persistentWorkflow: 'read-only',
    })
  })
})

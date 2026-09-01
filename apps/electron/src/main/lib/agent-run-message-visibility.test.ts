import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@domi/shared'
import {
  isUserFacingRunOutput,
  isVisibleRunMessage,
  shouldFailRunForEmptyResponse,
} from './agent-run-message-visibility'

describe('Agent 本轮可见消息判定', () => {
  test.each([
    { type: 'system', subtype: 'compacting' },
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'system', subtype: 'status', compact_result: 'success' },
  ] as SDKMessage[])('Given /compact 返回压缩状态 %# When 判断本轮是否有可见内容 Then 保持状态展示但不充当任务输出', (message) => {
    expect(isVisibleRunMessage(message)).toBe(true)
    expect(isUserFacingRunOutput(message)).toBe(false)
  })

  test('Given assistant 只有内部 thinking When 判断本轮是否有可见内容 Then 允许空回复保护接管', () => {
    const message = {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '准备生成示例图' },
          { type: 'text', text: '' },
        ],
      },
    } as SDKMessage

    expect(isVisibleRunMessage(message)).toBe(false)
  })

  test('Given assistant 返回正文或工具调用 When 判断本轮是否有可见内容 Then 保持正常成功语义', () => {
    const textMessage = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '已生成示例。' }] },
    } as SDKMessage
    const toolMessage = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'generate_image', input: {} }] },
    } as SDKMessage

    expect(isVisibleRunMessage(textMessage)).toBe(true)
    expect(isVisibleRunMessage(toolMessage)).toBe(true)
    expect(isUserFacingRunOutput(textMessage)).toBe(true)
    expect(isUserFacingRunOutput(toolMessage)).toBe(true)
  })

  test.each(['ReadyForReview', 'FinishWorktree', 'ApplyWorktree', 'CompactContext'])(
    'Given %s 终止型工具调用 When 判断运行级用户输出 Then 保持工具生命周期优先级',
    (name) => {
      const message = {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tool-1', name, input: {} }] },
      } as SDKMessage

      expect(isUserFacingRunOutput(message)).toBe(true)
    },
  )

  test('Given tool result 到达 When 判断运行级用户输出 Then 视为真实执行输出', () => {
    const message = {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] },
    } as SDKMessage

    expect(isUserFacingRunOutput(message)).toBe(true)
  })

  test.each([
    { type: 'system', subtype: 'task_started' },
    { type: 'system', subtype: 'task_progress' },
    { type: 'system', subtype: 'task_notification' },
  ] as SDKMessage[])('Given 内部任务状态 %# When 判断运行级用户输出 Then 不掩盖空回复', (message) => {
    expect(isVisibleRunMessage(message)).toBe(true)
    expect(isUserFacingRunOutput(message)).toBe(false)
  })

  test('Given SDK 仅返回不可展示的 init 和 result When 判断本轮是否有可见内容 Then 仍允许空回复保护接管', () => {
    expect(isVisibleRunMessage({ type: 'system', subtype: 'init' } as SDKMessage)).toBe(false)
    expect(isVisibleRunMessage({ type: 'result', subtype: 'success' } as SDKMessage)).toBe(false)
  })

  test('Given 普通运行只有 thinking 与自动压缩状态 When 运行结束 Then 必须触发空回复保护', () => {
    expect(shouldFailRunForEmptyResponse({
      wasStoppedByUser: false,
      explicitCompactRequest: false,
      userFacingOutputCount: 0,
    })).toBe(true)
  })

  test('Given 用户显式 /compact 或主动停止 When 没有普通 assistant 输出 Then 保留各自正常终态', () => {
    expect(shouldFailRunForEmptyResponse({
      wasStoppedByUser: false,
      explicitCompactRequest: true,
      userFacingOutputCount: 0,
    })).toBe(false)
    expect(shouldFailRunForEmptyResponse({
      wasStoppedByUser: true,
      explicitCompactRequest: false,
      userFacingOutputCount: 0,
    })).toBe(false)
  })
})

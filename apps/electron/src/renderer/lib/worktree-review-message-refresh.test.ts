import { describe, expect, test } from 'bun:test'
import type { AgentEvent } from '@domi/shared'
import type { AgentStreamState } from '@/atoms/agent-atoms'
import { shouldRefreshMessagesAfterToolResult } from './worktree-review-message-refresh.ts'

describe('shouldRefreshMessagesAfterToolResult', () => {
  const streamState: AgentStreamState = {
    running: true,
    toolActivities: [{
      toolUseId: 'ready-1',
      toolName: 'ReadyForReview',
      input: {},
      done: false,
    }],
  }

  test('Given ReadyForReview 工具名只存在于流状态 When 成功返回 Then 请求刷新持久化验收消息', () => {
    const event: AgentEvent = {
      type: 'tool_result',
      toolUseId: 'ready-1',
      result: '{"status":"ready_for_review"}',
      isError: false,
    }

    expect(shouldRefreshMessagesAfterToolResult(event, streamState)).toBe(true)
  })

  test('Given 工具结果直接携带 ReadyForReview 名称 When 成功返回 Then 不依赖流状态也请求刷新', () => {
    const event: AgentEvent = {
      type: 'tool_result',
      toolUseId: 'ready-2',
      toolName: 'ReadyForReview',
      result: '{"status":"ready_for_review"}',
      isError: false,
    }

    expect(shouldRefreshMessagesAfterToolResult(event, undefined)).toBe(true)
  })

  test('Given ReadyForReview 失败或普通工具完成 When 判断刷新 Then 不重新读取消息', () => {
    const failed: AgentEvent = {
      type: 'tool_result',
      toolUseId: 'ready-1',
      result: 'failed',
      isError: true,
    }
    const otherTool: AgentEvent = {
      type: 'tool_result',
      toolUseId: 'read-1',
      toolName: 'Read',
      result: 'ok',
      isError: false,
    }

    expect(shouldRefreshMessagesAfterToolResult(failed, streamState)).toBe(false)
    expect(shouldRefreshMessagesAfterToolResult(otherTool, streamState)).toBe(false)
  })
})

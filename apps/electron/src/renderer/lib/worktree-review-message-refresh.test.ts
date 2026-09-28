import { describe, expect, test } from 'bun:test'
import type { AgentEvent, SessionTargetView } from '@domi/shared'
import { createStore } from 'jotai'
import { agentMessageRefreshAtom, type AgentStreamState } from '@/atoms/agent-atoms'
import { sessionTargetStateAtomFamily } from '@/atoms/session-target-atoms'
import { resolveWorktreeRailPriority } from '@/components/agent/ComposerActionRail.tsx'
import { resolveWorktreeHeaderReviewAction } from '@/components/agent/worktree-review/worktree-header-review-action.ts'
import { refreshWorkingWorktreeAfterStreamComplete, refreshWorktreeReviewAfterToolResult, shouldRefreshMessagesAfterToolResult } from './worktree-review-message-refresh.ts'

describe('shouldRefreshMessagesAfterToolResult', () => {
  test('全局监听器在当前 run 的工具结果路径调用双投影刷新', async () => {
    const listener = await Bun.file('apps/electron/src/renderer/hooks/useGlobalAgentListeners.ts').text()
    expect(listener).toContain('void refreshWorktreeReviewAfterToolResult(store, sessionId, event, eventStreamState)')
    expect(listener).toContain('void refreshWorkingWorktreeAfterStreamComplete(store, data.sessionId)')
  })

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

  test('验收成功时消息和权威 Checkout 快照一起更新，输入区与顶栏均恢复操作入口', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const working: SessionTargetView = {
      project: { id: 'project-1', name: 'domi' },
      checkout: { id: 'checkout-1', kind: 'isolated', label: 'Worktree', phase: 'ready' },
      source: { ref: 'main', oid: 'a'.repeat(40) },
      current: { branch: null, oid: 'b'.repeat(40) },
      ownership: 'owner', dirty: true, revision: 1,
      delivery: { state: 'working', iteration: 1 },
    }
    const ready: SessionTargetView = {
      ...working, revision: 2,
      delivery: { state: 'ready_for_review', review: {
        reviewId: 'review-1', iteration: 1, preparedAt: 1, summary: '修改完成',
        validationStatus: 'passed', tests: [], changedFiles: ['src/a.ts'],
        suggestedCommitMessage: 'fix: 修复入口',
      } },
    }
    let inspections = 0
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { electronAPI: { sessionCheckout: { inspect: async () => {
        inspections += 1
        return { ok: true, value: ready }
      } } } },
    })
    try {
      const store = createStore()
      store.set(sessionTargetStateAtomFamily('session-1'), {
        snapshot: working, selectionRequired: false, loading: false, pendingAction: null, error: null,
      })
      expect(resolveWorktreeRailPriority(store.get(sessionTargetStateAtomFamily('session-1')).snapshot?.delivery)).toBeNull()
      expect(resolveWorktreeHeaderReviewAction('session-1', working, null)).toBeNull()

      const event: AgentEvent = { type: 'tool_result', toolUseId: 'ready-1', result: 'ok', isError: false }
      expect(await refreshWorktreeReviewAfterToolResult(store, 'session-1', event, streamState)).toBe(true)
      expect(inspections).toBe(1)
      expect(store.get(agentMessageRefreshAtom).get('session-1')).toBe(1)
      const snapshot = store.get(sessionTargetStateAtomFamily('session-1')).snapshot
      expect(snapshot?.delivery?.state).toBe('ready_for_review')
      expect(resolveWorktreeRailPriority(snapshot?.delivery)).toBe('active')
      expect(resolveWorktreeHeaderReviewAction('session-1', snapshot, null)?.label).toBe('查看验收并预览修改')

      const failed: AgentEvent = { ...event, isError: true }
      expect(await refreshWorktreeReviewAfterToolResult(store, 'session-1', failed, streamState)).toBe(false)
      expect(inspections).toBe(1)
      expect(store.get(agentMessageRefreshAtom).get('session-1')).toBe(1)

      await refreshWorkingWorktreeAfterStreamComplete(store, 'session-1')
      expect(inspections).toBe(1)
      store.set(sessionTargetStateAtomFamily('session-1'), {
        snapshot: working, selectionRequired: false, loading: false, pendingAction: null, error: null,
      })
      await refreshWorkingWorktreeAfterStreamComplete(store, 'session-1')
      expect(inspections).toBe(2)
      expect(store.get(sessionTargetStateAtomFamily('session-1')).snapshot?.delivery?.state).toBe('ready_for_review')
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
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

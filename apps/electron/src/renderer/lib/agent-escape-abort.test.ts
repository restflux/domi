import { describe, expect, test } from 'bun:test'
import {
  AGENT_ESCAPE_ABORT_CONFIRM_WINDOW_MS,
  decideAgentEscapeAbort,
  shouldHandleAgentEscapeAbort,
} from './agent-escape-abort'

describe('Agent Escape 停止确认', () => {
  test('只在当前 Agent 会话位于前台且没有打开弹窗时接管 Escape', () => {
    expect(shouldHandleAgentEscapeAbort({
      sessionRootPresent: true,
      sessionRootHidden: false,
      hasOpenDialog: false,
    })).toBe(true)

    expect(shouldHandleAgentEscapeAbort({
      sessionRootPresent: true,
      sessionRootHidden: true,
      hasOpenDialog: false,
    })).toBe(false)

    expect(shouldHandleAgentEscapeAbort({
      sessionRootPresent: true,
      sessionRootHidden: false,
      hasOpenDialog: true,
    })).toBe(false)

    expect(shouldHandleAgentEscapeAbort({
      sessionRootPresent: false,
      sessionRootHidden: false,
      hasOpenDialog: false,
    })).toBe(false)
  })

  test('第一次按 Escape 只进入确认态，确认窗口内第二次才停止', () => {
    const first = decideAgentEscapeAbort(null, 1_000)
    expect(first).toEqual({
      action: 'confirm',
      armedUntil: 1_000 + AGENT_ESCAPE_ABORT_CONFIRM_WINDOW_MS,
    })
    if (first.action !== 'confirm') throw new Error('第一次 Escape 应进入确认态')

    expect(decideAgentEscapeAbort(first.armedUntil, first.armedUntil - 1)).toEqual({
      action: 'abort',
      armedUntil: null,
    })
  })

  test('确认窗口过期后再次按 Escape 重新提醒而不是停止', () => {
    const first = decideAgentEscapeAbort(null, 1_000)
    if (first.action !== 'confirm') throw new Error('第一次 Escape 应进入确认态')
    expect(decideAgentEscapeAbort(first.armedUntil, first.armedUntil + 1)).toEqual({
      action: 'confirm',
      armedUntil: first.armedUntil + 1 + AGENT_ESCAPE_ABORT_CONFIRM_WINDOW_MS,
    })
  })
})

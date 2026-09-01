import { describe, expect, test } from 'bun:test'
import {
  AGENT_BOTTOM_FOLLOW_SCROLL_OPTIONS,
  resolveAgentBottomFollow,
} from './agent-bottom-follow'

describe('Agent 会话发送后的底部跟随', () => {
  test('同一会话发起新的用户 turn 时重新锁定到底部', () => {
    const result = resolveAgentBottomFollow(
      { sessionId: 'session-a', requestRevision: 1 },
      { sessionId: 'session-a', requestRevision: 2 },
    )

    expect(result.shouldScrollToBottom).toBe(true)
  })

  test('置底期间允许滚轮中断自动跟随', () => {
    expect(AGENT_BOTTOM_FOLLOW_SCROLL_OPTIONS).toEqual({
      animation: 'instant',
      ignoreEscapes: false,
      duration: 350,
    })
  })

  test('首次发送和排队追加同样由递增 revision 触发', () => {
    expect(resolveAgentBottomFollow(
      { sessionId: 'session-a', requestRevision: 0 },
      { sessionId: 'session-a', requestRevision: 1 },
    ).shouldScrollToBottom).toBe(true)

    expect(resolveAgentBottomFollow(
      { sessionId: 'session-a', requestRevision: 1 },
      { sessionId: 'session-a', requestRevision: 2 },
    ).shouldScrollToBottom).toBe(true)
  })

  test('消息持久化替换、普通重渲染和切换会话不会覆盖阅读位置', () => {
    expect(resolveAgentBottomFollow(
      { sessionId: 'session-a', requestRevision: 2 },
      { sessionId: 'session-a', requestRevision: 2 },
    ).shouldScrollToBottom).toBe(false)

    expect(resolveAgentBottomFollow(
      { sessionId: 'session-a', requestRevision: 2 },
      { sessionId: 'session-b', requestRevision: 9 },
    ).shouldScrollToBottom).toBe(false)
  })
})

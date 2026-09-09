import { describe, expect, test } from 'bun:test'
import type { AgentSessionMeta } from '@domi/shared'
import {
  filterSessionSearchResultsForNavigation,
  isAgentSessionVisibleInNavigation,
} from './agent-session-purpose'

function session(id: string, overrides: Partial<AgentSessionMeta> = {}): AgentSessionMeta {
  return { id, title: id, createdAt: 1, updatedAt: 2, ...overrides }
}

describe('普通导航的会话用途过滤', () => {
  test('Given 任意标题与协作关系 When 有侧聊父 ID Then 不进入普通导航', () => {
    const sessions = [
      session('parent'),
      session('delegate', { parentSessionId: 'parent', sourceDelegationId: 'delegation' }),
      session('title-only', { title: '侧聊 · 辅助问答' }),
      session('legacy-review', { independentReviewId: 'legacy' }),
      session('empty-purpose', { sideChatParentSessionId: '' }),
      session('side-chat', { title: '普通任务', sideChatParentSessionId: 'parent' }),
      session('side-chat-pinned', { sideChatParentSessionId: 'parent', pinned: true }),
      session('side-chat-archived', { sideChatParentSessionId: 'parent', archived: true }),
      session('side-chat-delegated', {
        sideChatParentSessionId: 'parent', parentSessionId: 'parent', sourceDelegationId: 'delegation',
      }),
    ]
    const original = structuredClone(sessions)
    expect(sessions.filter(isAgentSessionVisibleInNavigation).map((item) => item.id)).toEqual([
      'parent', 'delegate', 'title-only', 'legacy-review', 'empty-purpose',
    ])
    expect(sessions).toEqual(original)
  })

  test('Given IPC 内容或已缓存标题结果 When 元数据识别为侧聊 Then 不显示且保留普通结果顺序', () => {
    const results = [
      { id: 'side-chat', type: 'agent' as const, snippet: '旧 IPC 结果' },
      { id: 'parent', type: 'agent' as const },
      { id: 'side-chat', type: 'chat' as const },
      { id: 'unknown', type: 'agent' as const },
      { id: 'delegate', type: 'agent' as const },
    ]
    const sessions = [session('side-chat'), session('parent'), session('delegate')]
    expect(filterSessionSearchResultsForNavigation(results, sessions)).toEqual(results)
    const latest = sessions.map((item) => item.id === 'side-chat'
      ? { ...item, sideChatParentSessionId: 'parent' }
      : item)
    expect(filterSessionSearchResultsForNavigation(results, latest)).toEqual(results.slice(1))
    expect(results).toHaveLength(5)
  })

  test('Given 未加载的元数据 When 检查旧 Tab Then 不改变原恢复行为', () => {
    expect(isAgentSessionVisibleInNavigation(undefined)).toBe(true)
  })
})

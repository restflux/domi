import { describe, expect, test } from 'bun:test'
import type { TabItem } from '@/atoms/tab-atoms'
import { canCloseMainTab } from './tab-close-policy.ts'

const activeWorkTab: TabItem = {
  id: 'agent:session-a',
  type: 'agent',
  sessionId: 'session-a',
  title: '当前 Work',
}

describe('主区标签关闭策略', () => {
  test('当前活动 Work 标签保持打开，后台 Work 标签仍可关闭', () => {
    expect(canCloseMainTab(activeWorkTab, activeWorkTab.id)).toBe(false)
    expect(canCloseMainTab(activeWorkTab, 'agent:session-b')).toBe(true)
  })

  test('Chat 和 Preview 仍可关闭，草稿入口固定保留', () => {
    const chatTab: TabItem = { id: 'chat:1', type: 'chat', sessionId: '1', title: 'Chat' }
    const previewTab: TabItem = { id: 'preview:session-a', type: 'preview', sessionId: 'session-a', title: 'Preview' }
    const scratchTab: TabItem = { id: 'scratch', type: 'scratch', sessionId: 'scratch', title: '草稿' }

    expect(canCloseMainTab(chatTab, chatTab.id)).toBe(true)
    expect(canCloseMainTab(previewTab, previewTab.id)).toBe(true)
    expect(canCloseMainTab(scratchTab, scratchTab.id)).toBe(false)
  })
})

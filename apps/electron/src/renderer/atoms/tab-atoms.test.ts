import { describe, expect, test } from 'bun:test'
import {
  SCRATCH_PAD_ID,
  closeTab,
  getPersistableTabState,
  openTab,
  reorderTabs,
  type TabItem,
} from './tab-atoms'

const sessionTab: TabItem = {
  id: 'session-1',
  type: 'agent',
  sessionId: 'session-1',
  title: '优化顶部标签',
}

const otherSessionTab: TabItem = {
  id: 'session-2',
  type: 'agent',
  sessionId: 'session-2',
  title: '另一个会话',
}

const previewTab: TabItem = {
  id: '__preview__:session-1',
  type: 'preview',
  sessionId: 'session-1',
  title: '预览：CONTEXT.md',
}

const legacyScratchTab: TabItem = {
  id: SCRATCH_PAD_ID,
  type: 'scratch',
  sessionId: SCRATCH_PAD_ID,
  title: 'Scratch Pad',
}

describe('顶部标签信息架构', () => {
  test('打开会话时只保留当前会话，草稿不再占用顶部标签', () => {
    const result = openTab([legacyScratchTab], sessionTab)

    expect(result.tabs.map((tab) => tab.id)).toEqual(['session-1'])
    expect(result.activeTabId).toBe('session-1')
  })

  test('旧版草稿打开请求不会重新创建顶部入口', () => {
    const result = openTab([sessionTab, legacyScratchTab], legacyScratchTab)

    expect(result.tabs).toEqual([sessionTab])
    expect(result.activeTabId).toBe(sessionTab.id)
  })

  test('恢复旧预览提示时仍只打开所属会话', () => {
    const result = openTab([legacyScratchTab, sessionTab], sessionTab, {
      previewTabOpen: true,
      previewTitle: previewTab.title,
      lastView: 'preview',
    })

    expect(result.tabs.map((tab) => tab.id)).toEqual(['session-1'])
    expect(result.activeTabId).toBe('session-1')
  })

  test('持久化时清理旧草稿和预览标签', () => {
    expect(getPersistableTabState(
      [sessionTab, previewTab, legacyScratchTab],
      legacyScratchTab.id,
    )).toEqual({
      tabs: [sessionTab],
      activeTabId: sessionTab.id,
    })
  })

  test('关闭活动预览后回到其所属会话', () => {
    const result = closeTab(
      [sessionTab, previewTab],
      previewTab.id,
      previewTab.id,
    )

    expect(result.tabs.map((tab) => tab.id)).toEqual(['session-1'])
    expect(result.activeTabId).toBe('session-1')
  })

  test('会话标签可以正常重排', () => {
    expect(reorderTabs([sessionTab, otherSessionTab], 1, 0)).toEqual([
      otherSessionTab,
      sessionTab,
    ])
  })
})

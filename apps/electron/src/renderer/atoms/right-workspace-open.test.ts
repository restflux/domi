import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { rightWorkspaceOpenAtom } from './right-workspace-atoms.ts'
import { currentAgentSessionIdAtom } from './agent-atoms.ts'
import { openSideChatPanelAtom } from './side-chat-atoms.ts'
import { interfaceVariantAtom, themeModeAtom } from './theme.ts'

describe('Right Workspace 初始开合', () => {
  test('新 Work 会话默认收起右栏，切回已手动展开的会话仍保持原状态', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(interfaceVariantAtom, 'modern')
    expect(store.get(rightWorkspaceOpenAtom)).toBe(false)

    store.set(rightWorkspaceOpenAtom, true)
    store.set(currentAgentSessionIdAtom, 'session-b')
    expect(store.get(rightWorkspaceOpenAtom)).toBe(false)
    store.set(currentAgentSessionIdAtom, 'session-a')
    expect(store.get(rightWorkspaceOpenAtom)).toBe(true)

    store.set(rightWorkspaceOpenAtom, false)
    store.set(currentAgentSessionIdAtom, 'session-b')
    expect(store.get(rightWorkspaceOpenAtom)).toBe(false)
    store.set(currentAgentSessionIdAtom, 'session-a')
    expect(store.get(rightWorkspaceOpenAtom)).toBe(false)
  })

  test('侧聊请求只展开目标 Work 会话的右栏', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-b')
    store.set(openSideChatPanelAtom, { parentSessionId: 'session-a' })
    expect(store.get(rightWorkspaceOpenAtom)).toBe(false)
    store.set(currentAgentSessionIdAtom, 'session-a')
    expect(store.get(rightWorkspaceOpenAtom)).toBe(true)
  })

  test('新会话不受主题与经典界面切换影响，仍默认收起', () => {
    const store = createStore()
    store.set(currentAgentSessionIdAtom, 'session-a')
    store.set(themeModeAtom, 'dark')
    store.set(interfaceVariantAtom, 'modern')
    expect(store.get(rightWorkspaceOpenAtom)).toBe(false)
    store.set(rightWorkspaceOpenAtom, true)
    store.set(themeModeAtom, 'light')
    store.set(interfaceVariantAtom, 'classic')
    expect(store.get(rightWorkspaceOpenAtom)).toBe(true)
    store.set(currentAgentSessionIdAtom, 'session-b')
    expect(store.get(rightWorkspaceOpenAtom)).toBe(false)
  })
})

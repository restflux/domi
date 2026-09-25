import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { rightWorkspaceOpenAtom } from './right-workspace-atoms.ts'
import { interfaceVariantAtom, themeModeAtom } from './theme.ts'

describe('Right Workspace 初始开合', () => {
  test('普通浅色现代界面默认聚焦对话，显式开合偏好在换主题后仍保留', () => {
    const store = createStore()
    store.set(themeModeAtom, 'light')
    store.set(interfaceVariantAtom, 'modern')

    expect(store.get(rightWorkspaceOpenAtom)).toBe(false)
    store.set(rightWorkspaceOpenAtom, true)
    store.set(themeModeAtom, 'dark')
    expect(store.get(rightWorkspaceOpenAtom)).toBe(true)
    store.set(themeModeAtom, 'light')
    expect(store.get(rightWorkspaceOpenAtom)).toBe(true)
  })

  test('深色与经典界面保持原本默认展开的布局', () => {
    const store = createStore()
    store.set(themeModeAtom, 'dark')
    store.set(interfaceVariantAtom, 'modern')
    expect(store.get(rightWorkspaceOpenAtom)).toBe(true)

    store.set(themeModeAtom, 'light')
    store.set(interfaceVariantAtom, 'classic')
    expect(store.get(rightWorkspaceOpenAtom)).toBe(true)
  })
})

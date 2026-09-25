import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { rightWorkspaceOpenAtom } from './right-workspace-atoms.ts'
import { interfaceVariantAtom, themeModeAtom } from './theme.ts'

describe('Right Workspace 初始开合', () => {
  test('现代界面默认聚焦对话，显式开合偏好在换主题后仍保留', () => {
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

  test('现代深色和特殊主题不因换配色而自动展开，经典界面维持默认展开', () => {
    const store = createStore()
    store.set(themeModeAtom, 'dark')
    store.set(interfaceVariantAtom, 'modern')
    expect(store.get(rightWorkspaceOpenAtom)).toBe(false)

    store.set(themeModeAtom, 'special')
    expect(store.get(rightWorkspaceOpenAtom)).toBe(false)

    store.set(themeModeAtom, 'light')
    store.set(interfaceVariantAtom, 'classic')
    expect(store.get(rightWorkspaceOpenAtom)).toBe(true)
  })
})

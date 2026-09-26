import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { interfaceVariantAtom, isModernInterfaceAtom, systemIsDarkAtom, themeModeAtom, themeStyleAtom } from './theme.ts'

describe('现代界面布局与主题解耦', () => {
  test('浅色、深色、系统跟随及特殊主题切换不改变现代布局', () => {
    const store = createStore()
    store.set(interfaceVariantAtom, 'modern')
    for (const mode of ['light', 'dark', 'system', 'special'] as const) {
      store.set(themeModeAtom, mode)
      store.set(systemIsDarkAtom, mode === 'system')
      if (mode === 'special') store.set(themeStyleAtom, 'terminal-dark')
      expect(store.get(isModernInterfaceAtom)).toBe(true)
    }
  })

  test('工作台 v2 与旧界面切换只替换视图形态，不重建会话状态源', () => {
    const store = createStore()
    store.set(interfaceVariantAtom, 'workbench-v2')
    expect(store.get(isModernInterfaceAtom)).toBe(true)
    store.set(interfaceVariantAtom, 'classic')
    expect(store.get(isModernInterfaceAtom)).toBe(false)
    store.set(interfaceVariantAtom, 'workbench-v2')
    expect(store.get(interfaceVariantAtom)).toBe('workbench-v2')
  })

  test('经典界面在任何主题下保留自身布局', () => {
    const store = createStore()
    store.set(interfaceVariantAtom, 'classic')
    for (const mode of ['light', 'dark', 'special'] as const) {
      store.set(themeModeAtom, mode)
      expect(store.get(isModernInterfaceAtom)).toBe(false)
    }
  })
})

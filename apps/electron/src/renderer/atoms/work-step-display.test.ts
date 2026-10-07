import { afterEach, describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { AppSettings, WorkStepDisplay } from '../../types'
import { initializeWorkStepDisplay, updateWorkStepDisplay, workStepDisplayAtom } from './work-step-display'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

function mockSettingsAPI(
  getSettings: () => Promise<AppSettings>,
  updateSettings: (updates: Partial<AppSettings>) => Promise<AppSettings> = async (updates) => ({ language: 'zh-CN', themeMode: 'dark', ...updates }),
): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { getSettings, updateSettings } } })
}

describe('工作步骤 Jotai 偏好与 settings.json 桥接', () => {
  test('Given 未初始化 When 新建 store Then 默认标准', () => {
    expect(createStore().get(workStepDisplayAtom)).toBe('standard')
  })

  test('Given 旧配置或已保存三档 When 初始化 Then 读取主进程设置并安全归一', async () => {
    for (const display of [undefined, 'compact', 'standard', 'detailed', 'invalid']) {
      mockSettingsAPI(async () => ({ themeMode: 'dark', workStepDisplay: display } as AppSettings))
      const store = createStore()
      await initializeWorkStepDisplay((value) => store.set(workStepDisplayAtom, value))
      expect(store.get(workStepDisplayAtom)).toBe(display === 'compact' || display === 'detailed' ? display : 'standard')
    }
  })

  test('Given 用户选择 When 保存 Then 仅提交密度字段且保存成功后刷新展示', async () => {
    let submitted: Partial<AppSettings> | undefined
    mockSettingsAPI(async () => ({ language: 'zh-CN', themeMode: 'dark' }), async (updates) => {
      submitted = updates
      return { language: 'zh-CN', themeMode: 'dark', ...updates }
    })
    const store = createStore()
    await updateWorkStepDisplay('detailed', (value) => store.set(workStepDisplayAtom, value))
    expect(submitted).toEqual({ workStepDisplay: 'detailed' })
    expect(store.get(workStepDisplayAtom)).toBe('detailed')
  })

  test('Given 读取或保存失败 When 请求设置 Then 不覆盖当前密度', async () => {
    mockSettingsAPI(async () => { throw new Error('读取失败') }, async () => { throw new Error('保存失败') })
    let current: WorkStepDisplay = 'compact'
    await initializeWorkStepDisplay((value) => { current = value })
    expect(current).toBe('compact')
    await updateWorkStepDisplay('detailed', (value) => { current = value })
    expect(current).toBe('compact')
  })
})

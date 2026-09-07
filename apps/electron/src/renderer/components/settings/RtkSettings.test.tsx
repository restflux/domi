import { afterEach, describe, expect, test } from 'bun:test'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RtkStatus } from '@domi/shared'
import { RtkSettings } from './RtkSettings.tsx'
import { loadRtkSettingsAtom, rtkSettingsAtom, setRtkEnabledAtom } from '../../atoms/rtk-atoms.ts'

const originalWindow = globalThis.window
const status: RtkStatus = { availability: 'available', version: '0.48.0', optimizedCalls: 2, originalBytes: 2000, returnedBytes: 1000 }
afterEach(() => { globalThis.window = originalWindow })

describe('RTK 设置', () => {
  test('Given 首次打开 When 渲染 Then 开关默认关闭且无需额外安装', () => {
    const html = renderToStaticMarkup(<Provider store={createStore()}><RtkSettings /></Provider>)
    expect(html).toContain('data-state="unchecked"')
    expect(html).toContain('正在检查内置 RTK')
    expect(html).toContain('无需额外安装')
    expect(html).not.toContain('重新检测')
    expect(html).not.toContain('官方安装说明')
    expect(html).toContain('disabled=""')
  })
  test('Given 已检测 When 保存失败 Then 保留原开关并显示可操作的错误', async () => {
    const updates: boolean[] = []
    globalThis.window = { electronAPI: {
      getSettings: async () => ({ agentRtkEnabled: false }),
      getRtkStatus: async () => status,
      updateSettings: async (input: { agentRtkEnabled: boolean }) => { updates.push(input.agentRtkEnabled); throw new Error('disk') },
    } } as unknown as Window & typeof globalThis
    const store = createStore()
    await store.set(loadRtkSettingsAtom)
    expect(store.get(rtkSettingsAtom).loaded).toBe(true)
    await store.set(setRtkEnabledAtom, true)
    expect(updates).toEqual([true])
    expect(store.get(rtkSettingsAtom)).toMatchObject({ enabled: false, busy: false, error: '保存失败，已保留原设置。' })
  })
  test('Given 本次运行统计 When 渲染 Then 明确估算口径与费用区别', () => {
    const store = createStore()
    store.set(rtkSettingsAtom, { enabled: true, loaded: true, busy: false, status })
    const html = renderToStaticMarkup(<Provider store={store}><RtkSettings /></Provider>)
    expect(html).toContain('本次应用运行')
    expect(html).toContain('50.0')
    expect(html).toContain('不代表会话总用量或实际费用')
    expect(html).toContain('data-state="checked"')
  })
})

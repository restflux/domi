import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { GeneralSettings } from './GeneralSettings.tsx'
import {
  contextCompactorSettingsReducer,
  loadContextCompactorEnabled,
  persistContextCompactorEnabled,
  type ContextCompactorSettingsState,
} from './ContextCompactorSettings.tsx'

const readyOffState: ContextCompactorSettingsState = {
  enabled: false,
  loading: false,
  saving: false,
}

describe('ContextCompactorSettings', () => {
  test('is integrated into General Settings as a visible default-off experimental toggle', () => {
    const html = renderToStaticMarkup(<GeneralSettings />)

    expect(html).toContain('实验功能')
    expect(html).toContain('上下文压缩增强（实验性）')
    expect(html).toContain('压缩质量和关键信息召回率')
    expect(html).toContain('开启后从下一次发送消息开始生效')
    expect(html).toContain('当前正在运行的任务不受影响')
    expect(html).toContain('data-state="unchecked"')
    expect(html).toContain('disabled=""')
  })

  test('loads only persisted enhance mode as enabled while keeping off and observe disabled', async () => {
    expect(await loadContextCompactorEnabled(async () => ({ agentContextCompactorMode: 'enhance' }))).toBe(true)
    expect(await loadContextCompactorEnabled(async () => ({ agentContextCompactorMode: 'off' }))).toBe(false)
    expect(await loadContextCompactorEnabled(async () => ({ agentContextCompactorMode: 'observe' }))).toBe(false)
  })

  test('persists enabled as enhance and disabled as off', async () => {
    const updates: Array<{ agentContextCompactorMode: 'off' | 'enhance' }> = []
    const updateSettings = async (update: { agentContextCompactorMode: 'off' | 'enhance' }) => {
      updates.push(update)
      return update
    }

    expect(await persistContextCompactorEnabled(true, updateSettings)).toBe(true)
    expect(await persistContextCompactorEnabled(false, updateSettings)).toBe(false)
    expect(updates).toEqual([
      { agentContextCompactorMode: 'enhance' },
      { agentContextCompactorMode: 'off' },
    ])
  })

  test('propagates failed settings writes and rolls optimistic state back', async () => {
    const savingState = contextCompactorSettingsReducer(readyOffState, {
      type: 'save_started',
      enabled: true,
    })

    expect(savingState).toEqual({ enabled: true, loading: false, saving: true })
    await expect(persistContextCompactorEnabled(true, async () => {
      throw new Error('disk locked')
    })).rejects.toThrow('disk locked')

    expect(contextCompactorSettingsReducer(savingState, {
      type: 'save_failed',
      previousEnabled: false,
    })).toEqual(readyOffState)
  })
})

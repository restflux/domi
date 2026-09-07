import { atom } from 'jotai'
import type { RtkStatus } from '@domi/shared'

interface RtkSettingsState {
  enabled: boolean
  loaded: boolean
  busy: boolean
  error?: string
  status: RtkStatus
}

export const rtkSettingsAtom = atom<RtkSettingsState>({
  enabled: false, loaded: false, busy: false,
  status: { availability: 'not-checked', optimizedCalls: 0, originalBytes: 0, returnedBytes: 0 },
})

export const loadRtkSettingsAtom = atom(null, async (get, set) => {
  if (get(rtkSettingsAtom).busy) return
  set(rtkSettingsAtom, previous => ({ ...previous, busy: true, error: undefined }))
  try {
    const [settings, status] = await Promise.all([
      window.electronAPI.getSettings(),
      window.electronAPI.getRtkStatus(),
    ])
    set(rtkSettingsAtom, { enabled: settings.agentRtkEnabled === true, status, loaded: true, busy: false })
  } catch {
    set(rtkSettingsAtom, previous => ({ ...previous, busy: false, error: '读取 RTK 状态失败，请重新打开此页面。' }))
  }
})

export const setRtkEnabledAtom = atom(null, async (get, set, enabled: boolean) => {
  const state = get(rtkSettingsAtom)
  if (state.busy || !state.loaded) return
  set(rtkSettingsAtom, { ...state, busy: true, error: undefined })
  try {
    const settings = await window.electronAPI.updateSettings({ agentRtkEnabled: enabled })
    set(rtkSettingsAtom, previous => ({ ...previous, enabled: settings.agentRtkEnabled === true, busy: false }))
  } catch {
    set(rtkSettingsAtom, previous => ({ ...previous, busy: false, error: '保存失败，已保留原设置。' }))
  }
})

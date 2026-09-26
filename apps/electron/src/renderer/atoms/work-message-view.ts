import { atom } from 'jotai'
import type { AppSettings } from '../../types'

export type WorkMessageView = NonNullable<AppSettings['workMessageView']>

/** 消息视图只影响 Work 的渲染，不改变会话内容或主题。 */
export const workMessageViewAtom = atom<WorkMessageView>('v1')

export async function saveWorkMessageView(view: WorkMessageView): Promise<void> {
  await window.electronAPI.updateSettings({ workMessageView: view })
}

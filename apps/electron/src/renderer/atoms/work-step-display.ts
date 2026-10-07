import { atom } from 'jotai'
import { toast } from 'sonner'
import { DEFAULT_WORK_STEP_DISPLAY, normalizeWorkStepDisplay, type WorkStepDisplay } from '../../types'

/** 只使用 settings.json 持久化，不另建浏览器缓存。 */
export const workStepDisplayAtom = atom<WorkStepDisplay>(DEFAULT_WORK_STEP_DISPLAY)

export async function initializeWorkStepDisplay(setDisplay: (display: WorkStepDisplay) => void): Promise<void> {
  try {
    const settings = await window.electronAPI.getSettings()
    setDisplay(normalizeWorkStepDisplay(settings.workStepDisplay))
  } catch (error) {
    console.error('[工作步骤] 读取设置失败:', error)
  }
}

/** 保存成功后更新默认密度；失败时保持当前偏好。 */
export async function updateWorkStepDisplay(
  display: WorkStepDisplay,
  setDisplay: (display: WorkStepDisplay) => void,
): Promise<void> {
  try {
    const settings = await window.electronAPI.updateSettings({ workStepDisplay: display })
    setDisplay(normalizeWorkStepDisplay(settings.workStepDisplay))
  } catch (error) {
    console.error('[工作步骤] 保存设置失败:', error)
    toast.error('保存工作步骤展示设置失败')
  }
}

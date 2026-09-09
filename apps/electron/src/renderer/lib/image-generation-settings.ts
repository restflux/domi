import type { ImageGenerationSelection } from '@domi/shared'
import type { AppSettings } from '@/types/settings'

/** 复用 settings.json 的按会话选择；不包含凭据，不改变聊天模型。 */
export type ImageGenerationSessionSettings = Pick<AppSettings, 'imageGenerationSelections'>

let saveQueue: Promise<unknown> = Promise.resolve()
export function persistImageSelection(scope: string, selection: ImageGenerationSelection | null): Promise<void> {
  const save = saveQueue.catch(() => undefined).then(async () => {
    const settings: AppSettings & ImageGenerationSessionSettings = await window.electronAPI.getSettings()
    const updates: Partial<AppSettings> & ImageGenerationSessionSettings = {
      imageGenerationSelections: { ...settings.imageGenerationSelections, [scope]: selection },
    }
    await window.electronAPI.updateSettings(updates)
  })
  saveQueue = save
  return save
}

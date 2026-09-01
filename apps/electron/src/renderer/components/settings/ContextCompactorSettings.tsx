import * as React from 'react'
import { FlaskConical } from 'lucide-react'
import { toast } from 'sonner'
import type { AppSettings } from '../../../types/settings'
import { SettingsCard, SettingsSection, SettingsToggle } from './primitives'

type ContextCompactorMode = NonNullable<AppSettings['agentContextCompactorMode']>
type ContextCompactorSettingsSnapshot = Pick<AppSettings, 'agentContextCompactorMode'>
type ContextCompactorSettingsUpdate = { agentContextCompactorMode: Extract<ContextCompactorMode, 'off' | 'enhance'> }

type GetSettings = () => Promise<ContextCompactorSettingsSnapshot>
type UpdateSettings = (update: ContextCompactorSettingsUpdate) => Promise<ContextCompactorSettingsSnapshot>

export interface ContextCompactorSettingsState {
  enabled: boolean
  loading: boolean
  saving: boolean
}

type ContextCompactorSettingsAction =
  | { type: 'load_succeeded'; enabled: boolean }
  | { type: 'load_failed' }
  | { type: 'save_started'; enabled: boolean }
  | { type: 'save_succeeded'; enabled: boolean }
  | { type: 'save_failed'; previousEnabled: boolean }

const INITIAL_STATE: ContextCompactorSettingsState = {
  enabled: false,
  loading: true,
  saving: false,
}

export function contextCompactorSettingsReducer(
  state: ContextCompactorSettingsState,
  action: ContextCompactorSettingsAction,
): ContextCompactorSettingsState {
  switch (action.type) {
    case 'load_succeeded':
      return { enabled: action.enabled, loading: false, saving: false }
    case 'load_failed':
      return { ...state, loading: false }
    case 'save_started':
      return { ...state, enabled: action.enabled, saving: true }
    case 'save_succeeded':
      return { ...state, enabled: action.enabled, saving: false }
    case 'save_failed':
      return { ...state, enabled: action.previousEnabled, saving: false }
  }
}

export async function loadContextCompactorEnabled(getSettings: GetSettings): Promise<boolean> {
  const settings = await getSettings()
  return settings.agentContextCompactorMode === 'enhance'
}

export async function persistContextCompactorEnabled(
  enabled: boolean,
  updateSettings: UpdateSettings,
): Promise<boolean> {
  const saved = await updateSettings({
    agentContextCompactorMode: enabled ? 'enhance' : 'off',
  })
  return saved.agentContextCompactorMode === 'enhance'
}

interface ContextCompactorSettingsProps {
  getSettings?: GetSettings
  updateSettings?: UpdateSettings
}

export function ContextCompactorSettings({
  getSettings,
  updateSettings,
}: ContextCompactorSettingsProps = {}): React.ReactElement {
  const [state, dispatch] = React.useReducer(contextCompactorSettingsReducer, INITIAL_STATE)

  const readSettings = React.useMemo<GetSettings>(
    () => getSettings ?? (() => window.electronAPI.getSettings()),
    [getSettings],
  )
  const writeSettings = React.useMemo<UpdateSettings>(
    () => updateSettings ?? ((update) => window.electronAPI.updateSettings(update)),
    [updateSettings],
  )

  React.useEffect(() => {
    let active = true
    void loadContextCompactorEnabled(readSettings)
      .then((enabled) => {
        if (active) dispatch({ type: 'load_succeeded', enabled })
      })
      .catch((error) => {
        console.error('[通用设置] 加载上下文压缩增强设置失败:', error)
        if (active) {
          dispatch({ type: 'load_failed' })
          toast.error('加载上下文压缩增强设置失败')
        }
      })
    return () => {
      active = false
    }
  }, [readSettings])

  const handleEnabledChange = React.useCallback(async (enabled: boolean): Promise<void> => {
    const previousEnabled = state.enabled
    dispatch({ type: 'save_started', enabled })
    try {
      const savedEnabled = await persistContextCompactorEnabled(enabled, writeSettings)
      dispatch({ type: 'save_succeeded', enabled: savedEnabled })
    } catch (error) {
      console.error('[通用设置] 保存上下文压缩增强设置失败:', error)
      dispatch({ type: 'save_failed', previousEnabled })
      toast.error('保存上下文压缩增强设置失败')
    }
  }, [state.enabled, writeSettings])

  return (
    <SettingsSection
      title={(
        <span className="inline-flex items-center gap-2">
          <FlaskConical className="size-4 text-violet-500" />
          实验功能
          <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-600 dark:text-violet-300">
            Experimental
          </span>
        </span>
      )}
      description="可选启用仍在验证中的 Agent 能力；所有实验功能默认关闭。"
    >
      <SettingsCard>
        <SettingsToggle
          label="上下文压缩增强（实验性）"
          description="提升长对话的压缩质量和关键信息召回率，更好地保留你的要求、纠正、任务进度与验证结果，减少压缩后的遗忘和跑偏。开启后从下一次发送消息开始生效，当前正在运行的任务不受影响。"
          checked={state.enabled}
          disabled={state.loading || state.saving}
          onCheckedChange={(enabled) => {
            void handleEnabledChange(enabled)
          }}
        />
      </SettingsCard>
    </SettingsSection>
  )
}

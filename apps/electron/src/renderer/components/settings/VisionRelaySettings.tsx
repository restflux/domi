import * as React from 'react'
import { Eye, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import type { ModelOption } from '@domi/shared'
import type { VisionRelayQualityPreset, VisionRelaySettings as VisionRelaySettingsValue } from '../../../types'
import { ModelSelector } from '@/components/chat/ModelSelector'
import { Button } from '@/components/ui/button'
import { SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsToggle } from './primitives'

const DEFAULT_SETTINGS: VisionRelaySettingsValue = { enabled: false, qualityPreset: 'balanced' }
const QUALITY_OPTIONS = [
  { value: 'fast', label: '快速 · 简单查看与 OCR' },
  { value: 'balanced', label: '均衡 · Logo、App 与一般界面（推荐）' },
  { value: 'accurate', label: '精细 · 复杂界面、代码与图表' },
]

function modelKey(channelId: string, modelId: string): string {
  return `${channelId}\u0000${modelId}`
}

export function VisionRelaySettings(): React.ReactElement {
  const [settings, setSettings] = React.useState<VisionRelaySettingsValue>(DEFAULT_SETTINGS)
  const [models, setModels] = React.useState<ModelOption[]>([])
  const [loading, setLoading] = React.useState(true)
  const [saving, setSaving] = React.useState(false)

  const refreshModels = React.useCallback(async () => {
    setLoading(true)
    try {
      setModels(await window.electronAPI.listVisionRelayModels())
    } catch (error) {
      console.error('[视觉助手设置] 加载视觉模型失败:', error)
      toast.error('加载可用视觉模型失败')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    Promise.all([window.electronAPI.getSettings(), window.electronAPI.listVisionRelayModels()])
      .then(([appSettings, options]) => {
        setSettings(appSettings.visionRelay ?? DEFAULT_SETTINGS)
        setModels(options)
      })
      .catch((error) => {
        console.error('[视觉助手设置] 加载失败:', error)
        toast.error('加载视觉助手设置失败')
      })
      .finally(() => setLoading(false))
  }, [])

  const save = React.useCallback(async (next: VisionRelaySettingsValue) => {
    const previous = settings
    setSettings(next)
    setSaving(true)
    try {
      const saved = await window.electronAPI.updateSettings({ visionRelay: next })
      setSettings(saved.visionRelay ?? DEFAULT_SETTINGS)
    } catch (error) {
      console.error('[视觉助手设置] 保存失败:', error)
      setSettings(previous)
      toast.error('保存视觉助手设置失败')
    } finally {
      setSaving(false)
    }
  }, [settings])

  const selectedModel = settings.channelId && settings.modelId
    ? { channelId: settings.channelId, modelId: settings.modelId }
    : null
  const allowedModelKeys = React.useMemo(
    () => models.map((model) => modelKey(model.channelId, model.modelId)),
    [models],
  )
  const selectedIsEligible = !!selectedModel && allowedModelKeys.includes(modelKey(selectedModel.channelId, selectedModel.modelId))

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在加载视觉助手...</div>
  }

  return (
    <div className="space-y-8">
      <SettingsSection
        title="视觉助手"
        description="让 Pi catalog 明确标记为纯文本的模型，在需要时调用独立视觉模型理解单张图片。"
        action={
          <Button variant="outline" size="sm" onClick={() => void refreshModels()} disabled={loading || saving}>
            <RefreshCw className="mr-1.5 size-3.5" />刷新可用模型
          </Button>
        }
      >
        <SettingsCard>
          <SettingsToggle
            label="启用视觉助手"
            description={selectedIsEligible
              ? '启用即授权该视觉路由：纯文本模型可直接用它理解图片，会话内不再弹窗确认。'
              : '请先选择一个 Pi catalog 明确认定支持图片输入的模型。'}
            checked={settings.enabled}
            disabled={saving || !selectedIsEligible}
            onCheckedChange={(enabled) => void save({ ...settings, enabled })}
          />
          <SettingsSelect
            label="分析质量"
            description="只影响视觉分析的质量、延迟和消耗，不会扩大图片范围、自动重试或联网识图。"
            value={settings.qualityPreset}
            options={QUALITY_OPTIONS}
            disabled={saving}
            onValueChange={(value) => void save({ ...settings, qualityPreset: value as VisionRelayQualityPreset })}
          />
          <SettingsRow
            label="视觉模型"
            icon={<Eye className="size-4 text-violet-500" />}
            description={models.length > 0
              ? '支持普通 API 与订阅渠道；执行时主进程会再次校验渠道、模型和图片能力。'
              : '当前没有已启用且被 catalog 确认支持图片输入的模型。'}
          >
            <ModelSelector
              externalSelectedModel={selectedModel}
              allowedModelKeys={allowedModelKeys}
              showChannelInTrigger
              onModelSelect={(model) => void save({
                enabled: settings.enabled,
                channelId: model.channelId,
                modelId: model.modelId,
                qualityPreset: settings.qualityPreset,
              })}
            />
          </SettingsRow>
        </SettingsCard>
        {selectedModel && !selectedIsEligible && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
            已保存的视觉模型不再可用或不再被 catalog 确认支持图片。视觉助手已安全停用，请重新选择。
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="隐私与安全边界" description="视觉中继默认关闭，并遵循最小外发原则。">
        <SettingsCard>
          <SettingsRow
            label="设置级授权"
            icon={<ShieldCheck className="size-4 text-emerald-500" />}
            description="在设置中启用并选择视觉模型即完成授权，会话内不再弹窗确认；切换视觉模型或重新启用后按新路由生效。图片仅可来自当前 Session Target、会话附件缓存或用户显式附加的文件/目录。"
          />
          <SettingsRow
            label="安全图片处理"
            description="支持 PNG、JPEG、GIF、WebP，单张不超过 10MB。自动修正照片方向；透明 PNG 合成中性背景；其他格式静态化为 JPEG；元数据不会发送。"
          />
          <SettingsRow
            label="质量风险提示"
            description="超长截图、低分辨率和动画首帧会在结果中明确提示。视觉助手不会自动重试；需要时请裁剪问题区域或选择精细模式。"
          />
          <SettingsRow
            label="不可信视觉结果"
            description="图片、OCR 和视觉模型返回内容只作为观察证据，不会被视为 Agent 指令。Automation、远程触发和协作子 Agent 首期不可使用。"
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

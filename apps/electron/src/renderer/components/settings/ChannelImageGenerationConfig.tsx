import * as React from 'react'
import { Plus, X, ChevronDown } from 'lucide-react'
import { IMAGE_GENERATION_PRESETS, type ImageGenerationChannelConfig, type ImageGenerationProtocol } from '@domi/shared'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { ImageOptionSelect } from '../ai-elements/ImageOptionSelect'
import { SettingsSection, SettingsCard } from './primitives'

export function ChannelImageGenerationConfig({ value, onChange, provider }: { value: ImageGenerationChannelConfig | null; onChange: (value: ImageGenerationChannelConfig | null) => void; provider: string }): React.ReactElement | null {
  const [draft, setDraft] = React.useState('')
  const [showAddress, setShowAddress] = React.useState(false)
  const inputId = React.useId()
  if (!['openai', 'openai-responses', 'google', 'custom'].includes(provider)) return null
  const addModel = (model: string): void => {
    const id = model.trim()
    if (!value || !id || value.models.includes(id)) return
    onChange({ ...value, models: [...value.models, id] })
    setDraft('')
  }
  const addressRequired = provider === 'custom'
  return (
    <SettingsSection title="图片生成" description="使用此渠道的 API Key 生成图片，也可仅配置生图模型。">
      <SettingsCard divided={false}>
        <div className="space-y-5 p-4">
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm font-medium">启用图片生成</span>
            <Switch aria-label="启用图片生成" checked={value !== null} onCheckedChange={(checked) => {
              const protocol = provider === 'google' ? 'gemini' : 'openai-images'
              onChange(checked ? { protocol, models: [IMAGE_GENERATION_PRESETS[protocol][0]!] } : null)
            }} />
          </div>
          {value && <>
            <div className="max-w-xs">
              <ImageOptionSelect label="接口协议" value={value.protocol}
                options={[{ value: 'openai-images', label: 'OpenAI Images' }, { value: 'gemini', label: 'Gemini' }]}
                onChange={(raw) => { const protocol = raw as ImageGenerationProtocol; setDraft(''); onChange({ ...value, protocol, models: [IMAGE_GENERATION_PRESETS[protocol][0]!] }) }} />
            </div>
            <div className="space-y-2.5">
              <span className="text-xs text-muted-foreground">生图模型</span>
              <div className="flex flex-wrap gap-2">
                {value.models.map((model) => <span key={model} className="inline-flex max-w-full items-center gap-1 rounded-lg bg-primary/10 py-1 pl-2.5 pr-1 text-xs text-primary">
                  <span className="truncate" title={model}>{model}</span>
                  <Button type="button" variant="ghost" size="icon" className="size-6 shrink-0 hover:bg-primary/10" aria-label={`移除模型 ${model}`} onClick={() => onChange({ ...value, models: value.models.filter((id) => id !== model) })}><X className="size-3" /></Button>
                </span>)}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {IMAGE_GENERATION_PRESETS[value.protocol].filter((id) => !value.models.includes(id)).map((model) => <Button type="button" key={model} variant="ghost" size="sm" className="h-7 max-w-full text-xs text-muted-foreground" onClick={() => addModel(model)}><Plus className="mr-1 size-3 shrink-0" /><span className="truncate">{model}</span></Button>)}
              </div>
              <div className="flex max-w-md gap-2">
                <Input aria-label="自定义生图模型 ID" value={draft} placeholder="输入自定义模型 ID" className="h-8 min-w-0 text-xs" onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addModel(draft) } }} />
                <Button type="button" variant="secondary" size="sm" className="h-8 shrink-0 text-xs" disabled={!draft.trim() || value.models.includes(draft.trim())} onClick={() => addModel(draft)}>添加模型</Button>
              </div>
            </div>
            {addressRequired || showAddress || value.baseUrl ? <div className="max-w-md space-y-1.5">
              <label htmlFor={inputId} className="text-xs text-muted-foreground">图片接口根地址{addressRequired ? '（必填）' : '（可选）'}</label>
              <Input id={inputId} value={value.baseUrl ?? ''} placeholder={addressRequired ? 'https://example.com/v1' : '留空使用渠道地址'} className="h-9 text-xs" onChange={(event) => onChange({ ...value, baseUrl: event.target.value || undefined })} />
            </div> : <Button type="button" variant="ghost" size="sm" className="h-7 px-0 text-xs text-muted-foreground" onClick={() => setShowAddress(true)}><ChevronDown className="mr-1 size-3" />使用独立图片接口地址</Button>}
          </>}
        </div>
      </SettingsCard>
    </SettingsSection>
  )
}

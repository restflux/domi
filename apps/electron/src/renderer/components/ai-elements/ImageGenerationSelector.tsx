import * as React from 'react'
import { atom, useAtom, useAtomValue, useSetAtom } from 'jotai'
import { ImagePlus, X } from 'lucide-react'
import { ImageOptionSelect } from './ImageOptionSelect'
import { inputToolbarButtonClass } from './input-toolbar-styles'
import { toast } from 'sonner'
import { getImageGenerationQualities, type ImageGenerationSelection } from '@domi/shared'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { imageGenerationChannelsAtom, imageGenerationDefaultAtom, imageGenerationSelectionsAtom, getImageChannels, resolveImageSelection, resolveDisplayedImageSelection, parseImageCommand } from '@/atoms/image-generation-atoms'

import { persistImageSelection, type ImageGenerationSessionSettings } from '@/lib/image-generation-settings'

export const openImageScopeAtom = atom<string | null>(null)
const imageCommandSeenAtom = atom<Record<string, boolean>>({})
const labels: Record<string, string> = { auto: '自动', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高', '1024x1024': '方形 · 1:1', '1536x1024': '横向 · 3:2', '1024x1536': '纵向 · 2:3' }
const optionsFor = (values: readonly string[]) => values.map((value) => ({ value, label: labels[value] ?? value }))

/** 已在当前会话显式选择后才显示的快捷入口；配置弹层始终锚定在加号旁。 */
export function ImageGenerationButton({ scope }: { scope: string }): React.ReactElement {
  const selection = useAtomValue(imageGenerationSelectionsAtom)[scope]
  const channels = useAtomValue(imageGenerationChannelsAtom)
  const setOpenScope = useSetAtom(openImageScopeAtom)
  const channel = channels.find((item) => item.id === selection?.channelId)
  return <Button type="button" variant="ghost" size="icon" aria-label="调整生图参数" aria-pressed
    title={`${selection?.modelId ?? '图片生成'} · ${channel?.name ?? '渠道不可用'}`}
    className={`${inputToolbarButtonClass} bg-primary/10 text-primary hover:bg-primary/15`}
    onClick={() => setOpenScope(scope)}><ImagePlus className="size-4" /></Button>
}

export function ImageGenerationSelector({ scope, defaultSettings = false, inputText, hideTrigger = false }: { scope: string; defaultSettings?: boolean; inputText?: string; hideTrigger?: boolean }): React.ReactElement {
  const [channels, setChannels] = useAtom(imageGenerationChannelsAtom)
  const [defaults, setDefaults] = useAtom(imageGenerationDefaultAtom)
  const [selections, setSelections] = useAtom(imageGenerationSelectionsAtom)
  const [openScope, setOpenScope] = useAtom(openImageScopeAtom)
  const [loaded, setLoaded] = React.useState(false)
  const open = openScope === scope
  const setOpen = (value: boolean): void => setOpenScope(value ? scope : null)
  const selection = defaultSettings ? defaults : resolveDisplayedImageSelection(channels, selections[scope], defaults)
  React.useEffect(() => {
    let active = true
    void Promise.all([window.electronAPI.listChannels(), window.electronAPI.getSettings()]).then(([list, settings]) => {
      if (!active) return
      setChannels(list)
      setDefaults(settings.imageGeneration ?? null)
      const saved = (settings as typeof settings & ImageGenerationSessionSettings).imageGenerationSelections
      if (saved) setSelections((current) => ({ ...saved, ...current }))
      setLoaded(true)
    }).catch(() => toast.error('无法加载图片生成配置'))
    return () => { active = false }
  }, [setChannels, setDefaults, setSelections, open])
  const commandActive = parseImageCommand(inputText ?? '').requested
  const [commandSeen, setCommandSeen] = useAtom(imageCommandSeenAtom)
  React.useEffect(() => {
    if (!commandActive) {
      if (commandSeen[scope]) setCommandSeen((current) => ({ ...current, [scope]: false }))
      return
    }
    if (!loaded || commandSeen[scope]) return
    setCommandSeen((current) => ({ ...current, [scope]: true }))
    const preferred = selections[scope] ?? defaults
    const next = resolveImageSelection(channels, preferred)
    if (next) {
      setSelections((current) => ({ ...current, [scope]: next }))
      void persistImageSelection(scope, next).catch(() => toast.error('生图选择保存失败'))
    }
    setOpenScope(scope)
  }, [commandActive, loaded, scope, channels, defaults, selections, setSelections, commandSeen, setCommandSeen, setOpenScope])
  const eligible = getImageChannels(channels)
  const channel = eligible.find((item) => item.id === selection?.channelId)
  const update = (next: ImageGenerationSelection | null): void => {
    if (defaultSettings) {
      void window.electronAPI.updateSettings({ imageGeneration: next }).then(() => setDefaults(next)).catch(() => toast.error('图片生成设置保存失败'))
    } else {
      setSelections((prev) => ({ ...prev, [scope]: next }))
      void persistImageSelection(scope, next).catch(() => toast.error('生图选择保存失败'))
    }
  }
  const patch = (value: Partial<ImageGenerationSelection>): void => { if (selection) update({ ...selection, ...value }) }
  const fields = (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium"><ImagePlus className="size-4 text-primary" />图片生成</div>
        {!defaultSettings && <Button type="button" variant="ghost" size="icon" className="size-7" aria-label="收起生图面板" onClick={() => setOpen(false)}><X className="size-3.5" /></Button>}
      </div>
      {eligible.length === 0 ? <p className="text-xs leading-relaxed text-muted-foreground">暂无可用生图模型，请先在渠道设置中启用图片生成。</p> : (
        <>
          <ImageOptionSelect label="模型" value={selection ? JSON.stringify([selection.channelId, selection.modelId]) : ''}
            placeholder="选择生图模型"
            options={eligible.flatMap((item) => item.imageGeneration!.models.map((model) => ({ value: JSON.stringify([item.id, model]), label: model, description: item.name })))}
            onChange={(value) => { const [channelId, modelId] = JSON.parse(value) as [string, string]; update({ channelId, modelId }) }} />
          {selection && <>
            <p className="-mt-2 truncate text-[11px] text-muted-foreground">{channel?.name ?? '所选渠道不可用，请重新选择'}</p>
            <div className="grid grid-cols-2 gap-3">
              {channel?.imageGeneration?.protocol === 'gemini' ? <>
                <ImageOptionSelect label="比例" value={selection.aspectRatio ?? 'auto'} options={optionsFor(['auto', '1:1', '16:9', '9:16', '3:2', '2:3'])} onChange={(value) => patch({ aspectRatio: value as ImageGenerationSelection['aspectRatio'] })} />
                <ImageOptionSelect label="分辨率" value={selection.imageSize ?? 'auto'} options={optionsFor(['auto', '1K', '2K', '4K'])} onChange={(value) => patch({ imageSize: value as ImageGenerationSelection['imageSize'] })} />
              </> : <>
                <ImageOptionSelect label="尺寸" value={selection.size ?? 'auto'} options={optionsFor(['auto', '1024x1024', '1536x1024', '1024x1536'])} onChange={(value) => patch({ size: value as ImageGenerationSelection['size'] })} />
                <ImageOptionSelect label="质量" value={selection.quality ?? 'auto'} options={optionsFor(getImageGenerationQualities(selection.modelId))} onChange={(value) => patch({ quality: value as ImageGenerationSelection['quality'] })} />
              </>}
            </div>
            <div className="flex items-end justify-between gap-3">
              <div className="w-24"><ImageOptionSelect label="数量" value={String(selection.numberOfImages ?? 1)} options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: `${n} 张` }))} onChange={(value) => patch({ numberOfImages: Number(value) })} /></div>
              <Button type="button" variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => { update(null); setOpen(false) }}>{defaultSettings ? '清除默认选择' : '退出生图'}</Button>
            </div>
          </>}
        </>
      )}
    </div>
  )
  if (defaultSettings) return <div className="max-w-sm">{fields}</div>
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon"
          aria-label={hideTrigger ? undefined : selection ? '调整生图参数' : '图片生成'}
          aria-hidden={hideTrigger || undefined} tabIndex={hideTrigger ? -1 : undefined} aria-pressed={hideTrigger ? undefined : Boolean(selection)}
          title={hideTrigger ? undefined : selection ? `${selection.modelId} · ${channel?.name ?? '渠道不可用'}` : '图片生成'}
          className={hideTrigger ? 'pointer-events-none size-0 overflow-hidden p-0 opacity-0' : `${inputToolbarButtonClass} ${selection ? 'bg-primary/10 text-primary hover:bg-primary/15' : ''}`}>
          {!hideTrigger && <ImagePlus className="size-4" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="z-[110] w-72 max-w-[calc(100vw-2rem)] rounded-xl p-4 shadow-xl">{fields}</PopoverContent>
    </Popover>
  )
}

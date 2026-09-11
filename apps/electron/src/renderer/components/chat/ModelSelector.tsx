import { BrandLogo } from '@/components/ui/brand-logo'
/** 按渠道折叠的模型选择浮层；主聊天、Work 与侧聊共享展示，选择状态由调用方管理。 */

import * as React from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { Check, ChevronDown, Cpu, Search } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  conversationsAtom,
  selectedModelAtom,
  channelsAtom,
  channelsLoadedAtom,
  modelSelectorOpenAtom,
} from '@/atoms/chat-atoms'
import { useConversationModelOptional } from '@/hooks/useConversationSettings'
import { useConversationIdOptional } from '@/contexts/session-context'
import { getModelLogo, getChannelLogo, DefaultLogo } from '@/lib/model-logo'
import { handleOptionalDialogCloseAutoFocus } from '@/lib/dialog-focus'
import { cn } from '@/lib/utils'
import type { ModelOption, ProviderType } from '@domi/shared'
import { ChannelPlanQuotaBadge } from './ChannelPlanQuotaBadge'

import { buildModelOptions, groupByChannel, getModelPickerGroups, nextModelHighlight } from './model-selector-options'
export { buildModelOptions } from './model-selector-options'

/** ModelSelector 可选属性 */
interface ModelSelectorProps {
  /** 仅显示此渠道的模型 */
  filterChannelId?: string
  /** 仅显示这些渠道的模型（多渠道过滤） */
  filterChannelIds?: string[]
  /** 外部选中模型（不传则用内部 selectedModelAtom） */
  externalSelectedModel?: { channelId: string; modelId: string } | null
  /** 外部选择回调 */
  onModelSelect?: (option: ModelOption) => void
  /** 触发按钮是否显示「渠道 · 模型」（默认只显示模型名） */
  showChannelInTrigger?: boolean
  /** 不在此选择器中显示的供应商（例如 Chat 暂不支持的协议） */
  excludedProviders?: readonly ProviderType[]
  /** 可选的精确 channel/model 白名单，键格式为 `${channelId}\\0${modelId}`。 */
  allowedModelKeys?: readonly string[]
  /** 是否使用全局 modelSelectorOpenAtom 控制打开状态（用于外部拉起，如错误提示按钮） */
  useSharedOpenState?: boolean
  /** Work 可将模型行作为触发器，在父卡片附近打开独立列表。 */
  trigger?: React.ReactElement
  side?: React.ComponentProps<typeof PopoverContent>['side']
  align?: React.ComponentProps<typeof PopoverContent>['align']
  /**浮层任意关闭路径完成后恢复指定焦点；未传时保留 Radix 默认行为。 */
  restoreFocusOnClose?: () => void
}

export function ModelSelector({
  filterChannelId,
  filterChannelIds,
  externalSelectedModel,
  onModelSelect,
  showChannelInTrigger = false,
  excludedProviders,
  allowedModelKeys,
  useSharedOpenState = false,
  trigger,
  side = 'top',
  align = 'end',
  restoreFocusOnClose,
}: ModelSelectorProps = {}): React.ReactElement {
  const [conversationModel, setConversationModel] = useConversationModelOptional()
  const conversationId = useConversationIdOptional()
  const setConversations = useSetAtom(conversationsAtom)
  const setGlobalModel = useSetAtom(selectedModelAtom)
  const channels = useAtomValue(channelsAtom)
  const channelsLoaded = useAtomValue(channelsLoadedAtom)
  const setChannels = useSetAtom(channelsAtom)
  const [localOpen, setLocalOpen] = React.useState(false)
  const [sharedOpen, setSharedOpen] = useAtom(modelSelectorOpenAtom)
  const open = useSharedOpenState ? sharedOpen : localOpen
  const setOpen = useSharedOpenState ? setSharedOpen : setLocalOpen
  const [search, setSearch] = React.useState('')
  const [expandedChannel, setExpandedChannel] = React.useState<string | null>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)

  // 外部模型优先 → per-conversation 模型
  const selectedModel = externalSelectedModel !== undefined ? externalSelectedModel : conversationModel

  // 每次打开浮层时刷新渠道列表，确保最新
  React.useEffect(() => {
    if (open) {
      window.electronAPI.listChannels().then(setChannels).catch(console.error)
      setSearch('')
      setExpandedChannel(selectedModel?.channelId ?? null)
    }
  }, [open, setChannels])

  const modelOptions = React.useMemo(
    () => buildModelOptions(channels, filterChannelId, filterChannelIds, excludedProviders, allowedModelKeys),
    [channels, filterChannelId, filterChannelIds, excludedProviders, allowedModelKeys],
  )
  const grouped = React.useMemo(() => groupByChannel(modelOptions), [modelOptions])

  const { groups: filteredGrouped, visibleOptions: flatOptions } = React.useMemo(
    () => getModelPickerGroups(grouped, search, expandedChannel),
    [grouped, search, expandedChannel],
  )

  // 键盘高亮索引
  const [highlightIndex, setHighlightIndex] = React.useState(-1)
  const itemRefs = React.useRef<Map<number, HTMLButtonElement>>(new Map())

  // 搜索变化时重置高亮
  React.useEffect(() => {
    setHighlightIndex(-1)
  }, [search, expandedChannel, open])

  // 高亮项变化时滚动到可见区域
  React.useEffect(() => {
    if (highlightIndex < 0) return
    const el = itemRefs.current.get(highlightIndex)
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  // 打开浮层后是否已自动滚动到当前选中项（仅首次，避免搜索过滤时反复滚动）
  const didAutoScrollRef = React.useRef(false)

  // 打开浮层时重置自动滚动标记
  React.useEffect(() => {
    if (open) didAutoScrollRef.current = false
  }, [open])

  // 模型列表就绪后，自动滚动到当前选中的模型（channels 为异步刷新，依赖 flatOptions 等待就绪）
  React.useEffect(() => {
    if (!open || search.trim() || didAutoScrollRef.current || !selectedModel) return
    if (flatOptions.length === 0) return

    const index = flatOptions.findIndex(
      (o) => o.channelId === selectedModel.channelId && o.modelId === selectedModel.modelId
    )
    if (index < 0) return

    didAutoScrollRef.current = true
    // 下一帧再滚动，确保浮层内容完成挂载
    const raf = requestAnimationFrame(() => {
      setHighlightIndex(index)
      itemRefs.current.get(index)?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(raf)
  }, [open, flatOptions, selectedModel, search])

  // 查找当前选中的模型信息
  const currentModelInfo = React.useMemo(() => {
    if (!selectedModel) return null
    return modelOptions.find(
      (o) => o.channelId === selectedModel.channelId && o.modelId === selectedModel.modelId
    ) ?? null
  }, [selectedModel, modelOptions])

  // 保持上次有效的模型信息，避免渠道未加载时闪烁"选择模型"
  const stableModelInfoRef = React.useRef(currentModelInfo)
  if (currentModelInfo) stableModelInfoRef.current = currentModelInfo
  const displayModelInfo = currentModelInfo ?? stableModelInfoRef.current

  /** 选择模型并持久化到当前对话 */
  const handleSelect = (option: ModelOption): void => {
    if (onModelSelect) {
      onModelSelect(option)
      setOpen(false)
      return
    }

    // Chat 模式：写入 per-conversation Map + 同步全局默认值
    if (setConversationModel) {
      setConversationModel({ channelId: option.channelId, modelId: option.modelId })
    }
    setGlobalModel({ channelId: option.channelId, modelId: option.modelId })
    setOpen(false)

    // 将模型/渠道选择保存到当前对话元数据
    if (conversationId) {
      window.electronAPI
        .updateConversationModel(conversationId, option.modelId, option.channelId)
        .then((updated) => {
          setConversations((prev) =>
            prev.map((c) => (c.id === updated.id ? updated : c))
          )
        })
        .catch(console.error)
    }
  }

  /** 搜索框键盘导航 */
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing || flatOptions.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightIndex((prev) => nextModelHighlight(prev, flatOptions.length, 'down'))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightIndex((prev) => nextModelHighlight(prev, flatOptions.length, 'up'))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = flatOptions[highlightIndex >= 0 ? highlightIndex : 0]
      if (target) handleSelect(target)
    }
  }

  if (channelsLoaded && modelOptions.length === 0 && !trigger) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground px-2 py-1">
        <Cpu className="size-3.5" />
        <span>暂无可用模型</span>
      </div>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* 自定义触发器也保持为独立 Popover，关闭列表不关闭父设置卡片。 */}
      {trigger ? (
        <Tooltip open={open || !displayModelInfo ? false : undefined}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">渠道：{displayModelInfo?.channelName}</TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip open={open || !displayModelInfo ? false : undefined}>
          <TooltipTrigger asChild><PopoverTrigger asChild>
            <button
              type="button"
              className="model-selector-trigger flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              {displayModelInfo ? (
                <BrandLogo
                  src={getModelLogo(displayModelInfo.modelId, displayModelInfo.provider)}
                  alt={displayModelInfo.modelName}
                  className="size-4 rounded object-cover"
                />
              ) : (
                <Cpu className="size-3.5" />
              )}
              <span className="max-w-[200px] truncate">
                {displayModelInfo
                  ? (showChannelInTrigger ? `${displayModelInfo.channelName} · ${displayModelInfo.modelName}` : displayModelInfo.modelName)
                  : '选择模型'}
              </span>
              <ChevronDown className="size-3" />
            </button>
          </PopoverTrigger></TooltipTrigger>
          <TooltipContent side="top">渠道：{displayModelInfo?.channelName}</TooltipContent>
        </Tooltip>
      )}

      {/* 模型选择浮层*/}
        <PopoverContent
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          aria-label="选择模型"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            searchRef.current?.focus()
          }}
          className="p-0 w-[360px] max-w-[min(calc(100vw-24px),var(--radix-popover-content-available-width))] max-h-[var(--radix-popover-content-available-height)] flex flex-col overflow-hidden"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            handleOptionalDialogCloseAutoFocus(event, restoreFocusOnClose)
          }}
        >
          {/* 搜索栏 */}
          <div className="flex shrink-0 items-center gap-2.5 px-4 py-3 border-b border-border/60">
            <Search className="size-5 text-muted-foreground/60 flex-shrink-0" />
            <input
              ref={searchRef}
              aria-label="搜索模型"
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                if (!e.target.value.trim()) setExpandedChannel(selectedModel?.channelId ?? null)
              }}
              onKeyDown={handleSearchKeyDown}
              placeholder="搜索模型..."
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
              autoFocus
            />
          </div>

          {/* 模型列表 */}
          <div className="min-h-0 max-h-[360px] overflow-y-auto scrollbar-thin">
            {filteredGrouped.size === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                未找到模型
              </div>
            ) : (
              (() => {
                let flatIndex = 0
                return Array.from(filteredGrouped.entries()).map(([channelId, options]) => {
                const first = options[0]
                if (!first) return null
                const expanded = Boolean(search.trim()) || channelId === expandedChannel
                const channel = channels.find((c) => c.id === channelId)

                return (
                  <div key={channelId}>
                    {/* 渠道标题保持可见，避免同名模型失去归属信息。 */}
                    <div className="sticky top-0 z-10 flex items-center bg-popover">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-disabled={Boolean(search.trim())}
                      onClick={() => {
                        if (!search.trim()) setExpandedChannel(expandedChannel === channelId ? null : channelId)
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left hover:bg-accent"
                    >
                      <BrandLogo
                        src={channel ? getChannelLogo(channel) : DefaultLogo}
                        alt={first.channelName}
                        className="size-5 rounded object-cover"
                      />
                      <span className="min-w-0 truncate text-sm font-medium text-muted-foreground">
                        {first.channelName}
                      </span>
                      <span className="ml-auto text-xs text-muted-foreground">{options.length}</span>
                      <ChevronDown className={cn("size-3 shrink-0", !expanded && "-rotate-90")} />
                    </button>
                      {channel ? <ChannelPlanQuotaBadge channel={channel} /> : null}
                    </div>

                    {/* 该渠道下的模型列表 */}
                    {expanded && options.map((option) => {
                      const isSelected =
                        selectedModel?.channelId === option.channelId &&
                        selectedModel?.modelId === option.modelId
                      const currentFlatIndex = flatIndex++
                      const isHighlighted = currentFlatIndex === highlightIndex

                      return (
                        <button
                          key={`${option.channelId}:${option.modelId}`}
                          ref={(el) => {
                            if (el) itemRefs.current.set(currentFlatIndex, el)
                            else itemRefs.current.delete(currentFlatIndex)
                          }}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => handleSelect(option)}
                          onPointerMove={() => setHighlightIndex(-1)}
                          onPointerLeave={() => setHighlightIndex(-1)}
                          className={cn(
                            'scroll-mt-10 flex items-center gap-3 w-[calc(100%-1rem)] px-4 py-1.5 mx-2 rounded-lg text-left transition-colors',
                            'hover:bg-accent',
                            isHighlighted && 'bg-accent',
                            isSelected && 'bg-foreground/10'
                          )}
                        >
                          <BrandLogo
                            src={getModelLogo(option.modelId, option.provider)}
                            alt={option.modelName}
                            className="size-5 rounded object-cover flex-shrink-0"
                          />
                          <span className={cn(
                            'flex-1 text-sm truncate',
                            isSelected ? 'font-medium text-foreground' : 'text-foreground/80'
                          )}>
                            {option.modelName}
                          </span>
                          {isSelected && <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />}
                        </button>
                      )
                    })}
                  </div>
                )
              })
              })()
            )}
          </div>
        </PopoverContent>
    </Popover>
  )
}

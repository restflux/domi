import * as React from 'react'
import type { AgentThinkingLevel, ChannelModel, PiModelCatalogStatus } from '@domi/shared'
import {
  Brain,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  SlidersHorizontal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatModelTokenInput, prepareModelTokenInputForEdit } from '@/lib/model-adaptation-input'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export const ADAPTABLE_REASONING_LEVELS: readonly AgentThinkingLevel[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]

export interface ModelAdaptationDraft {
  contextWindow: string
  maxTokens: string
  inputMode: 'unspecified' | 'text' | 'text-image'
  reasoningMode: 'unspecified' | 'enabled' | 'disabled'
  levels: AgentThinkingLevel[]
  defaultLevel: AgentThinkingLevel
  effortMap: Partial<Record<AgentThinkingLevel, string | null>>
}

interface ModelAdaptationDialogProps {
  open: boolean
  modelId: string | null
  model: ChannelModel | undefined
  draft: ModelAdaptationDraft | null
  catalogStatus: PiModelCatalogStatus | null
  advancedOpen: boolean
  contextWindowError?: string
  maxTokensError?: string
  reasoningLevelsError?: string
  canSave: boolean
  onOpenChange: (open: boolean) => void
  onDraftChange: React.Dispatch<React.SetStateAction<ModelAdaptationDraft | null>>
  onAdvancedOpenChange: (open: boolean) => void
  onClear: () => void
  onSave: () => void
}

const REASONING_LEVEL_LABELS: Record<AgentThinkingLevel, string> = {
  off: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
}

const INPUT_OPTIONS = [
  ['unspecified', '自动', '沿用上游声明'],
  ['text', '仅文本', '不接收图片'],
  ['text-image', '文本与图片', '支持视觉输入'],
] as const

const REASONING_OPTIONS = [
  ['unspecified', '自动', '沿用上游声明'],
  ['enabled', '支持推理', '配置可用档位'],
  ['disabled', '不支持', '不发送推理参数'],
] as const

function CapabilityOptionGroup<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: readonly (readonly [T, string, string])[]
  onChange: (value: T) => void
}): React.ReactElement {
  return (
    <div className="grid grid-cols-3 gap-2 rounded-xl bg-muted/40 p-1.5">
      {options.map(([optionValue, label, description]) => (
        <button
          key={optionValue}
          type="button"
          aria-pressed={value === optionValue}
          onClick={() => onChange(optionValue)}
          className={cn(
            'rounded-lg px-3 py-2.5 text-left transition-all',
            value === optionValue
              ? 'bg-background text-foreground shadow-sm ring-1 ring-border/60'
              : 'text-muted-foreground hover:bg-background/50 hover:text-foreground'
          )}
        >
          <span className="block text-sm font-medium">{label}</span>
          <span className="mt-0.5 block text-[11px] leading-tight opacity-75">{description}</span>
        </button>
      ))}
    </div>
  )
}

function TokenLimitField({
  id,
  label,
  description,
  placeholder,
  value,
  error,
  onChange,
}: {
  id: string
  label: string
  description: string
  placeholder: string
  value: string
  error?: string
  onChange: (value: string) => void
}): React.ReactElement {
  return (
    <div className="rounded-xl border border-border/50 bg-background/30 p-3.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      <div className="relative mt-3">
        <Input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={value}
          onFocus={(event) => onChange(prepareModelTokenInputForEdit(event.currentTarget.value))}
          onChange={(event) => onChange(event.currentTarget.value)}
          onBlur={(event) => onChange(formatModelTokenInput(event.currentTarget.value))}
          placeholder={placeholder}
          aria-invalid={error != null}
          className={cn(
            'pr-[4.5rem] font-mono tabular-nums',
            error && 'border-destructive/60 focus-visible:border-destructive focus-visible:ring-destructive/10'
          )}
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px] font-medium text-muted-foreground">
          tokens
        </span>
      </div>
      <div className="mt-1.5 min-h-4 text-xs text-destructive">{error}</div>
    </div>
  )
}

export function ModelAdaptationDialog({
  open,
  modelId,
  model,
  draft,
  catalogStatus,
  advancedOpen,
  contextWindowError,
  maxTokensError,
  reasoningLevelsError,
  canSave,
  onOpenChange,
  onDraftChange,
  onAdvancedOpenChange,
  onClear,
  onSave,
}: ModelAdaptationDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/50 px-6 pb-5 pt-6 pr-14">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle>模型适配</DialogTitle>
            {modelId && (
              <span className="max-w-full truncate rounded-md bg-muted px-2 py-1 font-mono text-xs font-medium text-foreground/80">
                {modelId}
              </span>
            )}
          </div>
          <DialogDescription className="max-w-xl leading-relaxed">
            为上游尚未声明的能力补充临时配置。供应商或 Pi catalog 提供同一字段后，会自动采用权威值。
          </DialogDescription>
        </DialogHeader>

        {draft && (
          <div className="max-h-[68vh] overflow-y-auto px-6 py-5">
            <div className="space-y-6">
              <div className={cn(
                'flex gap-3 rounded-xl border px-4 py-3',
                catalogStatus === 'catalog'
                  ? 'border-emerald-500/20 bg-emerald-500/[0.06]'
                  : catalogStatus === 'missing'
                    ? 'border-amber-500/20 bg-amber-500/[0.06]'
                    : 'border-border/50 bg-muted/25'
              )}>
                <div className={cn(
                  'mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full',
                  catalogStatus === 'catalog'
                    ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : catalogStatus === 'missing'
                      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                      : 'bg-muted text-muted-foreground'
                )}>
                  {catalogStatus === 'catalog'
                    ? <CircleCheck size={15} />
                    : catalogStatus === 'missing'
                      ? <CircleAlert size={15} />
                      : <SlidersHorizontal size={14} />}
                </div>
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {catalogStatus === 'catalog'
                      ? 'Pi catalog 已收录'
                      : catalogStatus === 'missing'
                        ? 'Pi catalog 尚未收录'
                        : '临时能力配置'}
                    {model?.providerMetadata && (
                      <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
                        含供应商元数据
                      </span>
                    )}
                  </div>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {catalogStatus === 'catalog'
                      ? '运行时优先使用 catalog 声明；这里的配置会保留，在上游数据缺失时继续兜底。'
                      : catalogStatus === 'missing'
                        ? '这里填写的字段会立即补齐模型能力，未来上游收录后无需手动删除。'
                        : '渠道创建后可检测 catalog 收录状态。生效顺序：供应商、Pi catalog、临时适配。'}
                  </p>
                </div>
              </div>

              <section className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">容量限制</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">留空表示不声明，由上游目录或安全默认值决定。</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <TokenLimitField
                    id="adaptation-context-window"
                    label="上下文窗口"
                    description="单次请求可使用的总 Token 上限"
                    placeholder="1,000,000"
                    value={draft.contextWindow}
                    error={contextWindowError}
                    onChange={(value) => onDraftChange((current) => current && ({ ...current, contextWindow: value }))}
                  />
                  <TokenLimitField
                    id="adaptation-max-tokens"
                    label="最大输出 Token"
                    description="单次响应允许生成的 Token 上限"
                    placeholder="131,072"
                    value={draft.maxTokens}
                    error={maxTokensError}
                    onChange={(value) => onDraftChange((current) => current && ({ ...current, maxTokens: value }))}
                  />
                </div>
              </section>

              <section className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">输入能力</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">指定模型能够直接接收的内容类型。</p>
                </div>
                <CapabilityOptionGroup
                  value={draft.inputMode}
                  options={INPUT_OPTIONS}
                  onChange={(value) => onDraftChange((current) => current && ({ ...current, inputMode: value }))}
                />
              </section>

              <section className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-foreground">推理能力</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">只有模型明确支持时才配置档位，避免发送无效参数。</p>
                </div>
                <CapabilityOptionGroup
                  value={draft.reasoningMode}
                  options={REASONING_OPTIONS}
                  onChange={(value) => onDraftChange((current) => current && ({ ...current, reasoningMode: value }))}
                />

                {draft.reasoningMode === 'enabled' && (
                  <div className="rounded-xl border border-border/50 bg-background/30 p-4">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Brain size={16} />
                      </div>
                      <div className="min-w-0 flex-1 space-y-5">
                        <div>
                          <div className="text-sm font-medium">可用档位</div>
                          <p className="mt-0.5 text-xs text-muted-foreground">选择 Domi 可以展示和发送的推理深度。</p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            {ADAPTABLE_REASONING_LEVELS.map((level) => {
                              const checked = draft.levels.includes(level)
                              return (
                                <button
                                  key={level}
                                  type="button"
                                  aria-pressed={checked}
                                  onClick={() => onDraftChange((current) => {
                                    if (!current) return current
                                    const levels = checked
                                      ? current.levels.filter((candidate) => candidate !== level)
                                      : ADAPTABLE_REASONING_LEVELS.filter((candidate) => (
                                          current.levels.includes(candidate) || candidate === level
                                        ))
                                    return {
                                      ...current,
                                      levels,
                                      defaultLevel: levels.includes(current.defaultLevel)
                                        ? current.defaultLevel
                                        : levels[0] ?? 'low',
                                      effortMap: {
                                        ...current.effortMap,
                                        [level]: level === 'off' ? null : current.effortMap[level] ?? level,
                                      },
                                    }
                                  })}
                                  className={cn(
                                    'rounded-full border px-3 py-1.5 text-xs font-medium transition-all',
                                    checked
                                      ? 'border-primary/30 bg-primary/10 text-primary shadow-xs'
                                      : 'border-border/60 bg-background/30 text-muted-foreground hover:border-border hover:text-foreground'
                                  )}
                                >
                                  {REASONING_LEVEL_LABELS[level]}
                                  <span className="ml-1 font-mono text-[10px] opacity-60">{level}</span>
                                </button>
                              )
                            })}
                          </div>
                          {reasoningLevelsError && (
                            <p className="mt-2 text-xs text-destructive">{reasoningLevelsError}</p>
                          )}
                        </div>

                        {draft.levels.length > 0 && (
                          <div>
                            <div className="text-sm font-medium">默认档位</div>
                            <p className="mt-0.5 text-xs text-muted-foreground">新会话未保存偏好时优先使用。</p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              {draft.levels.map((level) => (
                                <button
                                  key={level}
                                  type="button"
                                  aria-pressed={draft.defaultLevel === level}
                                  onClick={() => onDraftChange((current) => current && ({ ...current, defaultLevel: level }))}
                                  className={cn(
                                    'rounded-md border px-3 py-1.5 text-xs font-medium transition-all',
                                    draft.defaultLevel === level
                                      ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                                      : 'border-border/60 bg-background/30 text-muted-foreground hover:border-border hover:text-foreground'
                                  )}
                                >
                                  {REASONING_LEVEL_LABELS[level]}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        <Collapsible open={advancedOpen} onOpenChange={onAdvancedOpenChange}>
                          <CollapsibleTrigger asChild>
                            <button
                              type="button"
                              className="flex w-full items-center justify-between rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
                            >
                              <span>
                                <span className="block text-xs font-medium text-foreground">高级映射</span>
                                <span className="mt-0.5 block text-[11px] text-muted-foreground">仅在供应商使用不同 effort 值时修改</span>
                              </span>
                              <ChevronDown
                                size={15}
                                className={cn('text-muted-foreground transition-transform', advancedOpen && 'rotate-180')}
                              />
                            </button>
                          </CollapsibleTrigger>
                          <CollapsibleContent className="pt-3">
                            <div className="space-y-2 rounded-lg border border-border/40 bg-muted/10 p-3">
                              {draft.levels.map((level) => (
                                <div key={level} className="grid grid-cols-[110px_1fr] items-center gap-3">
                                  <div className="min-w-0">
                                    <div className="text-xs font-medium">{REASONING_LEVEL_LABELS[level]}</div>
                                    <div className="font-mono text-[10px] text-muted-foreground">{level}</div>
                                  </div>
                                  <Input
                                    value={level === 'off' ? '不发送 effort' : draft.effortMap[level] ?? level}
                                    disabled={level === 'off'}
                                    onChange={(event) => onDraftChange((current) => current && ({
                                      ...current,
                                      effortMap: { ...current.effortMap, [level]: event.target.value },
                                    }))}
                                    className="h-8 font-mono text-xs"
                                    aria-label={`${level} 实际发送值`}
                                  />
                                </div>
                              ))}
                            </div>
                          </CollapsibleContent>
                        </Collapsible>
                      </div>
                    </div>
                  </div>
                )}
              </section>
            </div>
          </div>
        )}

        <DialogFooter className="flex-row items-center justify-between space-x-0 border-t border-border/50 bg-muted/15 px-6 py-4 sm:justify-between sm:space-x-0">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={onClear}
            disabled={!model?.temporaryAdaptation}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            清除配置
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" type="button" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button size="sm" type="button" disabled={!canSave} onClick={onSave}>
              保存适配
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * ContextUsageBadge — 上下文使用量指示器
 *
 * 输入框右侧模型控制组中的一个 32×32 按钮：
 * - 内部为 16px 圆环，按 displayTokens / displayWindow 比例渲染
 * - hover / click 弹出 Popover，内含上下文构成、会话缓存指标、额度与手动压缩按钮
 * - 压缩中时按钮位置显示 Loader2 旋转图标
 * - 占用接近当前 Agent runtime 的自动压缩阈值时圆环变琥珀色
 * - 无数据时不显示
 */

import * as React from 'react'
import { Loader2, Minimize2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { inputToolbarButtonClass } from '@/components/ai-elements/input-toolbar-styles'
import { cn } from '@/lib/utils'
import {
  calculatePiAutoCompactionThresholdTokens,
  type AgentContextBreakdown,
  type ChannelPlanQuotaResult,
  type ChannelPlanQuotaWindow,
  type ContextWindowSource,
} from '@domi/shared'
import { fetchChannelPlanQuota } from '@/lib/channel-plan-quota'
import {
  mergeStableAgentContextUsageSnapshot,
  type AgentContextUsageSnapshot,
  type AgentSessionCacheMetrics,
} from '@/lib/agent-context-usage'
import { normalizeContextBreakdown, type NormalizedContextBreakdownItem } from '@/lib/context-breakdown'

/** 历史自动压缩阈值比例；Pi 使用共享的 80% 策略。 */
const CLAUDE_COMPACT_THRESHOLD_RATIO = 0.775
/** 显示警告的阈值（压缩阈值的 80%） */
const WARNING_RATIO = 0.80
/** Popover hover 关闭延迟（ms），与 AgentThinkingPopover 一致 */
const HOVER_CLOSE_DELAY = 150
const UNSUPPORTED_PLAN_QUOTA_MESSAGE = '当前渠道不支持订阅 Plan 额度查询'

interface ContextUsageBadgeProps {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  costUsd?: number
  /** 会话内按 Token 加权的累计缓存命中率及可统计请求覆盖率。 */
  sessionCacheMetrics: AgentSessionCacheMetrics
  contextBreakdown?: AgentContextBreakdown
  contextWindow?: number
  /** 上下文窗口来源。 */
  contextWindowSource?: ContextWindowSource
  /** 当前 usage 所属的 runtime/channel/model，用于切换执行目标时清空稳定值。 */
  contextWindowOwner?: string
  /** 当前上下文 token 是否为 Pi 压缩后的预估值 */
  isEstimated: boolean
  /** 压缩后旧 usage 已明确失效；普通 partial 缺数不会设置。 */
  contextUsageInvalidated?: boolean
  /** Pi runtime 使用 80% 自动压缩阈值；未传时保留 Claude 的既有提示策略。 */
  isPiRuntime?: boolean
  isCompacting: boolean
  isProcessing: boolean
  onCompact: () => void
  /**
   * 当前会话 ID，用于在切换会话时清空 stableRef，
   * 避免新会话尚未发消息时仍显示上一个会话的 token 数。
   */
  sessionId?: string
  /** 当前 Agent 渠道 ID，用于 hover 时查询订阅 Plan 剩余额度 */
  channelId?: string | null
  /** 渠道保存时间；凭据变更后用于使旧额度缓存失效。 */
  channelUpdatedAt?: number
}

/** 格式化 token 数为可读字符串（如 1234 → "1.2k"） */
function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`
  }
  return `${tokens}`
}

/** 圆环进度指示器 — 16×16 SVG，描边 2px */
interface UsageRingProps {
  ratio: number
  isWarning: boolean
}
function UsageRing({ ratio, isWarning }: UsageRingProps): React.ReactElement {
  const radius = 8
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(1, ratio))
  const dashOffset = circumference * (1 - clamped)

  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      className={cn(
        'shrink-0 transition-colors',
        isWarning ? 'text-amber-500 dark:text-amber-400' : 'text-foreground/70',
      )}
      aria-hidden="true"
    >
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="2"
      />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform="rotate(-90 10 10)"
        style={{ transition: 'stroke-dashoffset 300ms ease-out' }}
      />
    </svg>
  )
}

/** Popover 里的一行 key/value */
interface DetailRowProps {
  label: string
  value: string
  emphasized?: boolean
}
function DetailRow({ label, value, emphasized }: DetailRowProps): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-4 text-xs">
      <span className="text-foreground/70">{label}</span>
      <span className={cn('tabular-nums', emphasized ? 'font-medium text-foreground' : 'text-foreground/90')}>
        {value}
      </span>
    </div>
  )
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}

export function ContextUsageHeader({
  percent,
  displayTokens,
  displayWindow,
  isEstimated,
  isWarning,
}: {
  percent?: number
  displayTokens: number
  displayWindow?: number
  isEstimated: boolean
  isWarning: boolean
}): React.ReactElement {
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-3">
      <div className="text-xs font-medium leading-5 text-foreground">上下文用量</div>
      <div className={cn(
        'text-right text-sm font-medium leading-5 tabular-nums',
        isWarning ? 'text-amber-600 dark:text-amber-400' : 'text-foreground',
      )}>
        {percent != null ? `${percent}%` : formatTokens(displayTokens)}
      </div>
      {displayWindow ? (
        <div className="col-start-2 text-right text-[10px] font-normal leading-4 tabular-nums text-muted-foreground">
          {isEstimated ? '≈' : ''}{formatTokens(displayTokens)} / {formatTokens(displayWindow)}
        </div>
      ) : null}
    </div>
  )
}

function breakdownColor(key: NormalizedContextBreakdownItem['key']): string {
  return cn(
    key === 'system' && 'bg-sky-500',
    key === 'skills' && 'bg-violet-500',
    key === 'mcp' && 'bg-emerald-500',
    key === 'tools' && 'bg-amber-500',
    key === 'conversation' && 'bg-foreground/55',
  )
}

export function ContextOperationalDetails({
  sessionCacheMetrics,
}: {
  sessionCacheMetrics: AgentSessionCacheMetrics
}): React.ReactElement {
  const coverage = sessionCacheMetrics.totalRequests > 0
    ? `统计 ${sessionCacheMetrics.measuredRequests}/${sessionCacheMetrics.totalRequests} 次请求`
    : '尚无可统计请求'

  return (
    <div className="space-y-0.5">
      <DetailRow
        label="缓存命中"
        value={sessionCacheMetrics.hitRate != null ? formatPercent(sessionCacheMetrics.hitRate) : '暂无数据'}
        emphasized
      />
      <div className="text-right text-[10px] tabular-nums text-muted-foreground">{coverage}</div>
    </div>
  )
}

export function ContextBreakdownDetails({
  items,
}: {
  items?: NormalizedContextBreakdownItem[]
}): React.ReactElement {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-foreground/75">上下文构成</span>
        <span className="text-[10px] text-muted-foreground">按实际请求结构估算</span>
      </div>
      {items ? (
        <>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-foreground/10">
            {items.map((item) => (
              <div
                key={item.key}
                className={cn('h-full first:rounded-l-full last:rounded-r-full', breakdownColor(item.key))}
                style={{ width: `${item.ratio * 100}%` }}
              />
            ))}
          </div>
          <div className="flex flex-col gap-1">
            {items.map((item) => (
              <div key={item.key} className="flex items-center justify-between gap-3 text-[11px]">
                <span className="flex items-center gap-1.5 text-foreground/70">
                  <span className={cn('size-1.5 rounded-full', breakdownColor(item.key))} />
                  {item.label}
                </span>
                <span className="tabular-nums text-foreground/90">
                  {formatTokens(item.tokens)} · {formatPercent(item.ratio)}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="rounded-md bg-foreground/[0.04] px-2 py-1.5 text-[10px] leading-4 text-muted-foreground">
          构成数据将在下次模型请求后生成
        </div>
      )}
    </div>
  )
}

function formatResetTime(timestamp?: number): string | undefined {
  if (!timestamp) return undefined
  return new Intl.DateTimeFormat(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

function PlanQuotaRow({ quotaWindow }: { quotaWindow: ChannelPlanQuotaWindow }): React.ReactElement {
  const resetText = formatResetTime(quotaWindow.resetAt)
  const value = `${quotaWindow.remainingLabel ?? `${quotaWindow.remainingPercent}%`} 剩余${resetText ? ` · ${resetText}` : ''}`
  return (
    <div className="space-y-1">
      <DetailRow
        label={quotaWindow.label}
        value={value}
        emphasized={quotaWindow.remainingPercent <= 20}
      />
      {quotaWindow.showProgress !== false ? (
        <div className="h-1 overflow-hidden rounded-full bg-foreground/10">
          <div
            className={cn(
              'h-full rounded-full',
              quotaWindow.remainingPercent <= 20 ? 'bg-amber-500' : 'bg-foreground/60',
            )}
            style={{ width: `${Math.max(0, Math.min(100, quotaWindow.remainingPercent))}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}

export function ContextUsageBadge({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheCreationTokens,
  costUsd,
  sessionCacheMetrics,
  contextBreakdown,
  contextWindow,
  contextWindowSource,
  contextWindowOwner,
  isEstimated,
  contextUsageInvalidated = false,
  isPiRuntime = false,
  isCompacting,
  isProcessing,
  onCompact,
  sessionId,
  channelId,
  channelUpdatedAt,
}: ContextUsageBadgeProps): React.ReactElement | null {
  // 保留最近一次有效的 token 值，避免切换会话时闪烁消失
  const stableRef = React.useRef<AgentContextUsageSnapshot | null>(null)
  // 会话或执行目标切换时同步清空陈旧值，避免首帧仍显示旧模型/runtime 的占用。
  const stableScope = `${sessionId ?? ''}:${contextWindowOwner ?? ''}`
  const lastStableScopeRef = React.useRef(stableScope)
  if (lastStableScopeRef.current !== stableScope) {
    stableRef.current = null
    lastStableScopeRef.current = stableScope
  }
  stableRef.current = mergeStableAgentContextUsageSnapshot(stableRef.current, {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd,
    contextBreakdown,
    contextWindow,
    contextWindowSource,
    contextUsageInvalidated,
  })

  const [open, setOpen] = React.useState(false)
  const closeTimerRef = React.useRef<number | null>(null)
  // 保留上次成功/失败结果；悬浮刷新期间继续展示旧值，直到新结果到达后原位替换。
  const [quota, setQuota] = React.useState<ChannelPlanQuotaResult | null>(null)

  const cancelClose = React.useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const scheduleClose = React.useCallback(() => {
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => setOpen(false), HOVER_CLOSE_DELAY)
  }, [cancelClose])

  React.useEffect(() => cancelClose, [cancelClose])

  React.useEffect(() => {
    if (!open || !channelId) return

    let cancelled = false

    fetchChannelPlanQuota(channelId, channelUpdatedAt)
      .then((result) => {
        if (!cancelled) setQuota(result)
      })

    return () => {
      cancelled = true
    }
  }, [open, channelId, channelUpdatedAt])

  // 压缩中 → 按钮位置显示 spinner
  if (isCompacting) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn(inputToolbarButtonClass, 'text-muted-foreground cursor-default')}
        disabled
        aria-label="正在压缩上下文"
      >
        <Loader2 className="size-4 animate-spin" />
      </Button>
    )
  }

  // 使用稳定值：优先当前数据，回退到上次有效数据
  const stable = stableRef.current
  const hasCurrent = inputTokens != null && inputTokens > 0
  const displayTokens = hasCurrent ? inputTokens : stable?.inputTokens
  const displayWindow = hasCurrent ? contextWindow : stable?.contextWindow
  const displayContextBreakdown = hasCurrent ? contextBreakdown : stable?.contextBreakdown

  // 从未有过 usage 数据 → 不显示
  if (!displayTokens || displayTokens <= 0) return null

  // 警告阈值：Pi 采用窗口 × 80%，Claude 保留既有 SDK 阈值；两者均在阈值的 80% 时预警。
  const compactThreshold = displayWindow
    ? (isPiRuntime
        ? calculatePiAutoCompactionThresholdTokens(displayWindow)
        : Math.floor(displayWindow * CLAUDE_COMPACT_THRESHOLD_RATIO))
    : undefined
  const isWarning = compactThreshold
    ? displayTokens / compactThreshold >= WARNING_RATIO
    : false

  const ratio = displayWindow ? displayTokens / displayWindow : 0

  const percent = displayWindow
    ? Math.round((displayTokens / displayWindow) * 100)
    : undefined
  const normalizedBreakdown = normalizeContextBreakdown(displayContextBreakdown, displayTokens)

  const handleCompactClick = (): void => {
    if (isProcessing) return
    onCompact()
    setOpen(false)
  }

  const shouldShowPlanQuota = quota != null && (
    quota.supported
    || quota.windows.length > 0
    || quota.message !== UNSUPPORTED_PLAN_QUOTA_MESSAGE
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            inputToolbarButtonClass,
            isWarning ? 'text-amber-600 dark:text-amber-400' : 'text-foreground/60 hover:text-foreground',
          )}
          onMouseEnter={() => {
            cancelClose()
            setOpen(true)
          }}
          onMouseLeave={scheduleClose}
          aria-label={percent != null ? `上下文占用 ${percent}%` : '查看上下文用量'}
        >
          <UsageRing ratio={ratio} isWarning={isWarning} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-[292px] p-3"
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-2">
          <div className="space-y-1.5">
            <ContextUsageHeader
              percent={percent}
              displayTokens={displayTokens}
              displayWindow={displayWindow}
              isEstimated={isEstimated}
              isWarning={isWarning}
            />
            {displayWindow ? (
              <div className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
                <div
                  className={cn(
                    'h-full rounded-full transition-[width] duration-300',
                    isWarning ? 'bg-amber-500' : 'bg-foreground/65',
                  )}
                  style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }}
                />
              </div>
            ) : null}
          </div>

          <div className="h-px bg-border" />
          <ContextBreakdownDetails items={normalizedBreakdown} />

          <div className="h-px bg-border" />
          <ContextOperationalDetails sessionCacheMetrics={sessionCacheMetrics} />

          {shouldShowPlanQuota ? (
            <>
              <div className="h-px bg-border my-0.5" />
              <div className="text-[11px] font-medium text-foreground/70">
                订阅额度{quota?.planName ? ` · ${quota.planName}` : ''}
              </div>
              {quota?.supported && quota.windows.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {quota.windows.map((quotaWindow) => (
                    <PlanQuotaRow key={`${quotaWindow.type}-${quotaWindow.label}`} quotaWindow={quotaWindow} />
                  ))}
                </div>
              ) : (
                <div className="text-[11px] text-foreground/50">
                  {quota?.message ?? '订阅额度查询失败'}
                </div>
              )}
            </>
          ) : null}

          <div className="h-px bg-border my-0.5" />
          <Button
            type="button"
            variant={isWarning ? 'default' : 'outline'}
            size="sm"
            className={cn(
              'h-7 text-xs gap-1.5',
              isWarning && 'bg-amber-500 hover:bg-amber-600 text-white',
            )}
            onClick={handleCompactClick}
            disabled={isProcessing}
          >
            <Minimize2 className="size-3.5" />
            {isProcessing ? '对话进行中' : '手动压缩'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

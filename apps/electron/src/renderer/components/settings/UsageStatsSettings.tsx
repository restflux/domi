/**
 * UsageStatsSettings — Token 用量统计面板（Codex「Token 活动」风格）
 *
 * 展示 token 与费用使用统计：
 * - 顶部统计卡：Codex 式横排 5 指标（累计 / 当天 / 峰值 / 缓存命中率 / 费用），竖向浅灰分隔线
 * - Token 活动多视图：同一日历网格下的每日、每周与累计热力图
 * - 时间区间切换（今日 / 本周 / 本月 / 近一年 / 全部）
 * - 支持悬停明细的近 N 天 token 趋势折线（自绘 SVG）
 * - 按渠道 / 按模型分组 + 最近使用明细
 */

import * as React from 'react'
import { ActivityCalendar, type Activity, type BlockElement } from 'react-activity-calendar'
import { useAtomValue } from 'jotai'
import { RefreshCw, Server, Layers } from 'lucide-react'
import { SettingsSection, SettingsCard } from './primitives'
import { Button } from '../ui/button'
import { APP_MODE_DISPLAY } from '@/lib/app-mode-display'
import { cn } from '@/lib/utils'
import { createUsageStatsQueryPlan, USAGE_DETAIL_LIMIT, type UsageRange } from '@/lib/usage-stats-query-plan'
import {
  aggregateUsageByWeek,
  buildCumulativeUsageWeeks,
  buildDailyUsageSeries,
  findNearestUsagePointIndex,
  findUsageWeekColumnIndex,
  startOfUsageWeek,
  type UsageWeekGroup,
} from '@/lib/usage-chart-data'
import { resolvedThemeAtom } from '@/atoms/theme'
import {
  UsageStatsSummary,
  formatProviderRequestCount,
  formatUsageCost,
  formatUsageTokens,
} from './UsageStatsSummary'
import type { UsageDayGroup, UsageGroupItem, UsageQueryResult } from '@domi/shared'

const RANGE_OPTIONS: Array<{ value: UsageRange; label: string }> = [
  { value: 'today', label: '今日' },
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'year', label: '近一年' },
  { value: 'all', label: '全部' },
]

type TokenActivityMode = 'daily' | 'weekly' | 'cumulative'

const TOKEN_ACTIVITY_OPTIONS: Array<{ value: TokenActivityMode; label: string }> = [
  { value: 'daily', label: '每日' },
  { value: 'weekly', label: '每周' },
  { value: 'cumulative', label: '累计' },
]

/** 热力图方格尺寸（自适应：常规宽度下恰好铺满卡片，不再出现横向滚动条） */
const HEATMAP_BLOCK_SIZE_FALLBACK = 16
const HEATMAP_BLOCK_SIZE_MIN = 3
const HEATMAP_BLOCK_SIZE_MAX = 20
const HEATMAP_BLOCK_MARGIN = 4
const DAY_MS = 86_400_000

/** 热力图完整 12 个自然月窗口 */
interface HeatmapWindow {
  start: Date
  end: Date
}

/** 底部月份标签及其对应的网格横坐标 */
interface HeatmapMonthMarker {
  key: string
  label: string
  left: number
}

/** 热力图布局计算结果 */
interface HeatmapLayout {
  width: number
  months: HeatmapMonthMarker[]
}

/** 自定义 hover 浮层状态 */
interface HoveredUsagePoint {
  point: UsageDayGroup
  left: number
  top: number
  title: string
  columnIndex?: number
  columnBounds?: { left: number; top: number; width: number; height: number }
}

/** 本地时区当天 0 点 */
function startOfToday(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

/** 本地日期 YYYY-MM-DD */
function formatLocalDate(ts: number): string {
  const d = new Date(ts)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** 格式化明细时间（MM-DD HH:mm） */
function formatDetailTime(ts: number): string {
  const d = new Date(ts)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hour = String(d.getHours()).padStart(2, '0')
  const minute = String(d.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hour}:${minute}`
}

/** 最近 12 个完整自然月（当前月 + 向前 11 个月） */
function getHeatmapWindow(now = new Date()): HeatmapWindow {
  return {
    start: new Date(now.getFullYear(), now.getMonth() - 11, 1),
    end: new Date(now.getFullYear(), now.getMonth() + 1, 0),
  }
}

/** 按本地年月日计算日序号，避免夏令时导致毫秒差不是整天 */
function localDayOrdinal(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS)
}

/** 将三种统计口径转换为同一套 12 个月日历网格数据。 */
function buildCalendarActivities(byDay: UsageDayGroup[], mode: TokenActivityMode): {
  activities: Activity[]
  dayMap: Map<string, UsageDayGroup>
  weeks: UsageWeekGroup[]
} {
  const { start, end } = getHeatmapWindow()
  const today = new Date(startOfToday())
  const effectiveEnd = today < end ? today : end
  const dailyMap = new Map(byDay.map((day) => [day.date, day]))
  const weekly = aggregateUsageByWeek(byDay, start, effectiveEnd)
  const weeks = mode === 'cumulative' ? buildCumulativeUsageWeeks(weekly) : weekly
  const dayMap = new Map<string, UsageDayGroup>()
  const counts: number[] = []

  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const date = formatLocalDate(cursor.getTime())
    if (mode === 'daily') {
      const point = dailyMap.get(date) ?? emptyUsageDayGroup(date)
      dayMap.set(date, point)
      counts.push(point.totalTokens)
      continue
    }
    const columnIndex = findUsageWeekColumnIndex(date, weeks)
    const point = columnIndex >= 0 ? weeks[columnIndex] : undefined
    const resolved = point ?? emptyUsageDayGroup(date)
    dayMap.set(date, resolved)
    counts.push(resolved.totalTokens)
  }

  const maxCount = Math.max(0, ...counts)
  const activities: Activity[] = []
  let countIndex = 0
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const date = formatLocalDate(cursor.getTime())
    const count = counts[countIndex++] ?? 0
    const level = count <= 0 || maxCount <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((count / maxCount) * 4)))
    activities.push({ date, count, level })
  }
  return { activities, dayMap, weeks }
}

/** 热力图完整 12 个自然月覆盖的总周数（与 getHeatmapWindow 一致） */
function getHeatmapTotalWeeks(): number {
  const { start, end } = getHeatmapWindow()
  const calendarStart = new Date(start)
  const daysSinceMonday = (calendarStart.getDay() + 6) % 7
  calendarStart.setDate(calendarStart.getDate() - daysSinceMonday)
  const totalDays = localDayOrdinal(end) - localDayOrdinal(calendarStart) + 1
  return Math.ceil(totalDays / 7)
}

/**
 * 根据容器宽度动态计算方格尺寸，让整年网格恰好铺满卡片宽度。
 * 极端窄窗口时收缩到最小尺寸，仍不足以容纳才允许滚动兜底。
 */
function computeBlockSize(containerWidth: number, totalWeeks: number, margin: number): number {
  if (containerWidth <= 0) return HEATMAP_BLOCK_SIZE_FALLBACK
  // 网格总宽 = totalWeeks * (blockSize + margin) - margin ≤ containerWidth，反解 blockSize
  const blockSize = Math.floor((containerWidth + margin) / totalWeeks) - margin
  return Math.max(HEATMAP_BLOCK_SIZE_MIN, Math.min(HEATMAP_BLOCK_SIZE_MAX, blockSize))
}

/**
 * 计算月份标签在 Contribution 网格中的真实周坐标。
 * ActivityCalendar 使用周一作为每列起点，因此先补齐窗口起始日前的空格，再按周定位月份首日。
 */
function buildHeatmapLayout(blockSize: number): HeatmapLayout {
  const { start, end } = getHeatmapWindow()
  const calendarStart = new Date(start)
  const daysSinceMonday = (calendarStart.getDay() + 6) % 7
  calendarStart.setDate(calendarStart.getDate() - daysSinceMonday)

  const totalDays = localDayOrdinal(end) - localDayOrdinal(calendarStart) + 1
  const totalWeeks = Math.ceil(totalDays / 7)
  const pitch = blockSize + HEATMAP_BLOCK_MARGIN
  const months: HeatmapMonthMarker[] = []

  for (let index = 0; index < 12; index++) {
    const monthDate = new Date(start.getFullYear(), start.getMonth() + index, 1)
    const daysFromGridStart = localDayOrdinal(monthDate) - localDayOrdinal(calendarStart)
    const weekIndex = Math.floor(daysFromGridStart / 7)
    months.push({
      key: `${monthDate.getFullYear()}-${monthDate.getMonth() + 1}`,
      label: `${monthDate.getMonth() + 1}月`,
      left: weekIndex * pitch,
    })
  }

  return {
    width: totalWeeks * pitch - HEATMAP_BLOCK_MARGIN,
    months,
  }
}

/** 本地日期的紧凑中文展示。 */
function formatUsageDate(date: string): string {
  const [year, month, day] = date.split('-')
  return `${year}年${Number(month)}月${Number(day)}日`
}

function emptyUsageDayGroup(date: string): UsageDayGroup {
  return {
    date,
    entryCount: 0,
    providerRequestCount: 0,
    providerRequestCoverage: 'none',
    inputTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }
}

/** 单日 / 单周用量 Tooltip。 */
function UsagePointTooltip({ point, title }: { point: UsageDayGroup; title: string }): React.ReactElement {
  return (
    <div className="space-y-1">
      <div className="font-medium text-popover-foreground">{title}</div>
      <div className="text-xs tabular-nums text-muted-foreground">
        模型请求 {formatProviderRequestCount(point.providerRequestCount, point.providerRequestCoverage)} · {point.entryCount} 条运行记录
      </div>
      <div className="text-xs tabular-nums text-muted-foreground">
        非缓存输入 {formatUsageTokens(point.uncachedInputTokens)} · 缓存读 {formatUsageTokens(point.cacheReadTokens)} · 写 {formatUsageTokens(point.cacheCreationTokens)}
      </div>
      <div className="text-xs tabular-nums text-muted-foreground">
        输出 {formatUsageTokens(point.outputTokens)} · 总计 {formatUsageTokens(point.totalTokens)}
        {point.costUsd != null ? ` · ${formatUsageCost(point.costUsd)}` : ''}
      </div>
    </div>
  )
}

function CompactSegmentedControl<T extends string>({
  value,
  options,
  disabled = false,
  onChange,
  ariaLabel,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  disabled?: boolean
  onChange: (value: T) => void
  ariaLabel: string
}): React.ReactElement {
  return (
    <div className="inline-flex flex-shrink-0 rounded-lg bg-muted/80 p-0.5" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
            'disabled:cursor-not-allowed disabled:opacity-50',
            value === option.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** 趋势标题栏右侧的紧凑范围切换。 */
function UsageRangeControl({
  value,
  disabled,
  onChange,
}: {
  value: UsageRange
  disabled: boolean
  onChange: (value: UsageRange) => void
}): React.ReactElement {
  return (
    <CompactSegmentedControl
      value={value}
      options={RANGE_OPTIONS}
      disabled={disabled}
      onChange={onChange}
      ariaLabel="Token 趋势时间区间"
    />
  )
}

/** Codex 式 Token 活动日历：底部中文月份 + 受控 hover 浮层 */
function TokenActivityCalendar({
  byDay,
  loading,
  isDark,
  mode,
}: {
  byDay: UsageDayGroup[]
  loading: boolean
  isDark: boolean
  mode: TokenActivityMode
}): React.ReactElement {
  const surfaceRef = React.useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = React.useState<HoveredUsagePoint | null>(null)
  const [containerWidth, setContainerWidth] = React.useState(0)
  const calendar = React.useMemo(() => buildCalendarActivities(byDay, mode), [byDay, mode])

  React.useEffect(() => setHovered(null), [mode])

  // 监听容器实际宽度，动态计算方格尺寸：整年网格铺满卡片，无横向滚动条。
  // 注意：surfaceRef 必须常驻 DOM（loading 分支不能提前 return），否则首帧读取为 null 导致观察者永不建立。
  React.useEffect(() => {
    const element = surfaceRef.current
    if (!element) return
    const update = (): void => setContainerWidth(element.getBoundingClientRect().width)
    update()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    observer?.observe(element)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  const totalWeeks = React.useMemo(() => getHeatmapTotalWeeks(), [])
  const blockSize = React.useMemo(
    () => computeBlockSize(containerWidth, totalWeeks, HEATMAP_BLOCK_MARGIN),
    [containerWidth, totalWeeks],
  )
  const layout = React.useMemo(() => buildHeatmapLayout(blockSize), [blockSize])

  const resolveActivity = React.useCallback((activity: Activity): { point: UsageDayGroup; title: string; columnIndex?: number } => {
    const point = calendar.dayMap.get(activity.date) ?? emptyUsageDayGroup(activity.date)
    if (mode === 'daily') return { point, title: formatUsageDate(activity.date) }
    const columnIndex = findUsageWeekColumnIndex(activity.date, calendar.weeks)
    const week = columnIndex >= 0 ? calendar.weeks[columnIndex] : undefined
    if (!week) return { point, title: formatUsageDate(activity.date) }
    return {
      point,
      columnIndex,
      title: mode === 'weekly'
        ? `${formatUsageDate(week.date)} – ${formatUsageDate(week.endDate)}`
        : `截至 ${formatUsageDate(week.endDate)} 累计`,
    }
  }, [calendar, mode])

  const showTooltip = React.useCallback((element: SVGRectElement, activity: Activity): void => {
    const surface = surfaceRef.current
    if (!surface) return
    const surfaceRect = surface.getBoundingClientRect()
    const blockRect = element.getBoundingClientRect()
    const rawLeft = blockRect.left - surfaceRect.left + blockRect.width / 2
    const horizontalPadding = Math.min(155, surfaceRect.width / 2)
    const resolved = resolveActivity(activity)
    let columnBounds: HoveredUsagePoint['columnBounds']
    if (resolved.columnIndex != null) {
      const columnBlocks = [...surface.querySelectorAll<SVGRectElement>(`[data-usage-column="${resolved.columnIndex}"]`)]
      const rects = columnBlocks.map((block) => block.getBoundingClientRect())
      if (rects.length > 0) {
        const left = Math.min(...rects.map((rect) => rect.left)) - surfaceRect.left
        const top = Math.min(...rects.map((rect) => rect.top)) - surfaceRect.top
        const right = Math.max(...rects.map((rect) => rect.right)) - surfaceRect.left
        const bottom = Math.max(...rects.map((rect) => rect.bottom)) - surfaceRect.top
        columnBounds = { left: left - 2, top: top - 2, width: right - left + 4, height: bottom - top + 4 }
      }
    }
    setHovered({
      ...resolved,
      columnBounds,
      left: Math.min(Math.max(rawLeft, horizontalPadding), surfaceRect.width - horizontalPadding),
      top: blockRect.top - surfaceRect.top - 8,
    })
  }, [resolveActivity])

  const renderBlock = React.useCallback((block: BlockElement, activity: Activity): React.ReactElement => {
    const resolved = resolveActivity(activity)
    const requests = formatProviderRequestCount(resolved.point.providerRequestCount, resolved.point.providerRequestCoverage)
    const label = `${resolved.title}，${formatUsageTokens(resolved.point.totalTokens)} Token，模型请求 ${requests}，${resolved.point.entryCount} 条运行记录`
    const blockProps: Record<string, unknown> = {
      tabIndex: 0,
      role: 'img',
      'aria-label': label,
      'data-usage-column': resolved.columnIndex,
      onMouseEnter: (event: React.MouseEvent<SVGRectElement>) => showTooltip(event.currentTarget, activity),
      onMouseMove: (event: React.MouseEvent<SVGRectElement>) => showTooltip(event.currentTarget, activity),
      onMouseLeave: () => setHovered(null),
      onFocus: (event: React.FocusEvent<SVGRectElement>) => showTooltip(event.currentTarget, activity),
      onBlur: () => setHovered(null),
      style: { ...block.props.style, outline: 'none' },
    }
    return React.cloneElement(block as React.ReactElement<Record<string, unknown>>, blockProps)
  }, [resolveActivity, showTooltip])

  if (loading) {
    // 占位分支也必须渲染 surfaceRef，保证 ResizeObserver 在 mount 时建立
    return (
      <div ref={surfaceRef} className="relative flex items-center justify-center py-8 text-sm text-muted-foreground">
        加载中…
      </div>
    )
  }

  // 月份标签（如“8月”）文本约 24px 宽，最右侧标签可能略超网格右边缘；
  // 给 w-max 预留右侧空间，避免其溢出撑出横向滚动条。
  const gridWidth = layout.width + 24

  return (
    <div ref={surfaceRef} className="relative pt-10">
      {hovered?.columnBounds && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 rounded-[5px] border-2 border-orange-500"
          style={hovered.columnBounds}
        />
      )}
      {hovered && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-20 max-w-[calc(100%-16px)] -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-border/60 bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md"
          style={{ left: hovered.left, top: hovered.top }}
        >
          <UsagePointTooltip point={hovered.point} title={hovered.title} />
        </div>
      )}

      <div className="overflow-x-auto pb-1" data-usage-scroll="true">
        {/* mx-auto：网格窄于卡片时水平居中（Codex 风格）；窄窗口时收缩为零 margin，仍可横向滚动 */}
        <div className="mx-auto w-max" style={{ width: gridWidth }}>
          <ActivityCalendar
            data={calendar.activities}
            colorScheme={isDark ? 'dark' : 'light'}
            theme={{
              light: ['hsl(222 47% 94%)', '#3b82f6'],
              dark: ['#1e293b', '#60a5fa'],
            }}
            blockSize={blockSize}
            blockMargin={HEATMAP_BLOCK_MARGIN}
            blockRadius={4}
            weekStart={1}
            showMonthLabels={false}
            showWeekdayLabels={false}
            showColorLegend={false}
            showTotalCount={false}
            renderBlock={renderBlock}
          />
          <div className="relative mt-2 h-5" style={{ width: layout.width }} aria-hidden="true">
            {layout.months.map((month) => (
              <span
                key={month.key}
                className="absolute top-0 text-xs text-muted-foreground"
                style={{ left: month.left }}
              >
                {month.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 可交互的 Token 面积图：按指针横坐标命中最近数据点。 */
function InteractiveUsageAreaChart({
  points,
  ariaLabel,
  titleForPoint = (point) => formatUsageDate(point.date),
  showAverage = false,
}: {
  points: UsageDayGroup[]
  ariaLabel: string
  titleForPoint?: (point: UsageDayGroup) => string
  showAverage?: boolean
}): React.ReactElement {
  const isDark = useAtomValue(resolvedThemeAtom) === 'dark'
  const [hoveredIndex, setHoveredIndex] = React.useState<number | null>(null)
  const gradientId = `usage-fill-${React.useId().replace(/:/g, '')}`
  const WIDTH = 720
  const HEIGHT = 160
  const PAD_X = 8
  const PAD_Y = 16
  const values = points.map((point) => point.totalTokens)
  const max = Math.max(1, ...values)
  const chartWidth = WIDTH - PAD_X * 2
  const stepX = points.length > 1 ? chartWidth / (points.length - 1) : 0
  const xAt = (index: number): number => PAD_X + index * stepX
  const yAt = (index: number): number => HEIGHT - PAD_Y - ((values[index] ?? 0) / max) * (HEIGHT - PAD_Y * 2)
  const line = points.map((_, index) => `${index === 0 ? 'M' : 'L'}${xAt(index).toFixed(1)},${yAt(index).toFixed(1)}`).join(' ')
  const area = `${line} L${(WIDTH - PAD_X).toFixed(1)},${HEIGHT - PAD_Y} L${PAD_X},${HEIGHT - PAD_Y} Z`
  const stroke = isDark ? '#60a5fa' : '#3b82f6'
  const avg = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
  const avgY = HEIGHT - PAD_Y - (avg / max) * (HEIGHT - PAD_Y * 2)
  const hovered = hoveredIndex == null ? null : points[hoveredIndex]
  const hoveredX = hoveredIndex == null ? 0 : xAt(hoveredIndex)
  const hoveredY = hoveredIndex == null ? 0 : yAt(hoveredIndex)
  const tooltipLeft = Math.max(2, Math.min(98, (hoveredX / WIDTH) * 100))
  const tooltipTransform = tooltipLeft < 25 ? 'translateX(0)' : tooltipLeft > 75 ? 'translateX(-100%)' : 'translateX(-50%)'

  const updateHovered = React.useCallback((event: React.PointerEvent<SVGSVGElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    const viewX = ((event.clientX - rect.left) / Math.max(1, rect.width)) * WIDTH
    setHoveredIndex(findNearestUsagePointIndex(viewX - PAD_X, chartWidth, points.length))
  }, [chartWidth, points.length])

  const moveSelection = (offset: number): void => {
    setHoveredIndex((current) => Math.max(0, Math.min(points.length - 1, (current ?? points.length - 1) + offset)))
  }

  return (
    <div className="relative">
      {hovered && (
        <div
          role="tooltip"
          className="pointer-events-none absolute top-2 z-20 max-w-[calc(100%-16px)] rounded-lg border border-border/60 bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
          style={{ left: `${tooltipLeft}%`, transform: tooltipTransform }}
        >
          <UsagePointTooltip point={hovered} title={titleForPoint(hovered)} />
        </div>
      )}
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full touch-none outline-none"
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        onPointerEnter={updateHovered}
        onPointerMove={updateHovered}
        onPointerLeave={() => setHoveredIndex(null)}
        onFocus={() => setHoveredIndex(points.length - 1)}
        onBlur={() => setHoveredIndex(null)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') { event.preventDefault(); moveSelection(-1) }
          if (event.key === 'ArrowRight') { event.preventDefault(); moveSelection(1) }
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.25" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
          <line
            key={ratio}
            x1={PAD_X}
            x2={WIDTH - PAD_X}
            y1={HEIGHT - PAD_Y - ratio * (HEIGHT - PAD_Y * 2)}
            y2={HEIGHT - PAD_Y - ratio * (HEIGHT - PAD_Y * 2)}
            className="stroke-border/40"
            strokeWidth="1"
          />
        ))}
        <path d={area} fill={`url(#${gradientId})`} />
        <path d={line} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {showAverage && avg > 0 && (
          <line x1={PAD_X} x2={WIDTH - PAD_X} y1={avgY} y2={avgY} stroke={isDark ? '#94a3b8' : '#64748b'} strokeWidth="1" strokeDasharray="4 4" />
        )}
        <rect x={PAD_X} y={PAD_Y} width={chartWidth} height={HEIGHT - PAD_Y * 2} fill="transparent" pointerEvents="all" />
        {hovered && (
          <>
            <line x1={hoveredX} x2={hoveredX} y1={PAD_Y} y2={HEIGHT - PAD_Y} stroke={isDark ? '#cbd5e1' : '#475569'} strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={hoveredX} cy={hoveredY} r="4" fill={stroke} stroke={isDark ? '#0f172a' : '#ffffff'} strokeWidth="2" />
          </>
        )}
      </svg>
    </div>
  )
}

/** 总 Token 趋势：补齐当前窗口中的空日期后绘制。 */
function TrendChart({ byDay, range }: { byDay: UsageDayGroup[]; range: UsageRange }): React.ReactElement {
  const windowDays = range === 'year' || range === 'all' ? 365 : 30
  const end = new Date(startOfToday())
  const start = new Date(end)
  start.setDate(start.getDate() - windowDays + 1)
  const points = React.useMemo(() => buildDailyUsageSeries(byDay, start, end), [byDay, start.getTime(), end.getTime()])
  return <InteractiveUsageAreaChart points={points} ariaLabel="token 使用趋势" showAverage />
}

/** 分组项（渠道 / 模型共用） */
function GroupRow({ item, maxTokens }: { item: UsageGroupItem; maxTokens: number }): React.ReactElement {
  const pct = maxTokens > 0 ? (item.totalTokens / maxTokens) * 100 : 0
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground truncate">{item.name}</div>
          <div className="text-xs text-muted-foreground tabular-nums">
            模型请求 {formatProviderRequestCount(item.providerRequestCount, item.providerRequestCoverage)} · {item.entryCount} 条运行记录
          </div>
          <div className="text-[11px] text-muted-foreground/70 tabular-nums">
            非缓存输入 {formatUsageTokens(item.uncachedInputTokens)} · 缓存读 {formatUsageTokens(item.cacheReadTokens)} · 写 {formatUsageTokens(item.cacheCreationTokens)} · 输出 {formatUsageTokens(item.outputTokens)}
          </div>
        </div>
        <div className="flex-shrink-0 text-right">
          <div className="text-sm font-medium tabular-nums text-foreground">{formatUsageTokens(item.totalTokens)}</div>
          <div className="text-xs text-muted-foreground tabular-nums">{formatUsageCost(item.costUsd)}</div>
        </div>
      </div>
      <div className="mt-2 h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-blue-500/70 transition-all" style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  )
}

/** 模式徽标 */
function ModeBadge({ mode }: { mode: 'chat' | 'agent' }): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium',
        mode === 'agent' ? 'bg-purple-500/15 text-purple-600 dark:text-purple-400' : 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
      )}
    >
      {APP_MODE_DISPLAY[mode].label}
    </span>
  )
}

export function UsageStatsSettings(): React.ReactElement {
  const isDark = useAtomValue(resolvedThemeAtom) === 'dark'
  const [range, setRange] = React.useState<UsageRange>('month')
  const [activityMode, setActivityMode] = React.useState<TokenActivityMode>('daily')
  // 概览、分组和明细固定使用全部历史；只有趋势响应区间切换。
  const [overviewResult, setOverviewResult] = React.useState<UsageQueryResult | null>(null)
  const [trendResult, setTrendResult] = React.useState<UsageQueryResult | null>(null)
  const [overviewLoading, setOverviewLoading] = React.useState(true)
  const [trendLoading, setTrendLoading] = React.useState(true)
  const [overviewError, setOverviewError] = React.useState<string | null>(null)
  const [trendError, setTrendError] = React.useState<string | null>(null)
  // 热力图数据独立于时间区间：滚动最近 12 个月（Codex Token 活动风格）
  const [heatmapByDay, setHeatmapByDay] = React.useState<UsageDayGroup[]>([])
  const [heatmapLoading, setHeatmapLoading] = React.useState(true)

  const loadOverview = React.useCallback(async (): Promise<void> => {
    setOverviewLoading(true)
    setOverviewError(null)
    try {
      const data = await window.electronAPI.getUsageStats(createUsageStatsQueryPlan('all').overview)
      setOverviewResult(data)
    } catch (err) {
      console.error('[用量统计] 概览查询失败:', err)
      setOverviewError('用量概览加载失败，请重试')
    } finally {
      setOverviewLoading(false)
    }
  }, [])

  const loadTrend = React.useCallback(async (nextRange: UsageRange): Promise<void> => {
    setTrendLoading(true)
    setTrendError(null)
    try {
      const data = await window.electronAPI.getUsageStats(createUsageStatsQueryPlan(nextRange).trend)
      setTrendResult(data)
    } catch (err) {
      console.error('[用量统计] 趋势查询失败:', err)
      setTrendError('Token 趋势加载失败，请重试')
    } finally {
      setTrendLoading(false)
    }
  }, [])

  /** 热力图数据独立查询最近 12 个自然月；刷新时可重复调用 */
  const loadHeatmap = React.useCallback(async (): Promise<void> => {
    setHeatmapLoading(true)
    try {
      const { start } = getHeatmapWindow()
      const data = await window.electronAPI.getUsageStats({
        from: startOfUsageWeek(start).getTime(),
        limit: 0,
      })
      setHeatmapByDay(data.byDay)
    } catch (err) {
      console.error('[用量统计] 热力图数据加载失败:', err)
    } finally {
      setHeatmapLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void Promise.all([loadOverview(), loadHeatmap()])
  }, [loadOverview, loadHeatmap])

  React.useEffect(() => {
    void loadTrend(range)
  }, [range, loadTrend])

  /** 刷新全局概览、当前趋势区间与最近 12 个月热力图。 */
  const refreshAll = React.useCallback(async (): Promise<void> => {
    await Promise.all([loadOverview(), loadTrend(range), loadHeatmap()])
  }, [loadOverview, loadTrend, loadHeatmap, range])

  const maxChannelTokens = overviewResult ? Math.max(0, ...overviewResult.byChannel.map((c) => c.totalTokens)) : 0
  const maxModelTokens = overviewResult ? Math.max(0, ...overviewResult.byModel.map((m) => m.totalTokens)) : 0
  const detailEntries = overviewResult?.entries.slice(0, USAGE_DETAIL_LIMIT) ?? []
  const error = overviewError ?? trendError
  const refreshing = overviewLoading || trendLoading || heatmapLoading

  return (
    <SettingsSection title="用量统计" description="查看真实模型请求、运行记录及输入 / 输出 / 缓存 / 费用分布；历史请求数不猜测回填">
      {/* Codex 式统计卡：横排 5 指标，竖向浅灰分隔线 */}
      <SettingsCard divided={false}>
        <UsageStatsSummary result={overviewResult} />
      </SettingsCard>

      {error && (
        <SettingsCard divided={false} className="p-4">
          <div className="text-sm text-destructive">{error}</div>
        </SettingsCard>
      )}

      {/* Token 活动：每日热力图、每周聚合和累计趋势共用最近 12 个月数据。 */}
      <SettingsCard divided={false}>
        <div className="px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-base font-semibold text-foreground">Token 活动</div>
            <CompactSegmentedControl
              value={activityMode}
              options={TOKEN_ACTIVITY_OPTIONS}
              disabled={heatmapLoading}
              onChange={setActivityMode}
              ariaLabel="Token 活动统计方式"
            />
          </div>
          <TokenActivityCalendar
            byDay={heatmapByDay}
            loading={heatmapLoading}
            isDark={isDark}
            mode={activityMode}
          />
        </div>
      </SettingsCard>

      {/* 趋势折线：范围切换与刷新位于标题栏右侧 */}
      <SettingsCard divided={false}>
        <div className="px-4 py-4">
          <div className="mb-3 flex items-center justify-between gap-3 overflow-x-auto pb-0.5">
            <div className="flex-shrink-0 text-sm font-medium text-foreground">总 token 趋势</div>
            <div className="flex flex-shrink-0 items-center gap-1.5">
              <UsageRangeControl value={range} disabled={trendLoading} onChange={setRange} />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void refreshAll()}
                disabled={refreshing}
                className="h-7 w-7 flex-shrink-0"
                aria-label="刷新用量统计与热力图"
                title="刷新"
              >
                <RefreshCw size={14} className={cn(refreshing && 'animate-spin')} />
              </Button>
            </div>
          </div>
          {trendLoading ? (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">加载中…</div>
          ) : trendResult && trendResult.byDay.length > 0 ? (
            <TrendChart byDay={trendResult.byDay} range={range} />
          ) : (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">该区间暂无数据</div>
          )}
        </div>
      </SettingsCard>

      {/* 分组统计 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SettingsCard>
          <div className="px-4 py-3 flex items-center gap-2">
            <Server size={15} className="text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">按渠道</span>
          </div>
          {overviewResult && overviewResult.byChannel.length > 0 ? (
            overviewResult.byChannel.map((item) => <GroupRow key={item.key} item={item} maxTokens={maxChannelTokens} />)
          ) : (
            <div className="px-4 py-6 text-sm text-muted-foreground">暂无数据</div>
          )}
        </SettingsCard>
        <SettingsCard>
          <div className="px-4 py-3 flex items-center gap-2">
            <Layers size={15} className="text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">按模型</span>
          </div>
          {overviewResult && overviewResult.byModel.length > 0 ? (
            overviewResult.byModel.map((item) => <GroupRow key={item.key} item={item} maxTokens={maxModelTokens} />)
          ) : (
            <div className="px-4 py-6 text-sm text-muted-foreground">暂无数据</div>
          )}
        </SettingsCard>
      </div>

      {/* 最近使用明细 */}
      <SettingsCard divided={false}>
        <div className="px-4 py-3 text-sm font-medium text-foreground">最近使用明细</div>
        {detailEntries.length > 0 ? (
          <div className="divide-y divide-border/25">
            {detailEntries.map((entry) => (
              <div key={entry.id} className="px-4 py-2.5 flex items-center gap-3">
                <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0 w-[92px]">{formatDetailTime(entry.timestamp)}</span>
                <ModeBadge mode={entry.mode} />
                <span className="text-sm text-foreground truncate min-w-0 flex-1">
                  {entry.channelName || entry.channelId}
                  {entry.modelId ? <span className="text-muted-foreground"> · {entry.modelId}</span> : null}
                </span>
                <span
                  className="hidden text-xs text-muted-foreground tabular-nums flex-shrink-0 xl:inline"
                  title={`非缓存输入 ${Math.max(0, entry.inputTokens - (entry.cacheReadTokens ?? 0) - (entry.cacheCreationTokens ?? 0)).toLocaleString()} · 缓存读 ${(entry.cacheReadTokens ?? 0).toLocaleString()} · 缓存写 ${(entry.cacheCreationTokens ?? 0).toLocaleString()} · 输出 ${entry.outputTokens.toLocaleString()}`}
                >
                  请求 {entry.providerRequestCount == null ? '--' : `${entry.providerRequestCount}${entry.providerRequestCountAccuracy === 'minimum' ? '+' : ''}`}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">{formatUsageTokens(entry.inputTokens + entry.outputTokens)} Token</span>
                <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0 w-[64px] text-right">{formatUsageCost(entry.costUsd)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-4 py-6 text-sm text-muted-foreground">暂无使用记录</div>
        )}
      </SettingsCard>
    </SettingsSection>
  )
}

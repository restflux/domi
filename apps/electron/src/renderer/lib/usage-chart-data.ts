import type { UsageDayGroup } from '@domi/shared'

export interface UsageWeekGroup extends UsageDayGroup {
  endDate: string
}

function formatLocalDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function cloneLocalDate(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function startOfUsageWeek(date: Date): Date {
  const start = cloneLocalDate(date)
  const day = start.getDay()
  start.setDate(start.getDate() - (day === 0 ? 6 : day - 1))
  return start
}

function emptyUsageDay(date: string): UsageDayGroup {
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
    costUsd: undefined,
  }
}

function addUsage(target: UsageDayGroup, source: UsageDayGroup): void {
  const previousEntryCount = target.entryCount
  target.entryCount += source.entryCount
  target.providerRequestCount += source.providerRequestCount
  target.providerRequestCoverage = previousEntryCount === 0
    ? source.providerRequestCoverage
    : target.providerRequestCoverage === 'complete' && source.providerRequestCoverage === 'complete'
      ? 'complete'
      : target.providerRequestCoverage === 'none' && source.providerRequestCoverage === 'none'
        ? 'none'
        : 'partial'
  target.inputTokens += source.inputTokens
  target.uncachedInputTokens += source.uncachedInputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.cacheCreationTokens += source.cacheCreationTokens
  target.outputTokens += source.outputTokens
  target.totalTokens += source.totalTokens
  if (source.costUsd != null) target.costUsd = Number(((target.costUsd ?? 0) + source.costUsd).toFixed(6))
}

/** 在本地自然日窗口内补齐每日用量。 */
export function buildDailyUsageSeries(
  byDay: UsageDayGroup[],
  start: Date,
  end: Date,
): UsageDayGroup[] {
  const dayMap = new Map(byDay.map((group) => [group.date, group]))
  const points: UsageDayGroup[] = []
  for (const cursor = cloneLocalDate(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const date = formatLocalDate(cursor)
    points.push(dayMap.get(date) ?? emptyUsageDay(date))
  }
  return points
}

/** 按本地周一至周日聚合，并覆盖与查询窗口相交的完整周。 */
export function aggregateUsageByWeek(
  byDay: UsageDayGroup[],
  start: Date,
  end: Date,
): UsageWeekGroup[] {
  const firstWeek = startOfUsageWeek(start)
  const lastWeek = startOfUsageWeek(end)
  const groups = new Map<string, UsageWeekGroup>()

  for (const cursor = new Date(firstWeek); cursor <= lastWeek; cursor.setDate(cursor.getDate() + 7)) {
    const weekStart = cloneLocalDate(cursor)
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekEnd.getDate() + 6)
    const date = formatLocalDate(weekStart)
    groups.set(date, { ...emptyUsageDay(date), endDate: formatLocalDate(weekEnd) })
  }

  for (const day of byDay) {
    const parsed = new Date(`${day.date}T00:00:00`)
    if (!Number.isFinite(parsed.getTime()) || parsed < firstWeek || parsed > end) continue
    const weekKey = formatLocalDate(startOfUsageWeek(parsed))
    const group = groups.get(weekKey)
    if (group) addUsage(group, day)
  }

  return [...groups.values()]
}

/** 将周汇总转换为截至每个周末的累计列。 */
export function buildCumulativeUsageWeeks(weeks: UsageWeekGroup[]): UsageWeekGroup[] {
  const total = emptyUsageDay('')
  return weeks.map((week) => {
    addUsage(total, week)
    return { ...total, date: week.date, endDate: week.endDate }
  })
}

/** 查找某个本地日期所属的周列。 */
export function findUsageWeekColumnIndex(date: string, weeks: UsageWeekGroup[]): number {
  return weeks.findIndex((week) => date >= week.date && date <= week.endDate)
}

/** 根据指针在绘图区的横坐标查找最近的数据点索引。 */
export function findNearestUsagePointIndex(x: number, width: number, count: number): number {
  if (count <= 1 || width <= 0) return 0
  const clamped = Math.max(0, Math.min(width, x))
  return Math.round((clamped / width) * (count - 1))
}


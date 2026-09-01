import type { UsageQueryOptions } from '@domi/shared'

export type UsageRange = 'today' | 'week' | 'month' | 'year' | 'all'

export const USAGE_DETAIL_LIMIT = 20
const DAY_MS = 86_400_000

function startOfToday(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

function startOfWeek(): number {
  const today = startOfToday()
  const day = new Date(today).getDay()
  const offset = day === 0 ? 6 : day - 1
  return today - offset * DAY_MS
}

function startOfMonth(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
}

function rangeStartMs(range: UsageRange): number | undefined {
  switch (range) {
    case 'today':
      return startOfToday()
    case 'week':
      return startOfWeek()
    case 'month':
      return startOfMonth()
    case 'year':
      return Date.now() - 365 * DAY_MS
    case 'all':
      return undefined
  }
}

export function createUsageStatsQueryPlan(range: UsageRange): {
  overview: UsageQueryOptions
  trend: UsageQueryOptions
} {
  return {
    overview: { limit: USAGE_DETAIL_LIMIT },
    trend: { from: rangeStartMs(range), limit: 0 },
  }
}

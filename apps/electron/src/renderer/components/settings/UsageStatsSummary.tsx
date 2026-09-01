import * as React from 'react'
import type { UsageProviderRequestCoverage, UsageQueryResult } from '@domi/shared'

/** 格式化 token 数（中文单位，Codex 风格）。 */
export function formatUsageTokens(value: number | undefined): string {
  if (value == null) return '--'
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/** 格式化已记录费用。 */
export function formatUsageCost(value: number | undefined): string {
  if (value == null) return '--'
  if (value >= 1) return `$${value.toFixed(2)}`
  if (value >= 0.01) return `$${value.toFixed(4)}`
  return `$${value.toFixed(6)}`
}

/** 格式化缓存命中率。 */
export function formatUsagePercent(value: number | undefined): string {
  if (value == null) return '--'
  return `${(value * 100).toFixed(1)}%`
}

export function formatProviderRequestCount(value: number, coverage: UsageProviderRequestCoverage): string {
  if (coverage === 'none') return '--'
  return `${value.toLocaleString()}${coverage === 'partial' ? '+' : ''}`
}

function UsageStat({ label, value, sub, title }: {
  label: string
  value: string
  sub?: string
  title?: string
}): React.ReactElement {
  return (
    <div className="min-w-[128px] flex-1 px-3 py-3 text-center" title={title}>
      <div className="truncate text-lg font-semibold tabular-nums text-foreground">{value}</div>
      <div className="mt-1 truncate text-[11px] text-muted-foreground">{label}</div>
      {sub && <div className="mt-0.5 truncate text-[10px] tabular-nums text-muted-foreground/60">{sub}</div>}
    </div>
  )
}

export function UsageStatsSummary({ result }: { result: UsageQueryResult | null }): React.ReactElement {
  const stats = result?.stats
  const summary = result?.summary
  const costIsPartial = summary?.costIsPartial === true
  const requestCoverage = summary?.providerRequestCoverage ?? 'none'
  const requestSub = requestCoverage === 'none'
    ? '历史未采集请求数'
    : requestCoverage === 'partial'
      ? (summary?.unknownRequestEntryCount ?? 0) > 0
        ? `${summary?.unknownRequestEntryCount ?? 0} 条历史记录未采集`
        : `${summary?.minimumRequestEntryCount ?? 0} 条记录仅确认下限`
      : '逐次采集完整'

  return (
    <div className="grid grid-cols-2 divide-x divide-y divide-border/25 sm:grid-cols-3 xl:grid-cols-5">
      <UsageStat
        label="模型请求"
        value={formatProviderRequestCount(summary?.totalProviderRequests ?? 0, requestCoverage)}
        sub={requestSub}
        title="实际 provider/API 调用次数。+ 表示仅为当前可验证下限，历史记录不会猜测回填。"
      />
      <UsageStat label="运行记录" value={summary ? summary.entryCount.toLocaleString() : '--'} title="usage 结算记录条数，不等同于 provider 请求次数。" />
      <UsageStat label="非缓存输入" value={formatUsageTokens(summary?.totalUncachedInputTokens)} />
      <UsageStat label="缓存读取" value={formatUsageTokens(summary?.totalCacheReadTokens)} />
      <UsageStat label="缓存写入" value={formatUsageTokens(summary?.totalCacheCreationTokens)} />
      <UsageStat label="输入总量" value={formatUsageTokens(summary?.totalInputTokens)} title="非缓存输入 + 缓存读取 + 缓存写入。" />
      <UsageStat label="输出 Token" value={formatUsageTokens(summary?.totalOutputTokens)} />
      <UsageStat label="总 Token" value={formatUsageTokens(stats?.totalTokens)} />
      <UsageStat label="缓存命中率" value={formatUsagePercent(stats?.cacheHitRate)} title="缓存读取 Token / 输入总量。" />
      <UsageStat
        label={costIsPartial ? '已记录费用' : '费用'}
        value={formatUsageCost(stats?.costUsd)}
        sub={costIsPartial ? `${summary?.unpricedEntryCount ?? 0} 条运行记录暂无费用` : undefined}
      />
    </div>
  )
}

/**
 * Token 使用记录服务
 *
 * 将 Chat / Agent 每次运行结算的 token、真实 provider 请求数与费用追加式持久化到
 * ~/.domi/usage-entries.jsonl（每行一条 JSON），并提供读取与聚合查询。
 *
 * 设计遵循项目的本地存储约定：JSON + JSONL 追加日志，无本地数据库，文件可移植。
 */

import { appendFileSync, createReadStream, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type {
  UsageEntry,
  UsageProviderRequestCoverage,
  UsageQueryOptions,
  UsageQueryResult,
  UsageSummary,
  UsageDayGroup,
  UsageGroupItem,
  UsageStats,
} from '@domi/shared'
import { getUsageEntriesPath } from './config-paths'

/** 单次返回的明细条数上限；聚合仍覆盖全部匹配记录。 */
const MAX_QUERY_LIMIT = 10_000
const DEFAULT_QUERY_LIMIT = 1_000
const MAX_USAGE_LINE_BYTES = 1 * 1024 * 1024

/**
 * 追加一条 token 使用记录
 *
 * @param entry 使用记录（id 缺失时自动生成）
 */
export function appendUsageEntry(entry: Omit<UsageEntry, 'id'> & { id?: string }): UsageEntry {
  const full: UsageEntry = { ...entry, id: entry.id ?? randomUUID() }
  if (!isUsageEntry(full)) throw new Error('token 使用记录字段无效')
  try {
    appendFileSync(getUsageEntriesPath(), `${JSON.stringify(full)}\n`, 'utf8')
  } catch (error) {
    console.error('[用量记录] 写入 usage-entries.jsonl 失败:', error)
    throw new Error('写入 token 使用记录失败')
  }
  return full
}

/**
 * 按条件查询使用记录。JSONL 按行流式扫描，聚合覆盖全部匹配记录，
 * entries 只保留时间最新的有限明细，避免明细 limit 截断统计。
 */
export async function queryUsage(options?: UsageQueryOptions): Promise<UsageQueryResult> {
  const path = getUsageEntriesPath()
  const limit = normalizeQueryLimit(options?.limit)
  if (!existsSync(path)) return emptyUsageQueryResult()

  const entries: UsageEntry[] = []
  const summaryAccumulator = createUsageSummaryAccumulator()
  const dayMap = new Map<string, UsageDayAccumulator>()
  const channelMap = new Map<string, UsageGroupAccumulator>()
  const modelMap = new Map<string, UsageGroupAccumulator>()
  const seenIds = new Set<string>()

  try {
    for await (const line of readBoundedUsageLines(path)) {
      const entry = parseUsageEntry(line)
      if (!entry || seenIds.has(entry.id)) continue
      seenIds.add(entry.id)
      if (!matches(entry, options)) continue
      addUsageToSummary(summaryAccumulator, entry)
      addUsageToDayMap(dayMap, entry)
      addUsageToGroupMap(channelMap, entry, {
        key: entry.channelId || 'unknown',
        name: entry.channelName || entry.channelId || '未知渠道',
      })
      addUsageToGroupMap(modelMap, entry, {
        key: entry.modelId || 'unknown',
        name: entry.modelId || '未知模型',
      })
      insertLatestUsageEntry(entries, entry, limit)
    }
  } catch (error) {
    console.error('[用量记录] 读取 usage-entries.jsonl 失败:', error)
    return emptyUsageQueryResult()
  }

  const summary = finishUsageSummary(summaryAccumulator)
  const byDay = [...dayMap.values()].map(finishUsageDayGroup).sort((a, b) => a.date.localeCompare(b.date))
  const byChannel = [...channelMap.values()].map(finishUsageGroupItem).sort((a, b) => b.totalTokens - a.totalTokens)
  const byModel = [...modelMap.values()].map(finishUsageGroupItem).sort((a, b) => b.totalTokens - a.totalTokens)
  return {
    entries,
    summary,
    byDay,
    byChannel,
    byModel,
    stats: calculateUsageStatsFromAggregates(summary, byDay),
  }
}

/** 兼容只读取明细的调用；新聚合查询应使用 queryUsage。 */
export async function queryUsageEntries(options?: UsageQueryOptions): Promise<UsageEntry[]> {
  return (await queryUsage(options)).entries
}

function normalizeQueryLimit(limit: number | undefined): number {
  if (limit == null) return DEFAULT_QUERY_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 0) return DEFAULT_QUERY_LIMIT
  return Math.min(limit, MAX_QUERY_LIMIT)
}

function compareUsageEntriesNewestFirst(a: UsageEntry, b: UsageEntry): number {
  return b.timestamp - a.timestamp || b.id.localeCompare(a.id)
}

function insertLatestUsageEntry(entries: UsageEntry[], entry: UsageEntry, limit: number): void {
  if (limit <= 0) return
  let low = 0
  let high = entries.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (compareUsageEntriesNewestFirst(entry, entries[middle]!) < 0) high = middle
    else low = middle + 1
  }
  entries.splice(low, 0, entry)
  if (entries.length > limit) entries.pop()
}

async function* readBoundedUsageLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path)
  let chunks: Buffer[] = []
  let lineBytes = 0
  let discardingOversizedLine = false

  const finishLine = (): string | undefined => {
    if (discardingOversizedLine) return undefined
    let line = Buffer.concat(chunks, lineBytes)
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1)
    return line.toString('utf8')
  }

  try {
    for await (const rawChunk of input) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
      let offset = 0
      while (offset < chunk.length) {
        const newlineIndex = chunk.indexOf(0x0a, offset)
        const end = newlineIndex >= 0 ? newlineIndex : chunk.length
        if (!discardingOversizedLine && end > offset) {
          const segment = chunk.subarray(offset, end)
          lineBytes += segment.length
          if (lineBytes > MAX_USAGE_LINE_BYTES) {
            chunks = []
            lineBytes = 0
            discardingOversizedLine = true
          } else {
            chunks.push(segment)
          }
        }
        if (newlineIndex >= 0) {
          const line = finishLine()
          if (line !== undefined) yield line
          chunks = []
          lineBytes = 0
          discardingOversizedLine = false
          offset = newlineIndex + 1
        } else {
          offset = chunk.length
        }
      }
    }
    const line = finishLine()
    if (line !== undefined && (lineBytes > 0 || chunks.length > 0)) yield line
  } finally {
    input.destroy()
  }
}

function parseUsageEntry(line: string): UsageEntry | undefined {
  const trimmed = line.trim()
  if (!trimmed) return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    return isUsageEntry(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isOptionalNonNegativeFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isNonNegativeFiniteNumber(value)
}

function isUsageEntry(value: unknown): value is UsageEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<UsageEntry>
  return typeof entry.id === 'string'
    && entry.id.length > 0
    && isNonNegativeFiniteNumber(entry.timestamp)
    && (entry.mode === 'chat' || entry.mode === 'agent')
    && typeof entry.channelId === 'string'
    && isOptionalString(entry.channelName)
    && isOptionalString(entry.provider)
    && isOptionalString(entry.modelId)
    && isOptionalString(entry.sessionId)
    && isOptionalString(entry.title)
    && isNonNegativeFiniteNumber(entry.inputTokens)
    && isNonNegativeFiniteNumber(entry.outputTokens)
    && isOptionalNonNegativeFiniteNumber(entry.cacheReadTokens)
    && isOptionalNonNegativeFiniteNumber(entry.cacheCreationTokens)
    && isOptionalNonNegativeFiniteNumber(entry.costUsd)
    && isOptionalNonNegativeFiniteNumber(entry.durationMs)
    && isValidProviderRequestCount(entry.providerRequestCount, entry.providerRequestCountAccuracy)
}

function isValidProviderRequestCount(
  count: UsageEntry['providerRequestCount'],
  accuracy: UsageEntry['providerRequestCountAccuracy'],
): boolean {
  if (count === undefined && accuracy === undefined) return true
  return Number.isSafeInteger(count)
    && (count ?? 0) > 0
    && (accuracy === 'exact' || accuracy === 'minimum')
}

/** 判断单条记录是否满足过滤条件 */
function matches(entry: UsageEntry, options?: UsageQueryOptions): boolean {
  if (!options) return true
  const { from, to, mode, channelId } = options
  if (from != null && entry.timestamp < from) return false
  if (to != null && entry.timestamp > to) return false
  if (mode != null && entry.mode !== mode) return false
  if (channelId != null && entry.channelId !== channelId) return false
  return true
}

interface RequestCoverageAccumulator {
  exactRequestEntryCount: number
  minimumRequestEntryCount: number
  unknownRequestEntryCount: number
}

interface UsageSummaryAccumulator extends UsageSummary, RequestCoverageAccumulator {
  costSum: number
}

interface UsageDayAccumulator extends UsageDayGroup, RequestCoverageAccumulator {}
interface UsageGroupAccumulator extends UsageGroupItem, RequestCoverageAccumulator {}

function createUsageSummaryAccumulator(): UsageSummaryAccumulator {
  return {
    entryCount: 0,
    totalProviderRequests: 0,
    providerRequestCoverage: 'none',
    exactRequestEntryCount: 0,
    minimumRequestEntryCount: 0,
    unknownRequestEntryCount: 0,
    totalInputTokens: 0,
    totalUncachedInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalTokens: 0,
    pricedEntryCount: 0,
    unpricedEntryCount: 0,
    costIsPartial: false,
    totalCostUsd: undefined,
    costSum: 0,
  }
}

function addRequestCoverage(target: RequestCoverageAccumulator, entry: UsageEntry): number {
  if (entry.providerRequestCount == null || entry.providerRequestCountAccuracy == null) {
    target.unknownRequestEntryCount += 1
    return 0
  }
  if (entry.providerRequestCountAccuracy === 'exact') target.exactRequestEntryCount += 1
  else target.minimumRequestEntryCount += 1
  return entry.providerRequestCount
}

function resolveProviderRequestCoverage(coverage: RequestCoverageAccumulator): UsageProviderRequestCoverage {
  if (coverage.exactRequestEntryCount === 0 && coverage.minimumRequestEntryCount === 0) return 'none'
  if (coverage.unknownRequestEntryCount === 0 && coverage.minimumRequestEntryCount === 0) return 'complete'
  return 'partial'
}

function resolveUncachedInputTokens(entry: Pick<UsageEntry, 'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'>): number {
  return Math.max(0, entry.inputTokens - (entry.cacheReadTokens ?? 0) - (entry.cacheCreationTokens ?? 0))
}

function addUsageToSummary(summary: UsageSummaryAccumulator, entry: UsageEntry): void {
  summary.entryCount += 1
  summary.totalProviderRequests += addRequestCoverage(summary, entry)
  summary.providerRequestCoverage = resolveProviderRequestCoverage(summary)
  summary.totalInputTokens += entry.inputTokens
  summary.totalUncachedInputTokens += resolveUncachedInputTokens(entry)
  summary.totalOutputTokens += entry.outputTokens
  summary.totalCacheReadTokens += entry.cacheReadTokens ?? 0
  summary.totalCacheCreationTokens += entry.cacheCreationTokens ?? 0
  summary.totalTokens += entry.inputTokens + entry.outputTokens
  if (entry.costUsd != null) {
    summary.pricedEntryCount += 1
    summary.costSum += entry.costUsd
  } else {
    summary.unpricedEntryCount += 1
  }
}

function finishUsageSummary(accumulator: UsageSummaryAccumulator): UsageSummary {
  const { costSum, ...summary } = accumulator
  summary.costIsPartial = summary.pricedEntryCount > 0 && summary.unpricedEntryCount > 0
  summary.totalCostUsd = summary.pricedEntryCount > 0 ? Number(costSum.toFixed(6)) : undefined
  return summary
}

function createUsageDayAccumulator(date: string): UsageDayAccumulator {
  return {
    date,
    entryCount: 0,
    providerRequestCount: 0,
    providerRequestCoverage: 'none',
    exactRequestEntryCount: 0,
    minimumRequestEntryCount: 0,
    unknownRequestEntryCount: 0,
    inputTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: undefined,
  }
}

function addUsageToDayMap(map: Map<string, UsageDayAccumulator>, entry: UsageEntry): void {
  const date = formatLocalDate(entry.timestamp)
  let group = map.get(date)
  if (!group) {
    group = createUsageDayAccumulator(date)
    map.set(date, group)
  }
  group.entryCount += 1
  group.providerRequestCount += addRequestCoverage(group, entry)
  group.providerRequestCoverage = resolveProviderRequestCoverage(group)
  group.inputTokens += entry.inputTokens
  group.uncachedInputTokens += resolveUncachedInputTokens(entry)
  group.cacheReadTokens += entry.cacheReadTokens ?? 0
  group.cacheCreationTokens += entry.cacheCreationTokens ?? 0
  group.outputTokens += entry.outputTokens
  group.totalTokens += entry.inputTokens + entry.outputTokens
  if (entry.costUsd != null) group.costUsd = Number(((group.costUsd ?? 0) + entry.costUsd).toFixed(6))
}

function finishUsageDayGroup(accumulator: UsageDayAccumulator): UsageDayGroup {
  const { exactRequestEntryCount: _exact, minimumRequestEntryCount: _minimum, unknownRequestEntryCount: _unknown, ...group } = accumulator
  return group
}

function createUsageGroupAccumulator(identity: { key: string; name: string }): UsageGroupAccumulator {
  return {
    ...identity,
    entryCount: 0,
    providerRequestCount: 0,
    providerRequestCoverage: 'none',
    exactRequestEntryCount: 0,
    minimumRequestEntryCount: 0,
    unknownRequestEntryCount: 0,
    inputTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: undefined,
  }
}

function addUsageToGroupMap(
  map: Map<string, UsageGroupAccumulator>,
  entry: UsageEntry,
  identity: { key: string; name: string },
): void {
  let group = map.get(identity.key)
  if (!group) {
    group = createUsageGroupAccumulator(identity)
    map.set(identity.key, group)
  }
  group.entryCount += 1
  group.providerRequestCount += addRequestCoverage(group, entry)
  group.providerRequestCoverage = resolveProviderRequestCoverage(group)
  group.inputTokens += entry.inputTokens
  group.uncachedInputTokens += resolveUncachedInputTokens(entry)
  group.cacheReadTokens += entry.cacheReadTokens ?? 0
  group.cacheCreationTokens += entry.cacheCreationTokens ?? 0
  group.outputTokens += entry.outputTokens
  group.totalTokens += entry.inputTokens + entry.outputTokens
  if (entry.costUsd != null) group.costUsd = Number(((group.costUsd ?? 0) + entry.costUsd).toFixed(6))
}

function finishUsageGroupItem(accumulator: UsageGroupAccumulator): UsageGroupItem {
  const { exactRequestEntryCount: _exact, minimumRequestEntryCount: _minimum, unknownRequestEntryCount: _unknown, ...group } = accumulator
  return group
}

function emptyUsageQueryResult(): UsageQueryResult {
  const summary = finishUsageSummary(createUsageSummaryAccumulator())
  return {
    entries: [],
    summary,
    byDay: [],
    byChannel: [],
    byModel: [],
    stats: calculateUsageStatsFromAggregates(summary, []),
  }
}

/**
 * 聚合使用记录为摘要
 *
 * @param entries 使用记录（通常来自 queryUsageEntries）
 */
export function summarizeUsage(entries: UsageEntry[]): UsageSummary {
  const summary = createUsageSummaryAccumulator()
  for (const entry of entries) addUsageToSummary(summary, entry)
  return finishUsageSummary(summary)
}

/**
 * 按本地日期分组聚合（时间升序）
 *
 * @param entries 使用记录（通常来自 queryUsageEntries）
 */
export function groupUsageByDay(entries: UsageEntry[]): UsageDayGroup[] {
  const map = new Map<string, UsageDayAccumulator>()
  for (const entry of entries) addUsageToDayMap(map, entry)
  return [...map.values()].map(finishUsageDayGroup).sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 按渠道分组聚合（按 totalTokens 降序）
 *
 * @param entries 使用记录
 */
export function groupUsageByChannel(entries: UsageEntry[]): UsageGroupItem[] {
  return groupUsageByKey(entries, (entry) => ({
    key: entry.channelId || 'unknown',
    name: entry.channelName || entry.channelId || '未知渠道',
  }))
}

/**
 * 按模型分组聚合（按 totalTokens 降序）
 *
 * @param entries 使用记录
 */
export function groupUsageByModel(entries: UsageEntry[]): UsageGroupItem[] {
  return groupUsageByKey(entries, (entry) => ({
    key: entry.modelId || 'unknown',
    name: entry.modelId || '未知模型',
  }))
}

/** 按任意键分组聚合的通用实现 */
function groupUsageByKey(
  entries: UsageEntry[],
  resolveKey: (entry: UsageEntry) => { key: string; name: string },
): UsageGroupItem[] {
  const map = new Map<string, UsageGroupAccumulator>()
  for (const entry of entries) addUsageToGroupMap(map, entry, resolveKey(entry))
  return [...map.values()].map(finishUsageGroupItem).sort((a, b) => b.totalTokens - a.totalTokens)
}

/** 本地时区日期格式化 YYYY-MM-DD（不使用 toISOString，避免 UTC 偏移） */
function formatLocalDate(timestamp: number): string {
  const d = new Date(timestamp)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/**
 * 计算五张统计卡的可信指标。
 * 当天用量按本地自然日统计；缓存命中率严格使用缓存读取 token / 输入 token。
 */
export function calculateUsageStats(entries: UsageEntry[]): UsageStats {
  return calculateUsageStatsFromAggregates(summarizeUsage(entries), groupUsageByDay(entries))
}

function calculateUsageStatsFromAggregates(summary: UsageSummary, byDay: UsageDayGroup[]): UsageStats {
  const today = formatLocalDate(Date.now())
  let peakDay: UsageStats['peakDay']
  let todayTokens = 0
  for (const group of byDay) {
    if (!peakDay || group.totalTokens > peakDay.totalTokens) {
      peakDay = { date: group.date, totalTokens: group.totalTokens }
    }
    if (group.date === today) todayTokens = group.totalTokens
  }

  return {
    totalTokens: summary.totalTokens,
    todayTokens,
    cacheHitRate: summary.totalInputTokens > 0
      ? summary.totalCacheReadTokens / summary.totalInputTokens
      : undefined,
    peakDay,
    costUsd: summary.totalCostUsd,
  }
}

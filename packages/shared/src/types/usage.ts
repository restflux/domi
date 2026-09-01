/**
 * Token 使用记录类型
 *
 * Chat 与 Agent 模式统一的 token / 费用使用记录，追加式持久化到
 * ~/.domi/usage-entries.jsonl（每行一条 JSON），供后续统计面板聚合。
 */

/** 使用记录来源模式 */
export type UsageRecordMode = 'chat' | 'agent'

/**
 * provider 请求数的可信度。
 * - exact：当前记录覆盖的请求数可逐次验证；
 * - minimum：兼容端点只返回聚合 result，至少确认发生过这些请求。
 */
export type UsageProviderRequestCountAccuracy = 'exact' | 'minimum'

/** 聚合后的 provider 请求数覆盖状态。 */
export type UsageProviderRequestCoverage = 'complete' | 'partial' | 'none'

/** 单条 token 使用记录 */
export interface UsageEntry {
  /** 记录唯一 ID */
  id: string
  /** 记录时间（毫秒时间戳） */
  timestamp: number
  /** 模式：Chat / Agent */
  mode: UsageRecordMode
  /** 渠道 ID */
  channelId: string
  /** 渠道名称（冗余，便于面板直接展示，避免关联查询） */
  channelName?: string
  /** Provider 类型标识 */
  provider?: string
  /** 模型 ID */
  modelId?: string
  /** 会话 ID（Agent sessionId 或 Chat conversationId） */
  sessionId?: string
  /** 会话标题（冗余，便于面板直接展示） */
  title?: string
  /** 输入总 token 数（非缓存输入 + 缓存读取 + 缓存写入） */
  inputTokens: number
  /** 输出 token 数 */
  outputTokens: number
  /** 缓存读取 token 数 */
  cacheReadTokens?: number
  /** 缓存写入 token 数 */
  cacheCreationTokens?: number
  /** 估算费用（美元） */
  costUsd?: number
  /** 本轮耗时（毫秒） */
  durationMs?: number
  /** 本条结算记录内真实发生的 provider/API 请求数；历史记录可能缺失。 */
  providerRequestCount?: number
  /** providerRequestCount 的可信度；有计数时必填。 */
  providerRequestCountAccuracy?: UsageProviderRequestCountAccuracy
}

/** 读取使用记录的过滤条件 */
export interface UsageQueryOptions {
  /** 起始时间（毫秒时间戳，含） */
  from?: number
  /** 结束时间（毫秒时间戳，含） */
  to?: number
  /** 模式过滤 */
  mode?: UsageRecordMode
  /** 渠道 ID 过滤 */
  channelId?: string
  /** 最多返回的最新明细条数（默认 1000）；不限制聚合范围。 */
  limit?: number
}

/** 使用记录聚合摘要 */
export interface UsageSummary {
  /** 运行结算记录条数，不等同于 provider/API 请求数。 */
  entryCount: number
  /** 已有可信计数覆盖的 provider/API 请求数下限。 */
  totalProviderRequests: number
  /** provider 请求计数覆盖状态。 */
  providerRequestCoverage: UsageProviderRequestCoverage
  /** 请求数可精确验证的结算记录数。 */
  exactRequestEntryCount: number
  /** 只能确认请求数下限的结算记录数。 */
  minimumRequestEntryCount: number
  /** 历史或兼容数据中没有请求数的结算记录数。 */
  unknownRequestEntryCount: number
  /** 输入 token 合计（非缓存输入 + 缓存读取 + 缓存写入）。 */
  totalInputTokens: number
  /** 非缓存输入 token 合计。 */
  totalUncachedInputTokens: number
  /** 输出 token 合计 */
  totalOutputTokens: number
  /** 缓存读取 token 合计 */
  totalCacheReadTokens: number
  /** 缓存写入 token 合计 */
  totalCacheCreationTokens: number
  /** 总 token 合计 */
  totalTokens: number
  /** 有明确费用数据的记录数。 */
  pricedEntryCount: number
  /** 没有费用数据的记录数。 */
  unpricedEntryCount: number
  /** 是否存在未计费记录；为 true 时 totalCostUsd 只是已记录费用。 */
  costIsPartial: boolean
  /** 已记录费用合计（美元）；没有任何费用数据时为 undefined。 */
  totalCostUsd?: number
}

/** 按天聚合的用量数据（热力图 / 趋势图用） */
export interface UsageDayGroup {
  /** 本地日期 YYYY-MM-DD */
  date: string
  /** 当天运行结算记录数。 */
  entryCount: number
  /** 当天已统计的 provider/API 请求数下限。 */
  providerRequestCount: number
  /** 当天 provider 请求数覆盖状态。 */
  providerRequestCoverage: UsageProviderRequestCoverage
  /** 当天输入 token（含缓存读写）。 */
  inputTokens: number
  /** 当天非缓存输入 token。 */
  uncachedInputTokens: number
  /** 当天缓存读取 token。 */
  cacheReadTokens: number
  /** 当天缓存写入 token。 */
  cacheCreationTokens: number
  /** 当天输出 token */
  outputTokens: number
  /** 当天总 token */
  totalTokens: number
  /** 当天费用（美元） */
  costUsd?: number
}

/** 按渠道 / 模型聚合的单项数据 */
export interface UsageGroupItem {
  /** 分组键（渠道 ID / 模型 ID） */
  key: string
  /** 展示名称 */
  name: string
  /** 运行结算记录数。 */
  entryCount: number
  /** 已统计的 provider/API 请求数下限。 */
  providerRequestCount: number
  /** provider 请求数覆盖状态。 */
  providerRequestCoverage: UsageProviderRequestCoverage
  /** 输入 token（含缓存读写）。 */
  inputTokens: number
  /** 非缓存输入 token。 */
  uncachedInputTokens: number
  /** 缓存读取 token。 */
  cacheReadTokens: number
  /** 缓存写入 token。 */
  cacheCreationTokens: number
  /** 输出 token */
  outputTokens: number
  /** 总 token */
  totalTokens: number
  /** 费用（美元） */
  costUsd?: number
}

/** 单日峰值用量 */
export interface UsagePeakDay {
  /** 本地日期 YYYY-MM-DD */
  date: string
  /** 当天总 token */
  totalTokens: number
}

/** 用量统计卡指标（Codex Token 活动风格） */
export interface UsageStats {
  /** 查询区间内累计总 token。 */
  totalTokens: number
  /** 本地自然日当天的输入 + 输出 token。 */
  todayTokens: number
  /** 缓存读取 token / 输入 token；输入为 0 时不可用。 */
  cacheHitRate?: number
  /** 单日峰值（无数据时 undefined）。 */
  peakDay?: UsagePeakDay
  /** 已记录费用合计（美元）；覆盖状态见 summary.costIsPartial。 */
  costUsd?: number
}

/** 用量查询完整结果（面板一次获取） */
export interface UsageQueryResult {
  /** 最新匹配条目（时间倒序，受 limit 截断）；其余聚合覆盖全部匹配记录。 */
  entries: UsageEntry[]
  /** 条目汇总 */
  summary: UsageSummary
  /** 按天分组（时间升序） */
  byDay: UsageDayGroup[]
  /** 按渠道分组（按 totalTokens 降序） */
  byChannel: UsageGroupItem[]
  /** 按模型分组（按 totalTokens 降序） */
  byModel: UsageGroupItem[]
  /** 统计卡指标（累计、当天、峰值、缓存命中率与费用）。 */
  stats: UsageStats
}

/** Token 用量 IPC 通道 */
export const USAGE_IPC_CHANNELS = {
  /** 查询用量统计（条目 + 摘要 + 分组） */
  QUERY: 'usage:query',
} as const

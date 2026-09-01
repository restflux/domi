import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

type UsageRecordService = typeof import('./usage-record-service')

let service: UsageRecordService
let tempHome: string
const originalHome = process.env.HOME
const originalDomiDev = process.env.DOMI_DEV

mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => join(process.env.HOME ?? tempHome, 'Library', 'Application Support'),
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

mock.module('node:os', () => ({
  ...os,
  homedir: () => tempHome,
}))

beforeAll(async () => {
  tempHome = mkdtempSync(join(os.tmpdir(), 'domi-usage-test-'))
  process.env.DOMI_DEV = ''
  service = await import('./usage-record-service')
})

afterAll(() => {
  rmSync(tempHome, { recursive: true, force: true })
  if (originalHome !== undefined) process.env.HOME = originalHome
  if (originalDomiDev !== undefined) process.env.DOMI_DEV = originalDomiDev
})

function usageEntriesPath(): string {
  return join(tempHome, '.domi', 'usage-entries.jsonl')
}

/** 本地日期（N 天前）YYYY-MM-DD */
function localDateDaysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** 本地时间（N 天前中午）毫秒时间戳 */
function localNoonDaysAgo(days: number): number {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(12, 0, 0, 0)
  return d.getTime()
}

// 每个测试独立：清空使用记录文件，避免用例间残留
beforeEach(() => {
  rmSync(usageEntriesPath(), { force: true })
})

describe('usage-record-service', () => {
  test('Given 从未写入 When appendUsageEntry Then 文件被创建且记录可读回', async () => {
    const entry = service.appendUsageEntry({
      timestamp: 1_700_000_000_000,
      mode: 'agent',
      channelId: 'ch-1',
      channelName: 'DeepSeek',
      provider: 'deepseek',
      modelId: 'deepseek-v4-flash',
      sessionId: 'sess-1',
      title: '测试会话',
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 500,
      costUsd: 0.001,
    })

    expect(entry.id).toBeString()
    expect(existsSync(usageEntriesPath())).toBe(true)

    const entries = await service.queryUsageEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      mode: 'agent',
      channelId: 'ch-1',
      inputTokens: 1_000,
      outputTokens: 200,
      costUsd: 0.001,
    })
  })

  test('Given JSONL 重复出现相同 ID When queryUsage Then 只聚合一次', async () => {
    const path = usageEntriesPath()
    const duplicate = JSON.stringify({
      id: 'same-id', timestamp: 2_000, mode: 'agent', channelId: 'a',
      inputTokens: 100, outputTokens: 10, providerRequestCount: 2,
      providerRequestCountAccuracy: 'exact',
    })
    writeFileSync(path, `${duplicate}\n${duplicate}\n`, 'utf8')

    const result = await service.queryUsage()

    expect(result.entries).toHaveLength(1)
    expect(result.summary.entryCount).toBe(1)
    expect(result.summary.totalProviderRequests).toBe(2)
    expect(result.summary.totalTokens).toBe(110)
  })

  test('Given 多条记录 When queryUsageEntries Then 按时间倒序返回', async () => {
    service.appendUsageEntry({ timestamp: 1_000, mode: 'chat', channelId: 'a', inputTokens: 10, outputTokens: 1 })
    service.appendUsageEntry({ timestamp: 3_000, mode: 'chat', channelId: 'a', inputTokens: 30, outputTokens: 3 })
    service.appendUsageEntry({ timestamp: 2_000, mode: 'agent', channelId: 'b', inputTokens: 20, outputTokens: 2 })

    const entries = await service.queryUsageEntries()
    expect(entries.map((e) => e.timestamp)).toEqual([3_000, 2_000, 1_000])
  })

  test('Given 匹配记录超过明细上限 When queryUsage Then entries 只返回最新记录但聚合覆盖全部记录', async () => {
    service.appendUsageEntry({ timestamp: 1_000, mode: 'chat', channelId: 'a', inputTokens: 10, outputTokens: 1 })
    service.appendUsageEntry({ timestamp: 2_000, mode: 'chat', channelId: 'a', inputTokens: 20, outputTokens: 2 })
    service.appendUsageEntry({ timestamp: 3_000, mode: 'agent', channelId: 'b', inputTokens: 30, outputTokens: 3 })

    const result = await service.queryUsage({ limit: 2 })

    expect(result.entries.map((entry) => entry.timestamp)).toEqual([3_000, 2_000])
    expect(result.summary.entryCount).toBe(3)
    expect(result.summary.totalTokens).toBe(66)
    expect(result.byChannel.map((group) => group.key)).toEqual(['a', 'b'])
  })

  test('Given 多条记录 When 按时间范围 / mode / channelId 过滤 Then 只返回匹配记录', async () => {
    service.appendUsageEntry({ timestamp: 1_000, mode: 'chat', channelId: 'a', inputTokens: 10, outputTokens: 1 })
    service.appendUsageEntry({ timestamp: 3_000, mode: 'chat', channelId: 'a', inputTokens: 30, outputTokens: 3 })
    service.appendUsageEntry({ timestamp: 2_000, mode: 'agent', channelId: 'b', inputTokens: 20, outputTokens: 2 })

    const entries = await service.queryUsageEntries({ from: 1_500, to: 2_500 })
    expect(entries.map((e) => e.timestamp)).toEqual([2_000])

    const chatEntries = await service.queryUsageEntries({ mode: 'chat' })
    expect(chatEntries).toHaveLength(2)

    const channelB = await service.queryUsageEntries({ channelId: 'b' })
    expect(channelB).toHaveLength(1)
    expect(channelB[0]?.mode).toBe('agent')
  })

  test('Given 文件中有坏行 When queryUsageEntries Then 跳过坏行并正常返回其余记录', async () => {
    service.appendUsageEntry({ timestamp: 5_000, mode: 'chat', channelId: 'c', inputTokens: 50, outputTokens: 5 })
    const path = usageEntriesPath()
    writeFileSync(path, `${readFileSync(path, 'utf8')}{bad json}\n`, 'utf8')

    const entries = await service.queryUsageEntries()
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      expect(entry.id).toBeString()
    }
  })

  test('Given 新旧记录混合 When summarizeUsage Then 精确拆分 token 并标记模型请求统计覆盖', () => {
    const summary = service.summarizeUsage([
      {
        id: '1', timestamp: 1, mode: 'chat', channelId: 'a', inputTokens: 100, outputTokens: 10,
        cacheReadTokens: 30, cacheCreationTokens: 5, providerRequestCount: 2,
        providerRequestCountAccuracy: 'exact', costUsd: 0.001,
      },
      {
        id: '2', timestamp: 2, mode: 'agent', channelId: 'b', inputTokens: 200, outputTokens: 20,
        cacheReadTokens: 120, providerRequestCount: 1, providerRequestCountAccuracy: 'minimum',
      },
      { id: '3', timestamp: 3, mode: 'chat', channelId: 'a', inputTokens: 300, outputTokens: 30, costUsd: 0.003 },
    ])

    expect(summary.entryCount).toBe(3)
    expect(summary.totalProviderRequests).toBe(3)
    expect(summary.providerRequestCoverage).toBe('partial')
    expect(summary.exactRequestEntryCount).toBe(1)
    expect(summary.minimumRequestEntryCount).toBe(1)
    expect(summary.unknownRequestEntryCount).toBe(1)
    expect(summary.totalInputTokens).toBe(600)
    expect(summary.totalUncachedInputTokens).toBe(445)
    expect(summary.totalOutputTokens).toBe(60)
    expect(summary.totalCacheReadTokens).toBe(150)
    expect(summary.totalCacheCreationTokens).toBe(5)
    expect(summary.totalTokens).toBe(660)
    expect(summary.totalCostUsd).toBe(0.004)
    expect(summary.pricedEntryCount).toBe(2)
    expect(summary.unpricedEntryCount).toBe(1)
    expect(summary.costIsPartial).toBe(true)
  })

  test('Given 无费用记录 When summarizeUsage Then totalCostUsd 为 undefined', () => {
    const summary = service.summarizeUsage([
      { id: '1', timestamp: 1, mode: 'chat', channelId: 'a', inputTokens: 100, outputTokens: 10 },
    ])
    expect(summary.totalCostUsd).toBeUndefined()
    expect(summary.pricedEntryCount).toBe(0)
    expect(summary.unpricedEntryCount).toBe(1)
    expect(summary.costIsPartial).toBe(false)
  })

  test('Given 文件不存在 When queryUsageEntries Then 返回空数组', async () => {
    rmSync(usageEntriesPath(), { force: true })
    expect(await service.queryUsageEntries()).toEqual([])
  })

  test('Given 跨天边界的记录 When groupUsageByDay Then 按本地日期分组且时间升序', () => {
    // 本地时区 23:59 与次日 00:01 属于不同自然日（不依赖运行环境时区）
    const day1Late = new Date(2026, 0, 1, 23, 59).getTime()
    const day2Early = new Date(2026, 0, 2, 0, 1).getTime()
    const day1Early = new Date(2026, 0, 1, 0, 1).getTime()

    const groups = service.groupUsageByDay([
      { id: '1', timestamp: day1Late, mode: 'chat', channelId: 'a', inputTokens: 100, outputTokens: 10 },
      { id: '2', timestamp: day2Early, mode: 'chat', channelId: 'a', inputTokens: 200, outputTokens: 20 },
      { id: '3', timestamp: day1Early, mode: 'agent', channelId: 'b', inputTokens: 300, outputTokens: 30, costUsd: 0.01 },
    ])

    expect(groups.map((g) => g.date)).toEqual(['2026-01-01', '2026-01-02'])
    expect(groups[0]).toMatchObject({ entryCount: 2, inputTokens: 400, outputTokens: 40, totalTokens: 440 })
    expect(groups[1]).toMatchObject({ entryCount: 1, inputTokens: 200, outputTokens: 20, totalTokens: 220 })
    // 费用只出现在带 cost 的那天（day1 的凌晨记录带 0.01 费用）
    expect(groups[0]?.costUsd).toBe(0.01)
    expect(groups[1]?.costUsd).toBeUndefined()
  })

  test('Given 多条记录 When groupUsageByChannel Then 按 totalTokens 降序且使用渠道名称', () => {
    const groups = service.groupUsageByChannel([
      { id: '1', timestamp: 1, mode: 'chat', channelId: 'ch-b', channelName: 'DeepSeek', inputTokens: 100, outputTokens: 10 },
      { id: '2', timestamp: 2, mode: 'agent', channelId: 'ch-a', channelName: 'Anthropic', inputTokens: 500, outputTokens: 50, costUsd: 0.5 },
      { id: '3', timestamp: 3, mode: 'chat', channelId: '', inputTokens: 50, outputTokens: 5 },
    ])

    expect(groups).toHaveLength(3)
    expect(groups[0]).toMatchObject({ key: 'ch-a', name: 'Anthropic', totalTokens: 550, costUsd: 0.5 })
    expect(groups[1]).toMatchObject({ key: 'ch-b', name: 'DeepSeek', totalTokens: 110 })
    // 无渠道 ID 的记录归入 unknown
    expect(groups[2]).toMatchObject({ key: 'unknown', name: '未知渠道', totalTokens: 55 })
  })

  test('Given 多条记录 When groupUsageByModel Then 按 totalTokens 降序且缺失模型归入 unknown', () => {
    const groups = service.groupUsageByModel([
      { id: '1', timestamp: 1, mode: 'chat', channelId: 'a', modelId: 'deepseek-v4-flash', inputTokens: 100, outputTokens: 10 },
      { id: '2', timestamp: 2, mode: 'agent', channelId: 'a', inputTokens: 300, outputTokens: 30 },
      { id: '3', timestamp: 3, mode: 'chat', channelId: 'a', modelId: 'deepseek-v4-flash', inputTokens: 50, outputTokens: 5 },
    ])

    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ key: 'unknown', name: '未知模型', totalTokens: 330 })
    expect(groups[1]).toMatchObject({ key: 'deepseek-v4-flash', name: 'deepseek-v4-flash', totalTokens: 165, entryCount: 2 })
  })

  test('Given 空数据 When 分组聚合 Then 返回空数组', () => {
    expect(service.groupUsageByDay([])).toEqual([])
    expect(service.groupUsageByChannel([])).toEqual([])
    expect(service.groupUsageByModel([])).toEqual([])
  })

  test('Given 多天记录 When calculateUsageStats Then 峰值日取单日最大 token', () => {
    const stats = service.calculateUsageStats([
      { id: '1', timestamp: localNoonDaysAgo(0), mode: 'chat', channelId: 'a', inputTokens: 100, outputTokens: 10 },
      { id: '2', timestamp: localNoonDaysAgo(1), mode: 'agent', channelId: 'a', inputTokens: 500, outputTokens: 50 },
      { id: '3', timestamp: localNoonDaysAgo(2), mode: 'chat', channelId: 'a', inputTokens: 200, outputTokens: 20 },
    ])

    expect(stats.peakDay).toMatchObject({ date: localDateDaysAgo(1), totalTokens: 550 })
    expect(stats.totalTokens).toBe(880)
  })

  test('Given 今天和历史记录 When calculateUsageStats Then 当天用量只计本地当天且缓存命中率按输入口径计算', () => {
    const stats = service.calculateUsageStats([
      { id: '1', timestamp: localNoonDaysAgo(0), mode: 'chat', channelId: 'a', inputTokens: 100, outputTokens: 20, cacheReadTokens: 60 },
      { id: '2', timestamp: localNoonDaysAgo(0), mode: 'agent', channelId: 'a', inputTokens: 50, outputTokens: 5, cacheReadTokens: 15 },
      { id: '3', timestamp: localNoonDaysAgo(1), mode: 'chat', channelId: 'a', inputTokens: 200, outputTokens: 30, cacheReadTokens: 100 },
    ])

    expect(stats.todayTokens).toBe(175)
    expect(stats.cacheHitRate).toBeCloseTo(175 / 350)
  })

  test('Given 输入 token 为零 When calculateUsageStats Then 缓存命中率不可用', () => {
    const stats = service.calculateUsageStats([
      { id: '1', timestamp: localNoonDaysAgo(0), mode: 'chat', channelId: 'a', inputTokens: 0, outputTokens: 5, cacheReadTokens: 0 },
    ])

    expect(stats.todayTokens).toBe(5)
    expect(stats.cacheHitRate).toBeUndefined()
  })

  test('Given 部分记录没有费用 When summarizeUsage Then 标记费用覆盖不完整', () => {
    const summary = service.summarizeUsage([
      { id: '1', timestamp: 1, mode: 'agent', channelId: 'a', inputTokens: 10, outputTokens: 1, costUsd: 0.01 },
      { id: '2', timestamp: 2, mode: 'chat', channelId: 'b', inputTokens: 20, outputTokens: 2 },
    ])

    expect(summary.totalCostUsd).toBe(0.01)
    expect(summary.pricedEntryCount).toBe(1)
    expect(summary.unpricedEntryCount).toBe(1)
    expect(summary.costIsPartial).toBe(true)
  })

  test('Given JSONL 包含超长行和无换行末行 When queryUsage Then 跳过超长行并保留末行', async () => {
    const path = usageEntriesPath()
    const oversized = `{"id":"oversized","padding":"${'x'.repeat(1_100_000)}"}`
    const finalEntry = JSON.stringify({ id: 'final', timestamp: 5, mode: 'agent', channelId: 'b', inputTokens: 20, outputTokens: 2 })
    writeFileSync(path, `${oversized}\r\n${finalEntry}`, 'utf8')

    const result = await service.queryUsage({ limit: 10 })

    expect(result.entries.map((entry) => entry.id)).toEqual(['final'])
    expect(result.summary.totalTokens).toBe(22)
  })

  test('Given JSONL 包含字段非法的合法 JSON When queryUsage Then 跳过坏记录避免污染聚合', async () => {
    const path = usageEntriesPath()
    writeFileSync(path, [
      JSON.stringify({ id: 'valid', timestamp: 2, mode: 'chat', channelId: 'a', inputTokens: 10, outputTokens: 1 }),
      JSON.stringify({ id: 'bad-negative', timestamp: 3, mode: 'agent', channelId: 'b', inputTokens: -1, outputTokens: 2 }),
      JSON.stringify({ id: 'bad-string', timestamp: 4, mode: 'chat', channelId: 'c', inputTokens: '100', outputTokens: 2 }),
      '',
    ].join('\n'), 'utf8')

    const result = await service.queryUsage({ limit: 10 })

    expect(result.entries.map((entry) => entry.id)).toEqual(['valid'])
    expect(result.summary.totalTokens).toBe(11)
  })

  test('Given 空数据 When calculateUsageStats Then 返回零值统计且峰值和缓存命中率未定义', () => {
    const stats = service.calculateUsageStats([])
    expect(stats).toMatchObject({ totalTokens: 0, todayTokens: 0 })
    expect(stats.peakDay).toBeUndefined()
    expect(stats.cacheHitRate).toBeUndefined()
    expect(stats.costUsd).toBeUndefined()
  })
})

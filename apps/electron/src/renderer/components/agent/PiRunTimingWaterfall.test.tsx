import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PiRunTimingReportView } from '@domi/shared'
import { PiRunTimingWaterfall } from './PiRunTimingWaterfall.tsx'

const available: PiRunTimingReportView = {
  status: 'available',
  tailTruncated: false,
  eventLimitReached: false,
  corruptLines: 0,
  runs: [{
    runId: 'session-1:1000',
    runStartedAt: 1_000,
    completed: true,
    evidenceIncomplete: false,
    totalDurationMs: 200,
    firstTokenMs: 30,
    spans: [
      {
        kind: 'model', label: '模型生成', startOffsetMs: 0, endOffsetMs: 120, durationMs: 120,
        callId: 'session-1:1000:turn:1:request:1', turn: 1, sequence: 6, visibility: 'model-visible',
        envelope: {
          version: 1,
          requestId: 'session-1:1000:turn:1:request:1',
          runId: 'session-1:1000',
          turnId: 'session-1:1000:turn:1',
          turn: 1,
          requestOrdinal: 1,
          capturedAt: 1_000,
          provider: 'openai-responses',
          modelId: 'gpt-5.6',
          reasoningLevel: 'xhigh',
          contextWindow: 272_000,
          messageCount: 4,
          toolCount: 2,
          systemPromptHash: `sha256:${'a'.repeat(64)}`,
          toolSchemaHash: `sha256:${'b'.repeat(64)}`,
          piActiveLeafId: 'leaf-1',
          controls: { executionPolicy: 'controlled', workflow: 'direct' },
          sessionTarget: { kind: 'isolated', ownership: 'owner', revision: 8 },
        },
      },
      { kind: 'authorization', label: 'Bash 审批', startOffsetMs: 40, endOffsetMs: 60, durationMs: 20, callId: 'authorization:tool:123:3', correlationId: 'tool:123456789abc', turn: 1, sequence: 3, visibility: 'log-only', outcome: 'allow' },
      { kind: 'tool', label: 'Read', startOffsetMs: 20, endOffsetMs: 100, durationMs: 80, callId: 'tool:tool:abc:5', correlationId: 'tool:abcdef123456', turn: 1, sequence: 5, visibility: 'model-visible', outcome: 'success' },
      { kind: 'tool', label: 'Bash', startOffsetMs: 40, endOffsetMs: 80, durationMs: 40, callId: 'tool:tool:def:4', correlationId: 'tool:def012345678', turn: 1, sequence: 4, visibility: 'model-visible', outcome: 'error' },
      { kind: 'retry_backoff', label: '重试等待 #1', startOffsetMs: 120, endOffsetMs: 150, durationMs: 30, callId: 'retry:backoff:1:7', turn: 1, sequence: 7, visibility: 'log-only' },
      { kind: 'retry_attempt', label: '重试尝试 #1', startOffsetMs: 150, endOffsetMs: 180, durationMs: 30, callId: 'retry:attempt:1:8', turn: 1, sequence: 8, visibility: 'log-only', outcome: 'succeeded' },
      { kind: 'tool', label: '无可见耗时', startOffsetMs: 180, endOffsetMs: 180, durationMs: 0, outcome: 'success' },
    ],
    summary: {
      slowestTool: { toolName: 'Read', durationMs: 80 },
      toolDurationMs: 120,
      authorizationWaitMs: 20,
      retryDurationMs: 60,
      modelGenerationMs: 120,
      retryCount: 1,
    },
  }],
}

describe('PiRunTimingWaterfall', () => {
  test('defaults to a timeline tab and keeps waterfall spans at their real relative offsets', () => {
    const html = renderToStaticMarkup(<PiRunTimingWaterfall report={available} loading={false} />)

    expect(html).toContain('本轮耗时')
    expect(html).toContain('200 ms')
    expect(html).toContain('首 token 30 ms')
    expect(html).toContain('最慢工具 Read · 80 ms')
    expect(html).toContain('重试 1 次')
    expect(html).toContain('role="tablist"')
    expect(html).toContain('aria-label="本轮执行视图"')
    expect(html).toContain('时间线')
    expect(html).toContain('调用')
    expect(html).toContain('left:10%')
    expect(html).toContain('width:40%')
    expect(html).toContain('left:20%')
    expect(html).toContain('width:20%')
    expect(html).toContain('aria-label="Read，80 ms，20–100 ms"')
    expect(html).not.toContain('max-h-[420px]')
    expect(html).not.toContain('overflow-y-auto')
    expect(html).not.toContain('请求快照')
    expect(html).not.toContain('无可见耗时')
  })

  test('shows Turn calls and the productized safe request snapshot in the calls tab', () => {
    const html = renderToStaticMarkup(<PiRunTimingWaterfall report={available} loading={false} initialView="calls" />)

    expect(html).toContain('Turn 1 · 6 Calls')
    expect(html).toContain('模型调用 #1')
    expect(html).toContain('请求快照')
    expect(html).toContain('RequestEnvelope')
    expect(html).toContain('aria-label="请求快照 RequestEnvelope"')
    expect(html).toContain('gpt-5.6')
    expect(html).toContain('openai-responses')
    expect(html).toContain('xhigh')
    expect(html).toContain('272k')
    expect(html).toContain('Controlled · Direct')
    expect(html).toContain('隔离 Worktree · revision 8')
    expect(html).toContain('sha256:aaaaaaaaaaaa…')
    expect(html).toContain('sha256:bbbbbbbbbbbb…')
    expect(html).toContain('模型可见')
    expect(html).toContain('仅日志')
    expect(html).toContain('tool:abcdef123456')
  })

  test('labels unscoped records as host events without calling every record a Call', () => {
    const report: PiRunTimingReportView = {
      ...available,
      runs: [{
        ...available.runs[0]!,
        spans: [
          ...available.runs[0]!.spans,
          { kind: 'retry_backoff', label: '恢复等待', startOffsetMs: 181, endOffsetMs: 190, durationMs: 9, visibility: 'log-only' },
        ],
      }],
    }
    const html = renderToStaticMarkup(<PiRunTimingWaterfall report={report} loading={false} initialView="calls" />)

    expect(html).toContain('宿主事件 · 1')
    expect(html).not.toContain('运行级事件')
    expect(html).not.toContain('宿主事件 · 1 Calls')
  })

  test('explains incomplete timing evidence inside the timing card instead of a modal footer', () => {
    const report: PiRunTimingReportView = {
      ...available,
      tailTruncated: true,
      corruptLines: 1,
      runs: [{ ...available.runs[0]!, completed: false, evidenceIncomplete: true }],
    }
    const waterfall = renderToStaticMarkup(<PiRunTimingWaterfall report={report} loading={false} />)

    expect(waterfall).toContain('进行中 / 证据未完整')
    expect(waterfall).toContain('统计范围：')
    expect(waterfall).toContain('仅读取最近一段审计记录，较早记录未计入')
    expect(waterfall).toContain('有 1 行审计记录无法读取')
    expect(waterfall).toContain('role="status"')
  })

  test('keeps an unmatched zero-duration provider request in calls without fabricating a waterfall bar', () => {
    const sourceEnvelope = available.runs[0]!.spans[0]!.envelope!
    const report: PiRunTimingReportView = {
      ...available,
      runs: [{
        ...available.runs[0]!,
        spans: [{
          kind: 'model', label: '模型请求', startOffsetMs: 5, endOffsetMs: 5, durationMs: 0,
          turn: 1, sequence: 2, visibility: 'model-visible',
          callId: 'session-1:1000:turn:1:request:2',
          envelope: {
            ...sourceEnvelope,
            requestId: 'session-1:1000:turn:1:request:2',
            requestOrdinal: 2,
            capturedAt: 1_005,
          },
        }],
      }],
    }
    const calls = renderToStaticMarkup(<PiRunTimingWaterfall report={report} loading={false} initialView="calls" />)
    const timeline = renderToStaticMarkup(<PiRunTimingWaterfall report={report} loading={false} />)

    expect(calls).toContain('模型调用 #2')
    expect(calls).toContain('请求快照')
    expect(calls).toContain('0 ms')
    expect(timeline).not.toContain('aria-label="模型请求，0 ms')
  })

  test('keeps legacy timing evidence usable when request envelope metadata is absent', () => {
    const report: PiRunTimingReportView = {
      ...available,
      runs: [{
        ...available.runs[0]!,
        spans: [{
          kind: 'model', label: '模型生成', startOffsetMs: 0, endOffsetMs: 120, durationMs: 120,
          turn: 1, visibility: 'model-visible',
        }],
      }],
    }
    const html = renderToStaticMarkup(<PiRunTimingWaterfall report={report} loading={false} initialView="calls" />)

    expect(html).toContain('Turn 1')
    expect(html).toContain('模型生成')
    expect(html).toContain('模型可见')
    expect(html).not.toContain('请求快照')
  })

  test('renders neutral loading, empty and unavailable states', () => {
    expect(renderToStaticMarkup(<PiRunTimingWaterfall report={null} loading />)).toContain('正在读取耗时证据')
    expect(renderToStaticMarkup(<PiRunTimingWaterfall report={{ ...available, status: 'empty', runs: [] }} loading={false} />)).toContain('暂无本轮耗时证据')
    expect(renderToStaticMarkup(<PiRunTimingWaterfall report={{ ...available, status: 'unavailable', runs: [] }} loading={false} />)).toContain('耗时证据暂不可用')
  })
})

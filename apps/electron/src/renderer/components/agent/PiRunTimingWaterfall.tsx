import * as React from 'react'
import type {
  AgentTrajectoryVisibility,
  PiRequestEnvelopeView,
  PiRunTimingReportView,
  PiRunTimingSpanView,
} from '@domi/shared'
import { cn } from '@/lib/utils'

export interface PiRunTimingWaterfallProps {
  report: PiRunTimingReportView | null
  loading: boolean
  /** 主要用于确定性 SSR/测试；产品默认先展示时间线。 */
  initialView?: 'timeline' | 'calls'
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`
}

function formatTokenCount(value: number): string {
  return value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value)
}

function shortFingerprint(value: string): string {
  const prefixLength = value.startsWith('sha256:') ? 'sha256:'.length + 12 : 18
  return value.length > prefixLength ? `${value.slice(0, prefixLength)}…` : value
}

const kindClass: Record<PiRunTimingSpanView['kind'], string> = {
  model: 'bg-sky-500/70',
  authorization: 'bg-amber-500/75',
  tool: 'bg-emerald-500/75',
  retry_backoff: 'bg-orange-500/75',
  retry_attempt: 'bg-violet-500/75',
  compaction: 'bg-cyan-500/75',
}

const kindLabel: Record<PiRunTimingSpanView['kind'], string> = {
  model: '模型',
  authorization: '审批',
  tool: '工具',
  retry_backoff: '重试等待',
  retry_attempt: '重试尝试',
  compaction: '上下文压缩',
}

const visibilityLabel: Record<AgentTrajectoryVisibility, string> = {
  'model-visible': '模型可见',
  'log-only': '仅日志',
  'product-state': '产品状态',
}

const workflowLabel = {
  direct: 'Direct',
  'read-only': 'Read Only',
  'plan-first': 'Plan First',
} as const

const executionPolicyLabel = {
  controlled: 'Controlled',
  autonomous: 'Autonomous',
  'full-access': 'Full Access',
} as const

function inferredVisibility(span: PiRunTimingSpanView): AgentTrajectoryVisibility {
  if (span.visibility) return span.visibility
  return span.kind === 'model' || span.kind === 'tool' ? 'model-visible' : 'log-only'
}

function WaterfallRow({ span, total }: { span: PiRunTimingSpanView; total: number }): React.ReactElement {
  const left = total > 0 ? Math.min(100, Math.max(0, span.startOffsetMs / total * 100)) : 0
  const width = total > 0
    ? Math.min(100 - left, Math.max(0.8, span.durationMs / total * 100))
    : 100
  const ariaLabel = `${span.label}，${formatDuration(span.durationMs)}，${span.startOffsetMs}–${span.endOffsetMs} ms`
  return (
    <div className="grid grid-cols-[78px_1fr_48px] items-center gap-1.5 py-px text-[10px]">
      <span className="truncate text-muted-foreground" title={span.label}>{span.label}</span>
      <div className="relative h-2.5 overflow-hidden rounded-sm bg-muted/60">
        <span
          className={cn('absolute inset-y-0 rounded-sm', kindClass[span.kind])}
          style={{ left: `${left}%`, width: `${width}%` }}
          aria-label={ariaLabel}
          title={ariaLabel}
        />
      </div>
      <span className="text-right tabular-nums text-muted-foreground/80">{formatDuration(span.durationMs)}</span>
    </div>
  )
}

function EnvelopeRow({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-2 py-0.5 text-[10px]">
      <span className="text-muted-foreground/60">{label}</span>
      <span className="min-w-0 break-all text-foreground/80">{children}</span>
    </div>
  )
}

function targetDescription(envelope: PiRequestEnvelopeView): string {
  const target = envelope.sessionTarget
  if (!target) return '—'
  const label = target.kind === 'isolated' ? '隔离 Worktree' : 'Local Checkout'
  return target.revision === undefined ? label : `${label} · revision ${target.revision}`
}

function RequestEnvelopeDetails({ envelope }: { envelope: PiRequestEnvelopeView }): React.ReactElement {
  const controls = envelope.controls
  return (
    <div className="mt-1.5 rounded-md bg-muted/35 px-2.5 py-2" aria-label="请求快照 RequestEnvelope">
      <div className="mb-1 flex items-baseline gap-1.5 text-[10px] font-medium text-foreground/80">
        <span>请求快照</span>
        <span className="font-mono text-[9px] font-normal text-muted-foreground/55">RequestEnvelope</span>
      </div>
      <EnvelopeRow label="Request">#{envelope.requestOrdinal} · {envelope.requestId}</EnvelopeRow>
      <EnvelopeRow label="Model">{envelope.modelId} · {envelope.provider}</EnvelopeRow>
      <EnvelopeRow label="Reasoning">{envelope.reasoningLevel}</EnvelopeRow>
      <EnvelopeRow label="Context">{envelope.contextWindow ? formatTokenCount(envelope.contextWindow) : '—'} · {envelope.messageCount} messages</EnvelopeRow>
      <EnvelopeRow label="Tools">{envelope.toolCount}</EnvelopeRow>
      <EnvelopeRow label="Controls">{controls ? `${executionPolicyLabel[controls.executionPolicy]} · ${workflowLabel[controls.workflow]}` : '—'}</EnvelopeRow>
      <EnvelopeRow label="Target">{targetDescription(envelope)}</EnvelopeRow>
      <EnvelopeRow label="Pi leaf">{envelope.piActiveLeafId ?? '—'}</EnvelopeRow>
      <EnvelopeRow label="System hash"><span title={envelope.systemPromptHash}>{shortFingerprint(envelope.systemPromptHash)}</span></EnvelopeRow>
      <EnvelopeRow label="Tools hash"><span title={envelope.toolSchemaHash}>{shortFingerprint(envelope.toolSchemaHash)}</span></EnvelopeRow>
    </div>
  )
}

function CallDetail({ span }: { span: PiRunTimingSpanView }): React.ReactElement {
  const visibility = inferredVisibility(span)
  const modelOrdinal = span.envelope?.requestOrdinal
  const title = span.kind === 'model' && modelOrdinal
    ? `模型调用 #${modelOrdinal}`
    : span.label
  return (
    <details className="group rounded-md px-1.5 py-1 hover:bg-muted/25">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[10px] marker:hidden">
        <span className={cn('size-1.5 shrink-0 rounded-full', kindClass[span.kind])} />
        <span className="min-w-0 flex-1 truncate text-foreground/80">{title}</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{visibilityLabel[visibility]}</span>
        {span.outcome ? <span className="text-[9px] text-muted-foreground/70">{span.outcome}</span> : null}
        <span className="w-12 text-right tabular-nums text-muted-foreground/70">{formatDuration(span.durationMs)}</span>
      </summary>
      <div className="pl-3.5">
        {span.correlationId ? <div className="mt-1 font-mono text-[9px] text-muted-foreground/60">{span.correlationId}</div> : null}
        {span.envelope ? <RequestEnvelopeDetails envelope={span.envelope} /> : null}
      </div>
    </details>
  )
}

function CallDetails({ spans }: { spans: PiRunTimingSpanView[] }): React.ReactElement | null {
  const groups = new Map<number | 'run', PiRunTimingSpanView[]>()
  for (const span of spans) {
    const key = span.turn ?? 'run'
    const group = groups.get(key) ?? []
    group.push(span)
    groups.set(key, group)
  }
  if (groups.size === 0) return null
  const ordered = [...groups.entries()].sort(([left], [right]) => {
    if (left === 'run') return 1
    if (right === 'run') return -1
    return left - right
  })

  return (
    <div className="px-1.5 py-1.5">
      {ordered.map(([turn, calls]) => (
        <details key={turn} className="rounded-md">
          <summary className="cursor-pointer select-none rounded-md px-1.5 py-1 text-[10px] font-medium text-foreground/75 hover:bg-muted/30">
            {turn === 'run'
              ? `宿主事件 · ${calls.length}`
              : `Turn ${turn} · ${calls.length} ${calls.length === 1 ? 'Call' : 'Calls'}`}
          </summary>
          <div className="space-y-0.5 pb-1">
            {calls.map((span, index) => (
              <CallDetail key={span.callId ?? `${span.kind}-${span.startOffsetMs}-${span.endOffsetMs}-${index}`} span={span} />
            ))}
          </div>
        </details>
      ))}
    </div>
  )
}

function NeutralState({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="rounded-md border border-border/50 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">{children}</div>
}

function evidenceWarnings(report: PiRunTimingReportView | null): string[] {
  if (!report) return []
  return [
    report.tailTruncated ? '仅读取最近一段审计记录，较早记录未计入' : null,
    report.eventLimitReached ? '事件较多，超出读取上限的记录未计入' : null,
    report.corruptLines > 0 ? `有 ${report.corruptLines} 行审计记录无法读取` : null,
  ].filter((item): item is string => Boolean(item))
}

function PiRunTimingEvidenceNotice({ report }: { report: PiRunTimingReportView | null }): React.ReactElement | null {
  const warnings = evidenceWarnings(report)
  if (warnings.length === 0) return null
  return (
    <div
      role="status"
      className="rounded-md bg-amber-500/5 px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-600 dark:text-amber-400"
    >
      <span className="font-medium">统计范围：</span>
      {warnings.join(' · ')}
    </div>
  )
}

export function PiRunTimingWaterfall({
  report,
  loading,
  initialView = 'timeline',
}: PiRunTimingWaterfallProps): React.ReactElement {
  const [view, setView] = React.useState<'timeline' | 'calls'>(initialView)
  const viewId = React.useId()
  if (loading && !report) return <NeutralState>正在读取耗时证据…</NeutralState>
  if (!report || report.status === 'empty') return <NeutralState>暂无本轮耗时证据</NeutralState>
  if (report.status === 'unavailable') return <NeutralState>耗时证据暂不可用，不影响当前 Agent 运行</NeutralState>
  const run = report.runs[0]
  if (!run) return <NeutralState>暂无本轮耗时证据</NeutralState>
  const timedSpans = run.spans.filter((span) => span.durationMs > 0)
  const trajectorySpans = run.spans.filter((span) => span.durationMs > 0 || span.envelope !== undefined)
  const timelineId = `${viewId}-timeline`
  const callsId = `${viewId}-calls`

  return (
    <section className="space-y-3 rounded-lg border border-border/60 bg-muted/10 p-3" aria-label="本轮耗时">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-foreground">本轮耗时</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {run.completed && !run.evidenceIncomplete ? '已完成' : '进行中 / 证据未完整'}
          </div>
        </div>
        <span className="text-sm font-semibold tabular-nums">{formatDuration(run.totalDurationMs)}</span>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>首 token {run.firstTokenMs === null ? '—' : formatDuration(run.firstTokenMs)}</span>
        <span>{run.summary.slowestTool ? `最慢工具 ${run.summary.slowestTool.toolName} · ${formatDuration(run.summary.slowestTool.durationMs)}` : '暂无工具执行'}</span>
        <span>重试 {run.summary.retryCount} 次</span>
      </div>
      <PiRunTimingEvidenceNotice report={report} />
      <div
        role="tablist"
        aria-label="本轮执行视图"
        className="inline-flex w-fit rounded-md border border-border/50 bg-muted/35 p-0.5"
      >
        <button
          type="button"
          role="tab"
          aria-selected={view === 'timeline'}
          aria-controls={timelineId}
          className={cn(
            'rounded px-2.5 py-1 text-[10px] font-medium transition-colors',
            view === 'timeline' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => setView('timeline')}
        >
          时间线
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'calls'}
          aria-controls={callsId}
          className={cn(
            'rounded px-2.5 py-1 text-[10px] font-medium transition-colors',
            view === 'calls' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => setView('calls')}
        >
          调用
        </button>
      </div>
      {view === 'timeline' ? (
        <div id={timelineId} role="tabpanel" className="rounded-md border border-border/40 bg-background/40">
          <div className="flex flex-wrap gap-2 border-b border-border/40 px-2 py-1.5 text-[10px] text-muted-foreground/75">
            {(Object.keys(kindLabel) as PiRunTimingSpanView['kind'][]).map((kind) => (
              <span key={kind} className="inline-flex items-center gap-1"><span className={cn('size-1.5 rounded-full', kindClass[kind])} />{kindLabel[kind]}</span>
            ))}
          </div>
          <div className="px-1.5 py-1">
            {timedSpans.length > 0
              ? timedSpans.map((span, index) => <WaterfallRow key={`${span.kind}-${span.startOffsetMs}-${span.endOffsetMs}-${span.label}-${index}`} span={span} total={Math.max(1, run.totalDurationMs)} />)
              : <div className="px-1 py-3 text-center text-[10px] text-muted-foreground">暂无可绘制的耗时阶段</div>}
          </div>
          <div className="flex justify-between border-t border-border/40 px-2 py-1 text-[10px] tabular-nums text-muted-foreground/60"><span>0</span><span>{formatDuration(run.totalDurationMs)}</span></div>
        </div>
      ) : (
        <div id={callsId} role="tabpanel" className="rounded-md border border-border/40 bg-background/40">
          {trajectorySpans.length > 0
            ? <CallDetails spans={trajectorySpans} />
            : <div className="px-3 py-4 text-center text-[10px] text-muted-foreground">暂无调用详情</div>}
        </div>
      )}
    </section>
  )
}

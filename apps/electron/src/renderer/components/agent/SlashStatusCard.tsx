/**
 * SlashStatusCard — `/status` 临时状态卡。
 *
 * 只读汇总当前会话运行状态，不发送给模型、不写入对话上下文：
 * 模型 / 渠道 / 推理深度 / 工作方式 / 安全保护 / 修改环境 / 上下文用量 / 队列 / Skills / MCP。
 */
import * as React from 'react'
import { useAtomValue } from 'jotai'
import type { PiRunTimingReportView } from '@domi/shared'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  agentMessageQueueAtomFamily,
  agentSessionExecutionControlsAtomFamily,
  agentSessionsAtom,
  agentStreamingStatesAtom,
} from '@/atoms/agent-atoms'
import { sessionTargetStateAtomFamily } from '@/atoms/session-target-atoms'
import { getNativeQueuedMessages } from '@/lib/agent-message-queue'
import { getAgentWorkflowDisplay } from '@/lib/agent-control-display'
import { formatAgentContextUsageSummary } from '@/lib/agent-context-usage'
import { handleOptionalDialogCloseAutoFocus } from '@/lib/dialog-focus'
import { cn } from '@/lib/utils'
import {
  formatAgentUsageTokens,
  type AgentSessionUsageSnapshot,
} from './agent-session-usage.ts'
import { PiRunTimingWaterfall } from './PiRunTimingWaterfall.tsx'

export const SLASH_STATUS_DIALOG_CLASS = 'flex h-[720px] max-h-[calc(100vh-32px)] w-[calc(100vw-32px)] max-w-[900px] flex-col gap-3 overflow-hidden'
export const SLASH_STATUS_SCROLL_CLASS = 'min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1'
export const SLASH_STATUS_GRID_CLASS = 'grid grid-cols-1 gap-5 md:grid-cols-[270px_minmax(0,1fr)] md:items-start'
export const SLASH_STATUS_OVERVIEW_CLASS = 'space-y-3 md:sticky md:top-0'

interface SlashStatusCardProps {
  sessionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceSlug?: string | null
  /** 当前会话跨已完成轮次的真实 persisted provider usage 累计。 */
  sessionUsage: AgentSessionUsageSnapshot
  /** Dialog 任意关闭路径完成后恢复指定焦点。 */
  restoreFocusOnClose?: () => void
}

interface RowProps {
  label: string
  children: React.ReactNode
}

function Row({ label, children }: RowProps): React.ReactElement {
  return (
    <div className="grid grid-cols-[88px_1fr] items-baseline gap-2 py-1 text-sm">
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground/60">{label}</span>
      <span className="min-w-0 truncate text-foreground/90">{children}</span>
    </div>
  )
}

function StatePill({ active, label }: { active: boolean; label: string }): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium',
        active ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground/60',
      )}
    >
      <span className={cn('size-1.5 rounded-full', active ? 'bg-primary' : 'bg-muted-foreground/40')} />
      {label}
    </span>
  )
}

export function SlashStatusCard({
  sessionId,
  open,
  onOpenChange,
  workspaceSlug,
  sessionUsage,
  restoreFocusOnClose,
}: SlashStatusCardProps): React.ReactElement {
  const sessions = useAtomValue(agentSessionsAtom)
  const streamingStates = useAtomValue(agentStreamingStatesAtom)
  const controls = useAtomValue(agentSessionExecutionControlsAtomFamily(sessionId))
  const targetState = useAtomValue(sessionTargetStateAtomFamily(sessionId))
  const queue = useAtomValue(agentMessageQueueAtomFamily(sessionId))
  const stream = streamingStates.get(sessionId)
  const running = stream?.running ?? false

  const [caps, setCaps] = React.useState<{ skills: number; mcp: number } | null>(null)
  const [timing, setTiming] = React.useState<PiRunTimingReportView | null>(null)
  const [timingLoading, setTimingLoading] = React.useState(false)
  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setCaps(null)
    if (!workspaceSlug) {
      setCaps({ skills: 0, mcp: 0 })
      return
    }
    void window.electronAPI.getWorkspaceCapabilities(workspaceSlug)
      .then((result) => {
        if (cancelled) return
        setCaps({
          skills: result.skills.filter((s) => s.enabled).length,
          mcp: result.mcpServers.filter((s) => s.enabled).length,
        })
      })
      .catch(() => { if (!cancelled) setCaps({ skills: 0, mcp: 0 }) })
    return () => { cancelled = true }
  }, [open, workspaceSlug])

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setTimingLoading(true)
    const refresh = (): void => {
      void window.electronAPI.piRunTiming.query({ sessionId })
        .then((result) => { if (!cancelled) setTiming(result) })
        .catch(() => {
          if (!cancelled) setTiming({ status: 'unavailable', runs: [], tailTruncated: false, eventLimitReached: false, corruptLines: 0 })
        })
        .finally(() => { if (!cancelled) setTimingLoading(false) })
    }
    refresh()
    const timer = running ? setInterval(refresh, 2_000) : null
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [open, sessionId, running])

  const sessionMeta = sessions.find((s) => s.id === sessionId)
  const target = targetState.snapshot

  const nativeQueue = getNativeQueuedMessages(queue)
  const steeringCount = nativeQueue.filter((m) => m.kind === 'steering').length
  const followUpCount = nativeQueue.filter((m) => m.kind === 'followUp').length

  const backgroundWaiting = stream?.backgroundWaiting ?? false
  const isCompacting = stream?.isCompacting ?? false
  const retrying = stream?.retrying?.phase === 'running' || stream?.retrying?.phase === 'scheduled'
  const contextWindow = stream?.contextWindow
  const inputTokens = stream?.contextUsageInvalidated ? undefined : stream?.inputTokens
  const contextUsageSummary = formatAgentContextUsageSummary(inputTokens, contextWindow)

  const isWorktree = target?.checkout.kind === 'isolated'
  const targetLabel = !target
    ? '—'
    : isWorktree
      ? '隔离 Worktree'
      : target.checkout.kind === 'local'
        ? 'Local Checkout'
        : target.checkout.kind
  const workflowDisplay = getAgentWorkflowDisplay(controls.workflow)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={SLASH_STATUS_DIALOG_CLASS}
        onCloseAutoFocus={(event) => handleOptionalDialogCloseAutoFocus(event, restoreFocusOnClose)}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>会话状态</DialogTitle>
        </DialogHeader>
        <div className="flex shrink-0 flex-wrap gap-2 pb-1">
          <StatePill active={running || backgroundWaiting} label={running ? '运行中' : backgroundWaiting ? '后台等待' : '空闲'} />
          <StatePill active={isCompacting} label={isCompacting ? '压缩中' : '未压缩'} />
          <StatePill active={retrying} label={retrying ? '重试中' : '无重试'} />
        </div>
        <div className={SLASH_STATUS_SCROLL_CLASS}>
          <div className={SLASH_STATUS_GRID_CLASS}>
            <aside className={SLASH_STATUS_OVERVIEW_CLASS} aria-label="会话概览">
              <section className="rounded-lg border border-border/60 bg-muted/10 p-3">
                <div className="pb-1 text-xs font-medium text-foreground">会话概览</div>
                <div className="divide-y divide-border/40">
                  <Row label="会话">{sessionMeta?.title ?? '（无标题）'}</Row>
                  <Row label="Model">{sessionMeta?.modelId ?? '—'}</Row>
                  <Row label="推理深度">{sessionMeta?.reasoningLevel ?? sessionMeta?.openAIThinkingLevel ?? '默认'}</Row>
                  <Row label="工作方式">
                    {workflowDisplay.label}
                    {workflowDisplay.value === 'direct' ? <span className="ml-1.5 text-amber-600 dark:text-amber-400">未沙箱化</span> : null}
                  </Row>
                  <Row label="修改环境">
                    {targetLabel}
                    {target?.project?.name ? <span className="ml-1.5 text-muted-foreground/60">{target.project.name}</span> : null}
                  </Row>
                  <Row label="上下文">
                    {contextUsageSummary.text}
                    {contextUsageSummary.percentage ? <span className="ml-1.5 text-muted-foreground/60">{contextUsageSummary.percentage}</span> : null}
                  </Row>
                  <Row label="累计输入">
                    <span
                      className="tabular-nums"
                      title={sessionUsage.inputTokens > 0
                        ? `当前会话已完成轮次的 provider 输入总量：${sessionUsage.inputTokens.toLocaleString()} token；非缓存 ${sessionUsage.uncachedInputTokens.toLocaleString()}，缓存读取 ${sessionUsage.cacheReadTokens.toLocaleString()}，缓存写入 ${sessionUsage.cacheCreationTokens.toLocaleString()}。不包含当前上下文占用或实时估算。`
                        : '尚无已完成轮次的真实 provider 输入 usage；不包含当前上下文占用或实时估算。'}
                    >
                      {formatAgentUsageTokens(sessionUsage.inputTokens)}
                    </span>
                  </Row>
                  <Row label="累计输出">
                    <span
                      className="tabular-nums"
                      title={sessionUsage.outputTokens > 0
                        ? `当前会话已完成轮次的真实 provider 输出累计：${sessionUsage.outputTokens.toLocaleString()} token；不包含实时估算。`
                        : '尚无已完成轮次的真实 provider 输出 usage；不包含实时估算。'}
                    >
                      {formatAgentUsageTokens(sessionUsage.outputTokens)}
                    </span>
                  </Row>
                  <Row label="模型请求">
                    <span
                      className="tabular-nums"
                      title={sessionUsage.providerRequestCoverage === 'complete'
                        ? '当前会话已完成轮次逐次采集的真实 provider 请求数。'
                        : '当前数值仅为可验证下限；部分历史或兼容结果没有逐次请求计数。'}
                    >
                      {sessionUsage.providerRequestCount > 0
                        ? `${sessionUsage.providerRequestCount.toLocaleString()}${sessionUsage.providerRequestCoverage === 'partial' ? '+' : ''}`
                        : '—'}
                    </span>
                  </Row>
                  <Row label="费用">{stream?.costUsd != null ? `$${stream.costUsd.toFixed(4)}` : '—'}</Row>
                  <Row label="队列">
                    {steeringCount > 0 ? `${steeringCount} steering` : ''}
                    {steeringCount > 0 && followUpCount > 0 ? ' · ' : ''}
                    {followUpCount > 0 ? `${followUpCount} follow-up` : ''}
                    {steeringCount === 0 && followUpCount === 0 ? '空' : ''}
                  </Row>
                  <Row label="Skills / MCP">{caps ? `${caps.skills} / ${caps.mcp}` : '…'}</Row>
                </div>
              </section>
              <details className="rounded-lg border border-border/50 bg-muted/5 px-3 py-2">
                <summary className="cursor-pointer select-none text-[11px] font-medium text-muted-foreground hover:text-foreground">
                  技术信息
                </summary>
                <div className="mt-2 space-y-2 border-t border-border/40 pt-2 text-[10px]">
                  <div>
                    <div className="uppercase tracking-wide text-muted-foreground/55">Channel</div>
                    <div className="mt-0.5 break-all text-foreground/75">{sessionMeta?.channelId ?? '—'}</div>
                  </div>
                  <div>
                    <div className="uppercase tracking-wide text-muted-foreground/55">Session ID</div>
                    <div className="mt-0.5 break-all font-mono text-foreground/75">{sessionId}</div>
                  </div>
                </div>
              </details>
            </aside>
            <main className="min-w-0" aria-label="本轮执行">
              <PiRunTimingWaterfall report={timing} loading={timingLoading} />
            </main>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

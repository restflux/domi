/*
 * Ported and adapted from ZCode (Apache-2.0), commit
 * 29628c9acdb81b703bbd4080c207a0e7ce5e276e:
 * packages/ui/src/v4/ConversationTurnGroup.tsx (AssistantHistoryStatus),
 * packages/ui/src/ToolCallBlocks/ToolSummaryRow.tsx (SummaryLeadingContent / SummaryContent).
 * Copyright (c) ZCode contributors. Domi adaptation: native buttons, Pi data and theme tokens;
 * no ZCode runtime, state management, queued animations or external assets.
 * The reasoning heading is Domi-owned: ZCode's reasoning.tsx derives from Vercel AI Elements
 * and is intentionally NOT copied into Domi.
 */
import type { ReactNode } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface WorkStatusProps {
  label: string
  expanded: boolean
  running: boolean
  title?: string
  onToggle: () => void
}

/** ZCode AssistantHistoryStatus 的独立历史入口；由 Domi 提供持续时间和开合状态。 */
export function ZCodeWorkStatus({ label, expanded, running, title, onToggle }: WorkStatusProps): React.ReactElement {
  return (
    <div className="flex w-full border-b border-border/50 pb-2" data-zcode-work-status="true">
      <button
        type="button"
        aria-expanded={expanded}
        disabled={running}
        title={title}
        data-work-process-trigger="true"
        data-history-open={String(expanded)}
        className="group/history-message inline-flex max-w-full items-center gap-2 text-left text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onToggle}
      >
        <span className={cn('truncate', running && 'zcode-work-shimmer')} data-work-process-trigger-label="true" data-process-summary={running ? 'shimmer' : undefined}>{label}</span>
        <ChevronRight
          aria-hidden
          data-work-process-trigger-chevron="true"
          className={cn('size-4 shrink-0 text-muted-foreground/70 transition-transform', expanded ? 'rotate-90' : 'rotate-0')}
        />
      </button>
    </div>
  )
}

interface ToolSummaryProps {
  icon: ReactNode
  kindLabel: string
  primaryText: ReactNode
  statusNode?: ReactNode
  expanded: boolean
  running: boolean
  title?: string
  onToggle: () => void
}

/** 从 ZCode SummaryLeadingContent / SummaryContent 提取的单行展示，不搬运工具调用逻辑。 */
export function ZCodeToolSummaryRow({ icon, kindLabel, primaryText, statusNode, expanded, running, title, onToggle }: ToolSummaryProps): React.ReactElement {
  return (
    <button
      type="button"
      title={title}
      aria-expanded={expanded}
      onClick={onToggle}
      data-zcode-tool-summary="true"
      className="group/tool-summary inline-flex max-w-full cursor-pointer items-center gap-2 self-start text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="shrink-0 text-muted-foreground/70 [&_svg]:text-muted-foreground/70">{icon}</span>
      <span className="tool-summary-kind-label shrink-0 font-medium text-muted-foreground">{kindLabel}</span>
      {(primaryText != null && primaryText !== '' || statusNode != null) && (
        <span className="tool-summary-content min-w-0 flex max-w-full items-center gap-2 text-muted-foreground">
          {primaryText != null && primaryText !== '' && (
            <span className={cn('min-w-0 truncate', running && 'zcode-work-shimmer')} data-process-summary={running ? 'shimmer' : undefined}>{primaryText}</span>
          )}
          {statusNode}
        </span>
      )}
      <ChevronRight
        aria-hidden
        className={cn(
          'size-4 shrink-0 text-muted-foreground/70 transition-transform transition-opacity duration-200 ease-out will-change-transform',
          expanded ? 'rotate-90 opacity-100' : 'rotate-0 opacity-0 group-hover/tool-summary:opacity-100',
        )}
      />
    </button>
  )
}

interface ReasoningHeadingProps {
  label: string
  isStreaming: boolean
  isOpen: boolean
  onToggle: () => void
}

/** Domi 思考标题与 ZCode 的视觉层级对齐，不复制其第三方衍生组件。 */
export function ZCodeReasoningHeading({ label, isStreaming, isOpen, onToggle }: ReasoningHeadingProps): React.ReactElement {
  return (
    <button
      type="button"
      aria-expanded={isOpen}
      onClick={onToggle}
      data-zcode-reasoning-trigger="true"
      className="group/reasoning inline-flex max-w-full min-w-0 items-center gap-2 self-start text-sm transition-colors"
    >
      <Brain className="size-4 shrink-0 text-muted-foreground/70" />
      <span className="shrink-0 whitespace-nowrap" data-reasoning-label="true">
        <span className={cn('font-medium text-muted-foreground', isStreaming && 'zcode-work-shimmer')}>{label}</span>
      </span>
      <ChevronRight
        aria-hidden
        className={cn(
          'size-4 shrink-0 text-muted-foreground/70 transition-opacity transition-transform',
          isOpen ? 'rotate-90 opacity-100' : 'rotate-0 opacity-0 group-hover/reasoning:opacity-100',
        )}
      />
    </button>
  )
}

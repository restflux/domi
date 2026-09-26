// Work V2 的状态底线与工作项布局改编自 ZCode ConversationTurnGroup
// (c) ZCode contributors，Apache-2.0；折叠状态及 Pi 工具明细沿用 Domi 实现。
import * as React from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getWorkProcessFallbackLabel } from './process-activity-presentation'
import { extractPlanText } from './PlanPreviewBlock'
import { ZCodeWorkStatus } from './ZCodeWorkPresentation'
import type {
  SDKContentBlock,
  SDKTextBlock,
  SDKThinkingBlock,
  SDKToolUseBlock,
} from '@domi/shared'

interface ProcessBlockGroupProps {
  blocks: SDKContentBlock[]
  isStreaming?: boolean
  // 该过程组是否为整条消息的末尾项：是则流式中保留最后一段为正常显示，
  // 否则（最终答案已作为后续兄弟块外置）整组统一弱化。
  isMessageTail?: boolean
  /** 用户中断本轮时保持展开（不随结束折叠），便于回看已执行的工具明细。 */
  keepExpanded?: boolean
  /** 工作过程入口使用本轮起点显示实时耗时，完成后切换为最终耗时。 */
  startedAt?: number
  durationMs?: number
  durationTooltip?: string
  /** 仅图片相关过程组传入，用于让 turn 底部缩略图与展开内容互斥。 */
  processGroupId?: string
  onExpandedChange?: (processGroupId: string, expanded: boolean) => void
  children: React.ReactNode
}

const PROCESS_GROUP_COLLAPSE_DURATION_MS = 180

interface IndexedContentBlock {
  block: SDKContentBlock
  index: number
}

export type AssistantTurnRenderItem =
  | { type: 'block'; item: IndexedContentBlock }
  | { type: 'process-group'; items: IndexedContentBlock[] }

interface BuildAssistantTurnRenderItemsOptions {
  isStreaming?: boolean
}

function getTrailingTextStartIndex(blocks: SDKContentBlock[]): number | null {
  const lastBlock = blocks[blocks.length - 1]
  if (lastBlock?.type !== 'text') return null

  let finalStartIndex = blocks.length - 1
  while (finalStartIndex > 0 && blocks[finalStartIndex - 1]?.type === 'text') {
    finalStartIndex -= 1
  }
  return finalStartIndex
}

/**
 * 需要用户裁决的交互工具：其前面的正文（计划 / 实施反馈 / 提问说明）是交付给用户的内容，
 * 不是过程叙述。当用户拒绝弹窗或中断执行时，这一轮会以这类 tool_use 收尾；
 * 此时正文仍应作为可见内容外置，而不是整体收进「工作过程」折叠组。
 */
const USER_DECISION_TOOL_NAMES = new Set(['ExitPlanMode', 'RequestDirectWorkflow', 'AskUserQuestion'])
const WORKTREE_TERMINATING_TOOL_NAMES = new Set([
  'ReadyForReview',
  'RequestNextWorktreeIteration',
  'RequestWorktreePreviewRevision',
])

/**
 * 兜底计算尾部可见正文的起始位置：消息末尾只有裁决类 tool_use 或 thinking 块时，
 * 把最后一个连续 text 段视为最终输出；否则返回 null 保持原有「整体收进过程组」行为。
 */
function findDecisionTailTextStartIndex(blocks: SDKContentBlock[]): number | null {
  let lastTextIndex = -1
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]?.type === 'text') {
      lastTextIndex = index
      break
    }
  }
  if (lastTextIndex < 0) return null

  for (let index = lastTextIndex + 1; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block?.type === 'tool_use') {
      const toolBlock = block as SDKToolUseBlock
      if (!USER_DECISION_TOOL_NAMES.has(toolBlock.name)) return null
    } else if (block?.type !== 'thinking') {
      return null
    }
  }

  let finalStartIndex = lastTextIndex
  while (finalStartIndex > 0 && blocks[finalStartIndex - 1]?.type === 'text') {
    finalStartIndex -= 1
  }
  return finalStartIndex
}

/**
 * 审批正文直接持久化在 tool input 中，本身就是用户可见交付内容。
 * ExitPlanMode 只有携带非空 plan 时才外置，旧会话里的空工具调用仍按普通过程记录展示。
 */
function findLastPersistentDecisionPresentationIndex(blocks: SDKContentBlock[]): number | null {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block?.type !== 'tool_use') continue
    const toolBlock = block as SDKToolUseBlock
    if (toolBlock.name === 'RequestDirectWorkflow') return index
    if (toolBlock.name === 'ExitPlanMode' && extractPlanText(toolBlock.input)) return index
  }
  return null
}

function offsetRenderItemIndices(items: AssistantTurnRenderItem[], offset: number): AssistantTurnRenderItem[] {
  if (offset === 0) return items
  return items.map((item) => item.type === 'block'
    ? { type: 'block', item: { ...item.item, index: item.item.index + offset } }
    : {
        type: 'process-group',
        items: item.items.map((groupItem) => ({ ...groupItem, index: groupItem.index + offset })),
      })
}

export function buildAssistantTurnRenderItems(
  blocks: SDKContentBlock[],
  options: BuildAssistantTurnRenderItemsOptions = {},
): AssistantTurnRenderItem[] {
  if (blocks.length === 0) return []

  // 审批期间与审批结束后的正文源都来自持久化 tool input。
  // 无论它前后是否还有 text/thinking，都把该工具块作为一等内容外置；其余片段递归沿用原分组规则。
  const decisionPresentationIndex = findLastPersistentDecisionPresentationIndex(blocks)
  if (decisionPresentationIndex !== null) {
    const items: AssistantTurnRenderItem[] = []
    if (decisionPresentationIndex > 0) {
      items.push(...buildAssistantTurnRenderItems(blocks.slice(0, decisionPresentationIndex), options))
    }
    items.push({
      type: 'block',
      item: { block: blocks[decisionPresentationIndex]!, index: decisionPresentationIndex },
    })
    if (decisionPresentationIndex < blocks.length - 1) {
      items.push(...offsetRenderItemIndices(
        buildAssistantTurnRenderItems(blocks.slice(decisionPresentationIndex + 1), options),
        decisionPresentationIndex + 1,
      ))
    }
    return items
  }

  // Worktree 操作卡由 system 消息独立呈现；其 tool_use 晚于正文落盘。
  // 这时依旧将工具留在过程内回看，但让同轮过程入口先于最终正文和卡片。
  const lastBlock = blocks.at(-1)
  if (lastBlock?.type === 'tool_use' && WORKTREE_TERMINATING_TOOL_NAMES.has((lastBlock as SDKToolUseBlock).name)) {
    const textIndex = blocks.findLastIndex((block) => block.type === 'text')
    if (textIndex >= 0) {
      let finalStartIndex = textIndex
      while (finalStartIndex > 0 && blocks[finalStartIndex - 1]?.type === 'text') finalStartIndex -= 1
      return [
        {
          type: 'process-group',
          items: blocks.flatMap((block, index) => (
            index >= finalStartIndex && index <= textIndex ? [] : [{ block, index }]
          )),
        },
        ...blocks.slice(finalStartIndex, textIndex + 1).map((block, offset) => ({
          type: 'block' as const,
          item: { block, index: finalStartIndex + offset },
        })),
      ]
    }
  }

  // 流式末尾的 text 直接作为交付正文展示在过程区外；如果 Agent 后续继续调用工具，
  // text 不再位于末尾时会自然回到过程组。这样正文 delta 不会持续撑高过程区并触发布局。
  const hasProcessBlock = blocks.some((block) => block.type === 'tool_use' || block.type === 'thinking')
  const trailingTextStartIndex = getTrailingTextStartIndex(blocks)
  const decisionTailTextStartIndex = findDecisionTailTextStartIndex(blocks)
  const canSplitStreamingFinalOutput = options.isStreaming
    && hasProcessBlock
    && trailingTextStartIndex !== null
    && trailingTextStartIndex > 0

  if (options.isStreaming && hasProcessBlock && !canSplitStreamingFinalOutput) {
    return [{
      type: 'process-group',
      items: blocks.map((block, index) => ({ block, index })),
    }]
  }

  // 兜底：消息以裁决类工具（ExitPlanMode / RequestDirectWorkflow / AskUserQuestion）
  // 或 thinking 收尾时（计划被拒绝 / 用户中断后常出现），正文仍是交付给用户的内容，
  // 不应随工具行一起收进「工作过程」折叠组。
  const effectiveTrailingTextStartIndex = trailingTextStartIndex ?? decisionTailTextStartIndex

  if (effectiveTrailingTextStartIndex === null) {
    return [{
      type: 'process-group',
      items: blocks.map((block, index) => ({ block, index })),
    }]
  }

  const items: AssistantTurnRenderItem[] = []
  if (effectiveTrailingTextStartIndex > 0) {
    items.push({
      type: 'process-group',
      items: blocks.slice(0, effectiveTrailingTextStartIndex).map((block, index) => ({ block, index })),
    })
  }

  for (let index = effectiveTrailingTextStartIndex; index < blocks.length; index++) {
    const block = blocks[index]
    if (!block) continue
    items.push({ type: 'block', item: { block, index } })
  }

  return items
}

/**
 * 当外置正文变化但过程块对象没有变化时复用旧数组，避免过程区的 memo、测量与滚动逻辑被唤醒。
 */
export function stabilizeProcessBlockReferences(
  previous: SDKContentBlock[],
  next: SDKContentBlock[],
): SDKContentBlock[] {
  if (previous.length !== next.length) return next
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) return next
  }
  return previous
}

function getProcessChildKey(child: React.ReactNode, index: number): string {
  if (React.isValidElement(child) && child.key != null) return String(child.key)
  return `process-child-${index}`
}

interface StableProcessChildCacheEntry {
  child: React.ReactNode
  snapshot: string
}

function getProcessChildSnapshot(child: React.ReactNode): string | null {
  if (!React.isValidElement(child)) return null
  const props = child.props as { block?: SDKContentBlock; dimmed?: boolean }
  const block = props.block
  if (!block || (block.type !== 'text' && block.type !== 'thinking')) return null
  const presentation = props.dimmed ? 'dimmed' : 'normal'
  return block.type === 'text'
    ? `text:${presentation}:${(block as SDKTextBlock).text}`
    : `thinking:${presentation}:${(block as SDKThinkingBlock).thinking}`
}

const StableProcessChild = React.memo(
  function StableProcessChild({ child }: { child: React.ReactNode }): React.ReactElement {
    return <>{child}</>
  },
  (previous, next) => previous.child === next.child,
)

/** 完成态入口使用紧凑中文耗时，和消息区其余状态文案保持一致。 */
export function formatWorkProcessDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000))
  if (seconds < 1) return '不足 1 秒'
  if (seconds < 60) return `${seconds} 秒`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return remainingSeconds > 0
    ? `${minutes} 分 ${remainingSeconds} 秒`
    : `${minutes} 分钟`
}

interface WorkProcessTriggerLabelOptions {
  isStreaming: boolean
  fallbackLabel?: string
  elapsedMs?: number
  durationMs?: number
}

/** 入口仅展示工作状态和耗时，不再复述每类操作的数量。 */
export function buildWorkProcessTriggerLabel({
  isStreaming,
  fallbackLabel = '工作过程',
  elapsedMs,
  durationMs,
}: WorkProcessTriggerLabelOptions): string {
  if (!isStreaming) {
    return durationMs != null
      ? `用时 ${formatWorkProcessDuration(durationMs)}`
      : fallbackLabel
  }

  return elapsedMs != null
    ? `工作中 · 已用时 ${formatWorkProcessDuration(elapsedMs)}`
    : '工作中'
}

export function ProcessBlockGroup({
  blocks,
  isStreaming,
  isMessageTail = false,
  keepExpanded = false,
  startedAt,
  durationMs,
  durationTooltip,
  processGroupId,
  onExpandedChange,
  children,
}: ProcessBlockGroupProps): React.ReactElement {
  const contentRef = React.useRef<HTMLDivElement>(null)
  const stableProcessBlocksRef = React.useRef(blocks)
  stableProcessBlocksRef.current = stabilizeProcessBlockReferences(stableProcessBlocksRef.current, blocks)
  const stableProcessBlocks = stableProcessBlocksRef.current
  const stableChildrenRef = React.useRef(new Map<string, StableProcessChildCacheEntry>())
  const fallbackLabel = React.useMemo(
    () => getWorkProcessFallbackLabel(stableProcessBlocks),
    [stableProcessBlocks],
  )
  // 执行中始终按原顺序展开分段过程；本轮结束后才统一折叠。
  // 用户中断本轮时同样保持展开，避免过程明细随结束被收起、中断痕迹不可见。
  const autoExpanded = !!isStreaming || !!keepExpanded
  const [expanded, setExpanded] = React.useState(autoExpanded)
  const [shouldRenderContent, setShouldRenderContent] = React.useState(autoExpanded)
  const [measuredHeight, setMeasuredHeight] = React.useState<number | undefined>(undefined)
  const [currentTime, setCurrentTime] = React.useState(() => Date.now())
  const userToggledRef = React.useRef(false)
  const onExpandedChangeRef = React.useRef(onExpandedChange)
  onExpandedChangeRef.current = onExpandedChange

  React.useEffect(() => {
    if (!userToggledRef.current) setExpanded(autoExpanded)
  }, [autoExpanded])

  React.useEffect(() => {
    if (!isStreaming || startedAt == null) return
    setCurrentTime(Date.now())
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [isStreaming, startedAt])

  React.useEffect(() => {
    if (processGroupId) onExpandedChangeRef.current?.(processGroupId, expanded)
  }, [expanded, processGroupId])

  React.useEffect(() => {
    return () => {
      if (processGroupId) onExpandedChangeRef.current?.(processGroupId, false)
    }
  }, [processGroupId])

  // 结束时只折叠一次；用户主动展开或收起后继续尊重其选择。
  React.useEffect(() => {
    if (expanded) {
      setShouldRenderContent(true)
      setMeasuredHeight(undefined)
      return
    }

    let animationFrame: number | null = null
    const element = contentRef.current
    if (element) {
      setMeasuredHeight(element.scrollHeight)
      animationFrame = window.requestAnimationFrame(() => setMeasuredHeight(0))
    }

    const timer = window.setTimeout(() => setShouldRenderContent(false), PROCESS_GROUP_COLLAPSE_DURATION_MS)
    return () => {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
      window.clearTimeout(timer)
    }
  }, [expanded])

  const elapsedMs = isStreaming && startedAt != null
    ? Math.max(0, currentTime - startedAt)
    : undefined
  const triggerLabel = buildWorkProcessTriggerLabel({
    isStreaming: !!isStreaming,
    fallbackLabel,
    elapsedMs,
    durationMs,
  })

  // 流式时挂载完整分段过程；完成折叠后卸载明细 DOM，展开时再恢复。
  const childArray = React.Children.toArray(children)
  const renderContentChildren = (): React.ReactNode => {
    const activeKeys = new Set<string>()
    const rendered = childArray.map((child, index) => {
      const key = getProcessChildKey(child, index)
      activeKeys.add(key)
      const snapshot = getProcessChildSnapshot(child)
      const cached = stableChildrenRef.current.get(key)
      const stableChild = isStreaming && snapshot !== null && cached?.snapshot === snapshot
        ? cached.child
        : child
      if (snapshot !== null && (!cached || cached.snapshot !== snapshot)) {
        stableChildrenRef.current.set(key, { child, snapshot })
      }
      const isLast = index === childArray.length - 1
      const liveTail = !!isStreaming && isMessageTail && isLast
      return (
        <div
          key={key}
          data-work-process-live-tail={liveTail ? 'true' : undefined}
          className={cn('min-w-0', isStreaming && 'animate-in fade-in slide-in-from-top-1 duration-200 motion-reduce:animate-none')}
        >
          <StableProcessChild child={stableChild} />
        </div>
      )
    })
    for (const key of stableChildrenRef.current.keys()) {
      if (!activeKeys.has(key)) stableChildrenRef.current.delete(key)
    }
    return rendered
  }

  return (
    <div
      className="my-6"
      data-process-compact={!expanded ? 'true' : 'false'}
      data-work-process-boundary="true"
      data-work-message-view="v2"
    >
      <ZCodeWorkStatus
        label={triggerLabel}
        expanded={expanded}
        running={!!isStreaming}
        title={!isStreaming ? durationTooltip : undefined}
        onToggle={() => {
          userToggledRef.current = true
          setExpanded((current) => !current)
        }}
      />

      {shouldRenderContent && (
        <div
          ref={contentRef}
          className="overflow-hidden motion-reduce:!transition-none"
          style={{
            height: measuredHeight !== undefined ? `${measuredHeight}px` : 'auto',
            opacity: expanded ? 1 : 0,
            transition: measuredHeight !== undefined
              ? `height ${PROCESS_GROUP_COLLAPSE_DURATION_MS}ms ease-out, opacity ${PROCESS_GROUP_COLLAPSE_DURATION_MS}ms ease-out`
              : `opacity ${PROCESS_GROUP_COLLAPSE_DURATION_MS}ms ease-out`,
          }}
        >
          <div className="flex flex-col gap-4 pt-5" data-work-process-timeline="true">
            {renderContentChildren()}
            {!isStreaming && (
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-foreground/40 transition-colors hover:text-foreground/70"
                onClick={() => {
                  userToggledRef.current = true
                  setExpanded(false)
                }}
              >
                <ChevronRight className="size-3 -rotate-90" />
                <span>收起</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

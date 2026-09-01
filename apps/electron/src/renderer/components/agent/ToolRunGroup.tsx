/**
 * ToolRunGroup — 流式过程中的探索阶段摘要。
 *
 * 相邻的读取、搜索、网页访问和明显只读命令收拢为一行低权重摘要；thinking
 * 与中间正文仍由父级按原顺序直接展示。用户可展开阶段查看完整工具参数和结果。
 */

import * as React from 'react'
import { ChevronRight, Search, XCircle } from 'lucide-react'
import type { SDKContentBlock, SDKToolUseBlock } from '@domi/shared'
import { cn } from '@/lib/utils'
import { summarizeExplorationStage } from './tool-run-group'
import type { ToolPresentationIndex } from './tool-presentation-index'

interface ToolRunGroupProps {
  blocks: SDKToolUseBlock[]
  toolPresentationIndex: ToolPresentationIndex
  animate?: boolean
  isStreaming?: boolean
  /** 是否为当前流式过程最后一个可见活动单元。 */
  isActivityTail?: boolean
  /** 明细行渲染器：由调用方注入以复用 ContentBlock 的完整 props 组装逻辑。 */
  renderRow: (block: SDKContentBlock, index: number) => React.ReactNode
}

export function ToolRunGroup({
  blocks,
  toolPresentationIndex,
  animate = false,
  isStreaming = false,
  isActivityTail = false,
  renderRow,
}: ToolRunGroupProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false)
  const pendingCount = isStreaming
    ? blocks.filter((block) => !toolPresentationIndex.get(block.id)?.completed).length
    : 0
  const failedCount = blocks.filter((block) => toolPresentationIndex.get(block.id)?.isError).length
  const latestBlock = blocks.at(-1)
  const latestBlockFailed = latestBlock
    ? toolPresentationIndex.get(latestBlock.id)?.isError === true
    : false
  const showActivityShimmer = pendingCount > 0 || (
    isStreaming
    && isActivityTail
    && !latestBlockFailed
  )
  const summary = summarizeExplorationStage(blocks)

  return (
    <div className={cn(animate && 'animate-in fade-in slide-in-from-left-1 duration-150 fill-mode-both motion-reduce:animate-none')}>
      <button
        type="button"
        aria-expanded={expanded}
        className="flex max-w-full items-center gap-2 py-0.5 text-left text-muted-foreground/65 transition-colors hover:text-muted-foreground motion-reduce:transition-none"
        onClick={() => setExpanded((current) => !current)}
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground/35 transition-transform duration-150 motion-reduce:transition-none',
            expanded && 'rotate-90',
          )}
        />
        <Search className="size-3.5 shrink-0" />
        <span
          data-process-summary={showActivityShimmer ? 'shimmer' : undefined}
          className="min-w-0 truncate text-[13px]"
        >
          {summary}
        </span>
        {showActivityShimmer && (
          <span className="sr-only" role="status">
            {pendingCount > 0 ? `${pendingCount} 项探索进行中` : '正在处理探索结果'}
          </span>
        )}
        {failedCount > 0 && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-destructive/75">
            <XCircle className="size-3.5" />
            {failedCount} 项失败
          </span>
        )}
      </button>

      {expanded && (
        <div className="ml-[5px] mb-1.5 mt-1 space-y-0.5 border-l-2 border-border/30 pl-3 animate-in fade-in slide-in-from-top-1 duration-150 motion-reduce:animate-none">
          {blocks.map((block, index) => renderRow(block, index))}
        </div>
      )}
    </div>
  )
}

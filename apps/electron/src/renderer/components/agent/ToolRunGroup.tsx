/** 相邻的只读工具作为探索阶段呈现；详情仍由 ContentBlock 完整渲染。 */
import * as React from 'react'
import { Search } from 'lucide-react'
import type { SDKContentBlock, SDKToolUseBlock } from '@domi/shared'
import { cn } from '@/lib/utils'
import { getToolDisplayName } from './tool-utils'
import type { ToolPresentationIndex } from './tool-presentation-index'
import { ZCodeToolSummaryRow } from './ZCodeWorkPresentation'

interface ToolRunGroupProps {
  blocks: SDKToolUseBlock[]
  toolPresentationIndex: ToolPresentationIndex
  animate?: boolean
  isStreaming?: boolean
  isActivityTail?: boolean
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
  const pending = isStreaming && blocks.some((block) => !toolPresentationIndex.get(block.id)?.completed)
  const latestBlock = blocks.at(-1)
  const latestFailed = latestBlock ? toolPresentationIndex.get(latestBlock.id)?.isError === true : false
  const running = pending || (isStreaming && isActivityTail && !latestFailed)

  return (
    <div className={cn(animate && 'animate-in fade-in slide-in-from-left-1 duration-150 fill-mode-both motion-reduce:animate-none')}>
      <ZCodeToolSummaryRow
        icon={<Search className="size-4" />}
        kindLabel="探索"
        primaryText={isStreaming && isActivityTail && latestBlock && !latestFailed ? `正在${getToolDisplayName(latestBlock.name)}` : ''}
        running={running}
        expanded={expanded}
        onToggle={() => setExpanded((current) => !current)}
        statusNode={running ? <span className="sr-only" role="status">探索进行中</span> : undefined}
      />
      {expanded && (
        <div className="ml-2 space-y-2 border-l border-border pl-3.5 pt-2">
          {blocks.map((block, index) => renderRow(block, index))}
        </div>
      )}
    </div>
  )
}

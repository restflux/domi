/** 探索或简洁工具组只改变默认展开状态，详情仍由 ContentBlock 完整渲染。 */
import * as React from 'react'
import { List, Search } from 'lucide-react'
import type { SDKContentBlock, SDKToolUseBlock } from '@domi/shared'
import { cn } from '@/lib/utils'
import type { WorkStepDisplay } from '../../../types'
import type { ToolPresentationIndex } from './tool-presentation-index'
import { getToolRunActivity, getToolRunSummary } from './tool-run-group'
import { ZCodeToolSummaryRow } from './ZCodeWorkPresentation'

interface ToolRunGroupProps {
  blocks: SDKToolUseBlock[]
  toolPresentationIndex: ToolPresentationIndex
  display: WorkStepDisplay
  animate?: boolean
  isStreaming?: boolean
  isActivityTail?: boolean
  renderRow: (block: SDKContentBlock, index: number) => React.ReactNode
}

export function ToolRunGroup({
  blocks,
  toolPresentationIndex,
  display,
  animate = false,
  isStreaming = false,
  isActivityTail = false,
  renderRow,
}: ToolRunGroupProps): React.ReactElement {
  // 默认值跟随偏好；一旦用户操作，后续流式追加和运行结束都不覆盖其选择。
  const [userExpanded, setUserExpanded] = React.useState<boolean | undefined>(undefined)
  const expanded = userExpanded ?? display === 'detailed'
  const activity = getToolRunActivity(blocks, toolPresentationIndex, isStreaming, isActivityTail)
  const summary = [getToolRunSummary(blocks), activity].filter(Boolean).join(' · ')
  const compact = display === 'compact'

  return (
    <div className={cn(animate && 'animate-in fade-in slide-in-from-left-1 duration-150 fill-mode-both motion-reduce:animate-none')}>
      <ZCodeToolSummaryRow
        icon={compact ? <List className="size-4" /> : <Search className="size-4" />}
        kindLabel={compact ? '工作步骤' : '探索'}
        primaryText={summary}
        title={summary}
        running={!!activity}
        expanded={expanded}
        onToggle={() => setUserExpanded(!expanded)}
        statusNode={activity ? <span className="sr-only" role="status">{compact ? '工作步骤进行中' : '探索进行中'}</span> : undefined}
      />
      {expanded && (
        <div className="ml-2 space-y-2 border-l border-border pl-3.5 pt-2">
          {blocks.map((block, index) => <React.Fragment key={block.id}>{renderRow(block, index)}</React.Fragment>)}
        </div>
      )}
    </div>
  )
}

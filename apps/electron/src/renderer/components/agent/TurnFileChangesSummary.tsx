/**
 * TurnFileChangesSummary — Turn 底部文件改动汇总
 *
 * 在 AssistantTurnRenderer 的 MessageActions 之上，以 chip 横排展示本轮所有
 * 修改类工具调用（Edit / Write / MultiEdit / NotebookEdit）所触及的文件。
 *
 * 子代理（Agent/Task）的修改也会冒泡到此处——因为 SDK 的子代理 assistant
 * 消息同样存在于 turn.turnMessages 中（通过 parent_tool_use_id 关联）。
 *
 * 文件 chip 直接复用 FilePathChip（与 Agent 消息中的渲染完全一致）。
 */

import * as React from 'react'
import { ChevronRight, Files } from 'lucide-react'
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKToolUseBlock,
  SDKToolResultBlock,
} from '@domi/shared'
import { FilePathChip } from '@/components/ai-elements/file-path-chip'
import { cn } from '@/lib/utils'

const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * 本轮"触碰过"的工具集合（改 + 读）——用于正文内联文件引用的路径补全，比 MUTATING_TOOLS 更宽。
 * Read 的 input.file_path 与 Edit/Write 同构，都是绝对路径，可零解析纳入映射。
 * Grep/Glob 的 input 只有 pattern、命中文件仅存在于 tool_result 中，暂不纳入。
 * 注意：底部"文件改动汇总"chip 仍只用 MUTATING_TOOLS，不受此集合影响。
 */
const TOUCHED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read'])

function getFilePath(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'NotebookEdit') {
    const fp = input.notebook_path
    return typeof fp === 'string' ? fp : null
  }
  const fp = input.file_path ?? input.filePath ?? input.path
  return typeof fp === 'string' ? fp : null
}

function collectFilePaths(turnMessages: SDKMessage[], tools: Set<string> = MUTATING_TOOLS): string[] {
  const failed = new Set<string>()
  for (const msg of turnMessages) {
    if (msg.type !== 'user') continue
    const blocks = (msg as SDKUserMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue
      const rb = block as SDKToolResultBlock
      if (rb.is_error === true) failed.add(rb.tool_use_id)
    }
  }

  const seen = new Set<string>()
  const paths: string[] = []
  for (const msg of turnMessages) {
    if (msg.type !== 'assistant') continue
    const blocks = (msg as SDKAssistantMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      const tu = block as SDKToolUseBlock
      if (!tools.has(tu.name)) continue
      if (failed.has(tu.id)) continue

      const filePath = getFilePath(tu.name, tu.input as Record<string, unknown>)
      if (!filePath || seen.has(filePath)) continue
      seen.add(filePath)
      paths.push(filePath)
    }
  }
  return paths
}

/**
 * 构建「文件名 → 绝对路径」映射，供消息正文内联文件引用补全裸文件名使用。
 * 数据源为本轮"触碰过"的文件（TOUCHED_TOOLS：改过 + Read 读过），比底部改动汇总更宽，
 * 覆盖"本轮只读过没改就在正文引用"的高频场景；拿到的都是绝对路径。
 * 同名不同目录的文件无法凭裸文件名区分，直接从映射中剔除，交由既有 basePaths 解析逻辑处理
 * （不比补全前更差）。
 */
export function buildTurnFileNameMap(turnMessages: SDKMessage[]): Map<string, string> {
  const paths = collectFilePaths(turnMessages, TOUCHED_TOOLS)
  const map = new Map<string, string>()
  const conflicted = new Set<string>()
  for (const p of paths) {
    const name = p.split(/[\\/]/).pop() || p
    if (conflicted.has(name)) continue
    const existing = map.get(name)
    if (existing && existing !== p) {
      map.delete(name)
      conflicted.add(name)
      continue
    }
    map.set(name, p)
  }
  return map
}

export interface TurnFileChangesSummaryProps {
  turnMessages: SDKMessage[]
  basePath?: string
}

export function TurnFileChangesSummary({
  turnMessages,
  basePath,
}: TurnFileChangesSummaryProps): React.ReactElement | null {
  const paths = React.useMemo(() => collectFilePaths(turnMessages), [turnMessages])
  const [expanded, setExpanded] = React.useState(true)

  if (paths.length === 0) return null

  return (
      // ZCode ConversationFileSummaryPanel：移植容器、标题触发器及文件行结构；
      // 不搬运其 Git 回滚、diff 预览与额外状态管理，文件入口沿用 Domi FilePathChip。
      <section data-work-v2-file-summary="true" className="mt-5 overflow-hidden rounded-xl border border-border bg-card shadow-none">
        <div className="flex h-10 items-center justify-between gap-3 px-2 transition-colors hover:bg-muted/50">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            className="flex h-full min-w-0 flex-1 items-center gap-2 px-1 text-left text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
            <Files className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate font-medium">已编辑文件</span>
          </button>
        </div>
        {expanded && <div className="grid w-full border-t border-border">
          {paths.map((filePath) => (
            <div key={filePath} className="w-full overflow-hidden bg-background/50 px-3 py-1.5 text-sm text-muted-foreground">
              <FilePathChip filePath={filePath} basePath={basePath} />
            </div>
          ))}
        </div>}
      </section>
  )
}

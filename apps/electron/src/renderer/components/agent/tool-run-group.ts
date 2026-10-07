import type { SDKContentBlock, SDKToolUseBlock } from '@domi/shared'
import type { WorkStepDisplay } from '../../../types'
import type { ToolPresentationIndex } from './tool-presentation-index'
import { getToolPhrase } from './tool-phrase'

/** 相邻工具按展示密度聚合；正文、思考、失败与交互始终阻断分组。 */
export interface ProcessDetailUnit {
  kind: 'single' | 'exploration' | 'steps'
  blocks: SDKContentBlock[]
  startIndex: number
}

const EXPLORATION_TOOL_NAMES = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch'])
const COMPACT_TOOL_NAMES = new Set([...EXPLORATION_TOOL_NAMES, 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

interface ProcessDetailOptions {
  display?: WorkStepDisplay
  toolPresentationIndex?: ToolPresentationIndex
}

export function buildProcessDetailUnits(
  blocks: SDKContentBlock[],
  { display = 'standard', toolPresentationIndex }: ProcessDetailOptions = {},
): ProcessDetailUnit[] {
  const units: ProcessDetailUnit[] = []
  let grouped: SDKToolUseBlock[] = []
  let startIndex = 0
  const names = display === 'compact' ? COMPACT_TOOL_NAMES : EXPLORATION_TOOL_NAMES

  const flush = (): void => {
    if (grouped.length === 0) return
    units.push({ kind: display === 'compact' ? 'steps' : 'exploration', blocks: grouped, startIndex })
    grouped = []
  }

  blocks.forEach((block, index) => {
    if (block.type === 'tool_use') {
      const tool = block as SDKToolUseBlock
      const result = toolPresentationIndex?.get(tool.id)
      // 失败和图片结果不可藏入摘要；未知产品工具保守地保持独立。
      if (names.has(tool.name) && !result?.isError && !result?.images.length) {
        if (grouped.length === 0) startIndex = index
        grouped.push(tool)
        return
      }
    }
    flush()
    units.push({ kind: 'single', blocks: [block], startIndex: index })
  })
  flush()
  return units
}

/** 同一文件分段读取仅计一次；数量描述调用范围，不把待完成操作称为已完成。 */
export function getToolRunSummary(blocks: SDKToolUseBlock[]): string {
  const readFiles = new Set<string>()
  const changedFiles = new Set<string>()
  let searches = 0
  let directories = 0
  let pages = 0
  let commands = 0
  let other = 0
  for (const block of blocks) {
    const path = block.input.file_path ?? block.input.filePath ?? block.input.path
    const fileKey = typeof path === 'string' && path ? path : block.id
    switch (block.name) {
      case 'Read':
        readFiles.add(fileKey)
        break
      case 'Edit':
      case 'Write':
      case 'MultiEdit':
      case 'NotebookEdit':
        changedFiles.add(fileKey)
        break
      case 'Grep':
      case 'Glob':
      case 'WebSearch':
        searches += 1
        break
      case 'LS': directories += 1; break
      case 'WebFetch': pages += 1; break
      case 'Bash': commands += 1; break
      default: other += 1
    }
  }
  return [
    readFiles.size > 0 ? `读取 ${readFiles.size} 个文件` : '',
    searches > 0 ? `搜索 ${searches} 次` : '',
    directories > 0 ? `查看 ${directories} 个目录` : '',
    pages > 0 ? `访问 ${pages} 个网页` : '',
    changedFiles.size > 0 ? `修改 ${changedFiles.size} 个文件` : '',
    commands > 0 ? `执行 ${commands} 条命令` : '',
    other > 0 ? `${other} 项操作` : '',
  ].filter(Boolean).join(' · ')
}

export function getToolRunActivity(
  blocks: SDKToolUseBlock[],
  index: ToolPresentationIndex,
  isStreaming: boolean,
  isActivityTail: boolean,
): string | undefined {
  if (!isStreaming) return undefined
  const pending = blocks.findLast((block) => !index.get(block.id)?.completed && !index.get(block.id)?.isError)
  if (pending) return getToolPhrase(pending.name, pending.input).loadingLabel
  return isActivityTail && !blocks.some((block) => index.get(block.id)?.isError)
    ? '正在整理结果'
    : undefined
}

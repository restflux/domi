import type { SDKContentBlock, SDKToolUseBlock } from '@domi/shared'
import { extractFilePath } from './tool-utils'
import type { ToolPresentationIndex } from './tool-presentation-index'

const SEARCH_TOOL_NAMES = new Set(['Grep', 'Glob', 'LS', 'WebSearch'])
const MUTATION_TOOL_NAMES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const COMMAND_TOOL_NAMES = new Set(['Bash', 'REPL', 'Workflow'])
const WEB_TOOL_NAMES = new Set(['WebFetch'])

export interface ProcessActivityPresentation {
  summary: string
  failedToolCount: number
  toolCount: number
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase()
}

function fileIdentity(block: SDKToolUseBlock): string | null {
  const path = extractFilePath((block.input ?? {}) as Record<string, unknown>)
  return path ? normalizePath(path) : null
}

/** 将完整过程派生为完成后折叠态使用的稳定语义摘要。 */
export function buildProcessActivityPresentation(
  blocks: readonly SDKContentBlock[],
  toolIndex: ToolPresentationIndex = new Map(),
  isStreaming = false,
): ProcessActivityPresentation {
  const tools = blocks.filter((block): block is SDKToolUseBlock => block.type === 'tool_use')
  const failedToolCount = tools.filter((tool) => toolIndex.get(tool.id)?.isError).length

  if (tools.some((tool) => tool.name === 'ForkToWorktree')) {
    return {
      summary: isStreaming
        ? '正在安排 managed Worktree 子会话…'
        : '已安排 managed Worktree 子会话，启动后将自动切换',
      failedToolCount,
      toolCount: tools.length,
    }
  }

  const readFiles = new Set<string>()
  const changedFiles = new Set<string>()
  let searchCount = 0
  let commandCount = 0
  let webCount = 0
  let otherCount = 0

  for (const tool of tools) {
    if (tool.name === 'Read') {
      const identity = fileIdentity(tool)
      if (identity) readFiles.add(identity)
      else otherCount += 1
    } else if (MUTATION_TOOL_NAMES.has(tool.name)) {
      const identity = fileIdentity(tool)
      if (identity) changedFiles.add(identity)
      else otherCount += 1
    } else if (SEARCH_TOOL_NAMES.has(tool.name)) {
      searchCount += 1
    } else if (COMMAND_TOOL_NAMES.has(tool.name)) {
      commandCount += 1
    } else if (WEB_TOOL_NAMES.has(tool.name)) {
      webCount += 1
    } else {
      otherCount += 1
    }
  }

  const messageCount = blocks.filter((block) => block.type === 'thinking' || block.type === 'text').length
  const parts: string[] = []
  if (readFiles.size > 0) parts.push(`读取 ${readFiles.size} 个文件`)
  if (searchCount > 0) parts.push(`搜索 ${searchCount} 次`)
  if (changedFiles.size > 0) parts.push(`修改 ${changedFiles.size} 个文件`)
  if (commandCount > 0) parts.push(`执行 ${commandCount} 条命令`)
  if (webCount > 0) parts.push(`访问 ${webCount} 个网页`)
  if (otherCount > 0) parts.push(`${otherCount} 项操作`)
  if (tools.length === 0 && messageCount > 0) parts.push(`${messageCount} 段思考`)

  return {
    summary: parts.length > 0 ? `执行过程 · ${parts.join(' · ')}` : '执行过程',
    failedToolCount,
    toolCount: tools.length,
  }
}

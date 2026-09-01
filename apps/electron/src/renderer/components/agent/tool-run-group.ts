import type { SDKContentBlock, SDKToolUseBlock } from '@domi/shared'

/** 流式过程详情中的渲染单元：探索工具按相邻阶段聚合，叙事块与特殊工具保持原位。 */
export interface ProcessDetailUnit {
  kind: 'single' | 'exploration'
  blocks: SDKContentBlock[]
  startIndex: number
}

const EXPLORATION_TOOL_NAMES = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'WebFetch',
  'WebSearch',
])

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 归一化路径分隔符，让 Windows 反斜杠与 POSIX 斜杠视为同一文件。 */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

function isReadOnlyShellSegment(segment: string): boolean {
  const command = segment.trim().toLowerCase()
  if (!command) return true

  if (/^git\s+(status|diff|show|log|grep|ls-files|rev-parse)\b/.test(command)) return true
  if (/^(ls|rg|grep|cat|head|tail|pwd|wc)\b/.test(command)) return true
  if (/^find\b/.test(command)) return !/\s-(delete|exec|execdir|ok)\b/.test(command)
  if (/^sed\s+-n\b/.test(command)) return !/\s-i(?:\s|$)/.test(command)
  return false
}

/**
 * 只把能保守判定为只读的 Bash 调用归入探索阶段。
 * 重定向、命令替换或任一修改/测试/构建子命令都会让整条命令保持独立展示。
 */
export function isExplorationCommand(input: Record<string, unknown>): boolean {
  const command = str(input.command)?.trim()
  if (!command || /[<>`]|\$\(/.test(command)) return false
  return command
    .split(/\s*(?:&&|\|\||;|\||\r?\n)\s*/)
    .every(isReadOnlyShellSegment)
}

function isExplorationTool(block: SDKToolUseBlock): boolean {
  if (EXPLORATION_TOOL_NAMES.has(block.name)) return true
  return block.name === 'Bash'
    && isExplorationCommand((block.input ?? {}) as Record<string, unknown>)
}

/**
 * 按 thinking / 中间正文 / 特殊工具切分过程详情。
 * 相邻的读取、搜索、网页访问和明显只读命令合并为一个探索阶段，叙事顺序保持不变。
 */
export function buildProcessDetailUnits(blocks: SDKContentBlock[]): ProcessDetailUnit[] {
  const units: ProcessDetailUnit[] = []
  let explorationBlocks: SDKToolUseBlock[] = []
  let explorationStartIndex = 0

  const flushExploration = (): void => {
    if (explorationBlocks.length === 0) return
    units.push({ kind: 'exploration', blocks: explorationBlocks, startIndex: explorationStartIndex })
    explorationBlocks = []
  }

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (!block) continue
    if (block.type === 'tool_use' && isExplorationTool(block as SDKToolUseBlock)) {
      if (explorationBlocks.length === 0) explorationStartIndex = index
      explorationBlocks.push(block as SDKToolUseBlock)
      continue
    }

    flushExploration()
    units.push({ kind: 'single', blocks: [block], startIndex: index })
  }

  flushExploration()
  return units
}

function normalizedFilePath(block: SDKToolUseBlock): string | null {
  const input = (block.input ?? {}) as Record<string, unknown>
  const path = str(input.file_path) ?? str(input.filePath) ?? str(input.path)
  return path ? normalizePath(path) : null
}

/** 生成「探索 · 2 个文件 · 3 次搜索」阶段摘要。 */
export function summarizeExplorationStage(blocks: SDKToolUseBlock[]): string {
  const files = new Set<string>()
  let searchCount = 0
  let webCount = 0
  let commandCount = 0
  let otherCount = 0

  for (const block of blocks) {
    if (block.name === 'Read') {
      const path = normalizedFilePath(block)
      if (path) files.add(path)
      else otherCount += 1
    } else if (block.name === 'Grep' || block.name === 'Glob' || block.name === 'LS') {
      searchCount += 1
    } else if (block.name === 'WebFetch' || block.name === 'WebSearch') {
      webCount += 1
    } else if (block.name === 'Bash') {
      commandCount += 1
    } else {
      otherCount += 1
    }
  }

  const parts: string[] = []
  if (files.size > 0) parts.push(`${files.size} 个文件`)
  if (searchCount > 0) parts.push(`${searchCount} 次搜索`)
  if (webCount > 0) parts.push(`${webCount} 项网页访问`)
  if (commandCount > 0) parts.push(`${commandCount} 条只读命令`)
  if (otherCount > 0) parts.push(`${otherCount} 项操作`)
  return `探索 · ${parts.join(' · ') || `${blocks.length} 项操作`}`
}

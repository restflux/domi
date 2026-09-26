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

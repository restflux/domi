import { describe, expect, test } from 'bun:test'
import type { SDKContentBlock, SDKToolUseBlock } from '@domi/shared'
import {
  buildProcessDetailUnits,
  isExplorationCommand,
  summarizeExplorationStage,
} from './tool-run-group'

function toolUse(name: string, input: Record<string, unknown>, id = ''): SDKToolUseBlock {
  return {
    type: 'tool_use',
    name,
    input,
    id: id || `${name}-${JSON.stringify(input)}-${Math.random()}`,
  } as unknown as SDKToolUseBlock
}

function text(value: string): SDKContentBlock {
  return { type: 'text', text: value } as unknown as SDKContentBlock
}

describe('buildProcessDetailUnits', () => {
  test('Given thinking 与中间说明分隔探索工具 When 构建详情 Then 保持原始叙事顺序并分阶段聚合', () => {
    const firstThinking = { type: 'thinking', thinking: '先检查入口' } as SDKContentBlock
    const middleText = text('再检查恢复逻辑')
    const finalThinking = { type: 'thinking', thinking: '最后验证命令' } as SDKContentBlock
    const bash = toolUse('Bash', { command: 'git status' })
    const units = buildProcessDetailUnits([
      firstThinking,
      toolUse('Read', { path: '/w/a.ts' }),
      toolUse('Grep', { pattern: 'process' }),
      middleText,
      toolUse('Read', { path: '/w/b.ts' }),
      toolUse('Read', { path: '/w/c.ts' }),
      finalThinking,
      bash,
    ])

    expect(units.map((unit) => unit.kind)).toEqual([
      'single',
      'exploration',
      'single',
      'exploration',
      'single',
      'exploration',
    ])
    expect(units[0]?.blocks[0]).toBe(firstThinking)
    expect(units[2]?.blocks[0]).toBe(middleText)
    expect(units[4]?.blocks[0]).toBe(finalThinking)
    expect(units[5]?.blocks[0]).toBe(bash)
  })

  test('Given 特殊决策和修改工具相邻探索 When 构建详情 Then 它们保持独立且阻断聚合', () => {
    const ask = toolUse('AskUserQuestion', { questions: [] })
    const edit = toolUse('Edit', { path: '/w/a.ts' })
    const plan = toolUse('ExitPlanMode', { plan: '# 计划' })
    const units = buildProcessDetailUnits([
      toolUse('Read', { path: '/w/a.ts' }),
      ask,
      toolUse('Grep', { pattern: 'state' }),
      edit,
      toolUse('Glob', { pattern: '**/*.tsx' }),
      plan,
    ])

    expect(units.map((unit) => unit.kind)).toEqual([
      'exploration',
      'single',
      'exploration',
      'single',
      'exploration',
      'single',
    ])
    expect(units[1]?.blocks[0]).toBe(ask)
    expect(units[3]?.blocks[0]).toBe(edit)
    expect(units[5]?.blocks[0]).toBe(plan)
  })

  test('Given 重复路径与搜索调用 When 生成探索摘要 Then 文件去重且搜索按调用计数', () => {
    expect(summarizeExplorationStage([
      toolUse('Read', { path: 'C:\\w\\a.ts' }),
      toolUse('Read', { file_path: 'c:/w/a.ts' }),
      toolUse('Read', { path: '/w/b.ts' }),
      toolUse('Grep', { pattern: 'process' }),
      toolUse('Glob', { pattern: '**/*.tsx' }),
    ])).toBe('探索 · 2 个文件 · 2 次搜索')
  })
})

describe('isExplorationCommand', () => {
  test('Given 组合的只读命令 When 分类 Then 可进入探索阶段', () => {
    expect(isExplorationCommand({ command: 'git status && rg "process" apps/electron | head -20' })).toBe(true)
    expect(isExplorationCommand({ command: 'sed -n "1,120p" file.ts' })).toBe(true)
  })

  test('Given 修改、测试、构建或重定向命令 When 分类 Then 保持独立展示', () => {
    expect(isExplorationCommand({ command: 'git checkout -- file.ts' })).toBe(false)
    expect(isExplorationCommand({ command: 'bun test apps/electron' })).toBe(false)
    expect(isExplorationCommand({ command: 'cat source > target' })).toBe(false)
    expect(isExplorationCommand({ command: 'find . -delete' })).toBe(false)
    expect(isExplorationCommand({ command: 'sed -i "s/a/b/" file.ts' })).toBe(false)
  })
})

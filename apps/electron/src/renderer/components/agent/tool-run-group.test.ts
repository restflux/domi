import { describe, expect, test } from 'bun:test'
import type { SDKContentBlock, SDKToolUseBlock } from '@domi/shared'
import type { WorkStepDisplay } from '../../../types'
import { buildProcessDetailUnits, getToolRunActivity, getToolRunSummary } from './tool-run-group'
import type { ToolPresentationEntry } from './tool-presentation-index'

const tool = (name: string, id: string, input: Record<string, unknown> = {}): SDKToolUseBlock => ({ type: 'tool_use', name, id, input })
const result = (isError = false): ToolPresentationEntry => ({ completed: true, isError, images: [] })
const text: SDKContentBlock = { type: 'text', text: '继续检查恢复逻辑。' }
const thinking: SDKContentBlock = { type: 'thinking', thinking: '分析恢复逻辑' }

describe('工作步骤密度与叙事顺序', () => {
  test('Given 标准或详细 When 读取搜索间有正文、思考、修改和命令 Then 分段探索且关键动作独立', () => {
    const blocks = [tool('Read', 'r1'), tool('Grep', 'g1'), text, tool('Read', 'r2'), thinking, tool('Edit', 'e1'), tool('Bash', 'b1', { command: 'git status' }), tool('Read', 'r3')]
    for (const display of ['standard', 'detailed'] as const) {
      const units = buildProcessDetailUnits(blocks, { display })
      expect(units.map((unit) => unit.kind)).toEqual(['exploration', 'single', 'exploration', 'single', 'single', 'single', 'exploration'])
      expect(units.flatMap((unit) => unit.blocks)).toEqual(blocks)
      expect(units.map((unit) => unit.startIndex)).toEqual([0, 2, 3, 4, 5, 6, 7])
    }
  })

  test('Given 简洁 When 连续读取修改执行 Then 合成工作步骤摘要而非探索', () => {
    const blocks = [tool('Read', 'r1'), tool('Edit', 'e1'), tool('Bash', 'b1'), text, tool('Read', 'r2')]
    const units = buildProcessDetailUnits(blocks, { display: 'compact' })
    expect(units.map((unit) => unit.kind)).toEqual(['steps', 'single', 'steps'])
    expect(units.flatMap((unit) => unit.blocks)).toEqual(blocks)
  })

  test('Given 任意密度 When 工具失败或有图片结果 Then 阻断分组且独立展示', () => {
    const blocks = [tool('Read', 'r1'), tool('Grep', 'failed'), tool('Read', 'image'), tool('Read', 'r2')]
    const index = new Map([['failed', result(true)], ['image', { ...result(), images: [{ data: 'image', mimeType: 'image/png' }] }]])
    for (const display of ['compact', 'standard', 'detailed'] satisfies WorkStepDisplay[]) {
      const units = buildProcessDetailUnits(blocks, { display, toolPresentationIndex: index })
      expect(units[1]?.kind).toBe('single')
      expect(units[2]?.kind).toBe('single')
      expect(units.flatMap((unit) => unit.blocks)).toEqual(blocks)
    }
  })

  test('Given 任意密度 When 出现裁决、交付或未知工具 Then 保持独立并阻断聚合', () => {
    for (const display of ['compact', 'standard', 'detailed'] satisfies WorkStepDisplay[]) {
      for (const name of ['AskUserQuestion', 'ExitPlanMode', 'RequestDirectWorkflow', 'ReadyForReview', 'mcp__custom__tool']) {
        const blocks = [tool('Read', 'r1'), tool(name, 'special'), tool('Read', 'r2')]
        const units = buildProcessDetailUnits(blocks, { display })
        expect(units).toHaveLength(3)
        expect(units[1]?.kind).toBe('single')
        expect(units[1]?.blocks).toEqual([blocks[1]!])
      }
    }
  })
})

describe('真实工具数量与当前动作', () => {
  test('Given 同一文件分段读取和多种探索 When 汇总 Then 文件去重且只统计真实调用', () => {
    expect(getToolRunSummary([
      tool('Read', 'r1', { path: '/w/a.ts', offset: 1 }),
      tool('Read', 'r2', { file_path: '/w/a.ts', offset: 20 }),
      tool('Read', 'r3', { filePath: '/w/b.ts' }),
      tool('Grep', 'g1'), tool('Glob', 'g2'), tool('WebSearch', 'w1'),
      tool('LS', 'l1'), tool('WebFetch', 'w2'),
    ])).toBe('读取 2 个文件 · 搜索 3 次 · 查看 1 个目录 · 访问 1 个网页')
  })

  test('Given 简洁工具组 When 汇总 Then 修改去重且命令计数', () => {
    expect(getToolRunSummary([tool('Edit', 'e1', { path: '/w/a.ts' }), tool('Write', 'e2', { path: '/w/a.ts' }), tool('Bash', 'b1')]))
      .toBe('修改 1 个文件 · 执行 1 条命令')
  })

  test('Given 前面的工具尚未完成而末尾已完成 When 显示当前动作 Then 展示真正的 pending 文件', () => {
    const blocks = [tool('Read', 'pending', { path: '/w/pending.ts' }), tool('Read', 'done', { path: '/w/done.ts' })]
    expect(getToolRunActivity(blocks, new Map([['done', result()]]), true, false)).toBe('正在读取 pending.ts...')
  })

  test('Given 全部完成但仍为活动尾部 When 显示状态 Then 整理结果而非继续读取', () => {
    const blocks = [tool('Read', 'r1', { path: '/w/a.ts' })]
    const index = new Map([['r1', result()]])
    expect(getToolRunActivity(blocks, index, true, true)).toBe('正在整理结果')
    expect(getToolRunActivity(blocks, index, true, false)).toBeUndefined()
    expect(getToolRunActivity(blocks, index, false, true)).toBeUndefined()
    expect(getToolRunActivity(blocks, new Map([['r1', result(true)]]), true, true)).toBeUndefined()
  })
})

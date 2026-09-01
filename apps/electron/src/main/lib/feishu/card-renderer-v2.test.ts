import { describe, expect, test } from 'bun:test'
import { renderCard } from './card-renderer-v2'
import type { RunState, ToolEntry } from './card-run-state'

interface CardNode {
  tag?: string
  expanded?: boolean
  elements?: unknown[]
  body?: { elements?: unknown[] }
}

// Extended_Pictographic 比手写的范围数组更完整：覆盖国旗、Dingbats 扩展、
// Symbols-and-Pictographs 等所有官方分类的 emoji 字符（不含修饰符与 ZWJ）。
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u

function tool(id: string, status: ToolEntry['status']): ToolEntry {
  return {
    id,
    name: 'Bash',
    input: { command: `echo ${id}` },
    status,
    output: `output ${id}`,
  }
}

function stateWithTools(tools: ToolEntry[], terminal: RunState['terminal']): RunState {
  return {
    blocks: tools.map((entry) => ({ kind: 'tool', tool: entry })),
    reasoning: { content: '', active: false },
    partialAssistantSnapshots: {},
    footer: terminal === 'running' ? 'tool_running' : null,
    terminal,
    startedAt: Date.now(),
    meta: {},
  }
}

function collectText(node: unknown): string[] {
  if (typeof node === 'string') return [node]
  if (Array.isArray(node)) return node.flatMap(collectText)
  if (!node || typeof node !== 'object') return []
  return Object.values(node).flatMap(collectText)
}

function collectCollapsiblePanels(node: unknown): CardNode[] {
  if (!node || typeof node !== 'object') return []

  const current = node as CardNode
  const panels = current.tag === 'collapsible_panel' ? [current] : []
  const children = [
    ...(current.elements ?? []),
    ...(current.body?.elements ?? []),
  ]

  return [
    ...panels,
    ...children.flatMap((child) => collectCollapsiblePanels(child)),
  ]
}

describe('飞书流式卡片工具调用折叠', () => {
  test('Given 单个运行中的工具 When 渲染卡片 Then 工具面板默认收起', () => {
    const card = renderCard(stateWithTools([tool('tool-1', 'running')], 'running'))

    const panels = collectCollapsiblePanels(card)

    expect(panels).toHaveLength(1)
    expect(panels[0]?.expanded).toBe(false)
  })

  test('Given 多个已完成工具 When 渲染最终卡片 Then 工具摘要面板默认收起', () => {
    const card = renderCard(stateWithTools([
      tool('tool-1', 'done'),
      tool('tool-2', 'done'),
      tool('tool-3', 'done'),
    ], 'done'))

    const panels = collectCollapsiblePanels(card)

    expect(panels).toHaveLength(1)
    expect(panels[0]?.expanded).toBe(false)
  })

  test('Given 工具调用卡片 When 渲染 Then 卡片文案不包含 Emoji', () => {
    const card = renderCard(stateWithTools([tool('tool-1', 'running')], 'running'), {
      stopHint: '发送 `/stop` 可终止当前任务',
    })

    expect(JSON.stringify(card)).not.toMatch(EMOJI_PATTERN)
  })

  test('Given 已完成运行包含模型和推理档位 When 渲染 Then 页脚按模型后推理强度展示', () => {
    const state: RunState = {
      ...stateWithTools([], 'done'),
      meta: {
        durationMs: 14_100,
        inputTokens: 21_922,
        outputTokens: 97,
        model: 'gpt-5.6-sol',
        thinkingLevel: 'high',
      },
    }

    const text = collectText(renderCard(state)).join('\n')

    expect(text).toContain('14.1s  ·  21922↑ 97↓ tokens  ·  gpt-5.6-sol  ·  推理 High')
  })
})

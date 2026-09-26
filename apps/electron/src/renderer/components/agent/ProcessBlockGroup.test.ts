import { describe, expect, test } from 'bun:test'
import { buildAssistantTurnRenderItems, buildWorkProcessTriggerLabel, formatWorkProcessDuration, stabilizeProcessBlockReferences } from './ProcessBlockGroup'
import type { SDKContentBlock } from '@domi/shared'

const tool = (id: string, name = 'Read', input: Record<string, unknown> = {}): SDKContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
})

const thinking = (text = '分析中'): SDKContentBlock => ({
  type: 'thinking',
  thinking: text,
})

const text = (value: string): SDKContentBlock => ({
  type: 'text',
  text: value,
})

describe('Agent 过程块折叠分组', () => {
  test('正文后发起下一轮或验收工具时，用时过程入口仍先于正文，工具留在可回看的过程内', () => {
    for (const name of ['RequestNextWorktreeIteration', 'RequestWorktreePreviewRevision', 'ReadyForReview']) {
      for (const isStreaming of [true, false]) {
        const items = buildAssistantTurnRenderItems([
          thinking('检查变更'), tool('read-1'), text('最终回复。'), tool('terminal-1', name),
        ], { isStreaming })
        expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
        if (items[0]?.type === 'process-group') {
          expect(items[0].items.map((item) => item.index)).toEqual([0, 1, 3])
        }
        if (items[1]?.type === 'block') expect(items[1].item.index).toBe(2)
      }
    }
  })

  test('仅有回复正文和下一轮终止工具时，入口也先于正文而非尾随卡片', () => {
    const items = buildAssistantTurnRenderItems([text('最终回复。'), tool('terminal-1', 'RequestNextWorktreeIteration')])
    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') expect(items[0].items.map((item) => item.index)).toEqual([1])
  })

  test('given completed turn duration when formatting process entry then uses compact Chinese duration', () => {
    expect(formatWorkProcessDuration(320)).toBe('不足 1 秒')
    expect(formatWorkProcessDuration(10_400)).toBe('10 秒')
    expect(formatWorkProcessDuration(66_000)).toBe('1 分 6 秒')
    expect(formatWorkProcessDuration(120_000)).toBe('2 分钟')
  })

  test('运行中只显示耗时，没有起点时只显示工作状态；完成后显示最终耗时', () => {
    expect(buildWorkProcessTriggerLabel({ isStreaming: true, elapsedMs: 19_000 }))
      .toBe('工作中 · 已用时 19 秒')
    expect(buildWorkProcessTriggerLabel({ isStreaming: true })).toBe('工作中')
    expect(buildWorkProcessTriggerLabel({ isStreaming: false, durationMs: 19_000 }))
      .toBe('用时 19 秒')
    expect(buildWorkProcessTriggerLabel({ isStreaming: false })).toBe('工作过程')
  })

  test('given continuous thinking and tools before final text when grouping then folds them into one process group', () => {
    const items = buildAssistantTurnRenderItems([
      thinking(),
      tool('tool-1'),
      tool('tool-2'),
      text('最终输出'),
    ])

    expect(items).toHaveLength(2)
    expect(items[0]?.type).toBe('process-group')
    expect(items[1]?.type).toBe('block')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1, 2])
    }
  })

  test('given intermediate text between tool runs when grouping then keeps only final output outside process group', () => {
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      text('中间说明'),
      tool('tool-2'),
      text('最终输出'),
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1, 2])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(3)
    }
  })

  test('given streaming turn with trailing text when grouping then renders delivery text outside the process viewport', () => {
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      text('流式交付正文'),
    ], { isStreaming: true })

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(1)
    }
  })

  test('given streaming turn with completed tools before trailing text when grouping then keeps final output outside process group', () => {
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      text('最终输出'),
    ], { isStreaming: true })

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(1)
    }
  })

  test('given completed turn when grouping then keeps final output outside process group', () => {
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      text('最终输出'),
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    expect(items[0]?.type).toBe('process-group')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0])
    }
  })

  test('given pure text streaming turn when grouping then keeps text as normal output', () => {
    const items = buildAssistantTurnRenderItems([
      text('普通回答'),
    ], { isStreaming: true })

    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('block')
  })

  test('given process only turn when grouping then folds the whole turn', () => {
    const items = buildAssistantTurnRenderItems([
      thinking(),
      tool('tool-1'),
    ])

    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('process-group')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1])
    }
  })

  test('given streaming thinking followed by text when grouping then keeps the growing answer out of the process viewport', () => {
    const items = buildAssistantTurnRenderItems([
      thinking(),
      text('暂时的回答片段'),
    ], { isStreaming: true })

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
  })

  test('given only the externalized final text changes when stabilizing process blocks then reuses the previous process array', () => {
    const processBlocks = [thinking(), tool('tool-1')]
    const previous = processBlocks.slice()
    const next = processBlocks.slice()

    expect(stabilizeProcessBlockReferences(previous, next)).toBe(previous)
    expect(stabilizeProcessBlockReferences(previous, [thinking('新思考'), processBlocks[1]!])).not.toBe(previous)
  })

  test('given ExitPlanMode persists its plan only in tool input when grouping then keeps the plan outside the process group', () => {
    const items = buildAssistantTurnRenderItems([
      thinking(),
      tool('plan-tool', 'ExitPlanMode', { plan: '# 实施计划\n\n1. 修改 renderer' }),
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(1)
    }
  })

  test('given legacy ExitPlanMode has no plan input when grouping then keeps it as a normal process record', () => {
    const items = buildAssistantTurnRenderItems([
      thinking(),
      tool('plan-tool', 'ExitPlanMode'),
    ])

    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('process-group')
  })

  test('given plan text ending with ExitPlanMode when grouping then keeps plan body visible instead of folding into process group', () => {
    const items = buildAssistantTurnRenderItems([
      text('详细计划正文'),
      tool('plan-tool', 'ExitPlanMode'),
    ])

    expect(items.map((item) => item.type)).toEqual(['block', 'block'])
    if (items[0]?.type === 'block') {
      expect(items[0].item.index).toBe(0)
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(1)
    }
  })

  test('given research process before plan submission when grouping then keeps only the plan body and approval tool outside the process group', () => {
    const items = buildAssistantTurnRenderItems([
      thinking(),
      tool('tool-1'),
      text('详细计划正文'),
      tool('plan-tool', 'ExitPlanMode'),
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(2)
    }
    if (items[2]?.type === 'block') {
      expect(items[2].item.index).toBe(3)
    }
  })

  test('given streaming RequestDirectWorkflow without separate text when grouping then keeps the persisted feedback tool visible', () => {
    const items = buildAssistantTurnRenderItems([
      thinking(),
      tool('dw-tool', 'RequestDirectWorkflow'),
    ], { isStreaming: true })

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(1)
    }
  })

  test('given direct workflow feedback ending with RequestDirectWorkflow when grouping then keeps feedback body visible', () => {
    const items = buildAssistantTurnRenderItems([
      tool('tool-1'),
      text('调研后的实施反馈正文'),
      tool('dw-tool', 'RequestDirectWorkflow'),
    ])

    expect(items.map((item) => item.type)).toEqual(['process-group', 'block', 'block'])
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0])
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(1)
    }
    if (items[2]?.type === 'block') {
      expect(items[2].item.index).toBe(2)
    }
  })

  test('given question text ending with AskUserQuestion when grouping then keeps question context visible', () => {
    const items = buildAssistantTurnRenderItems([
      text('需要你确认的问题说明'),
      tool('ask-tool', 'AskUserQuestion'),
    ])

    expect(items.map((item) => item.type)).toEqual(['block', 'block'])
    if (items[0]?.type === 'block') {
      expect(items[0].item.index).toBe(0)
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(1)
    }
  })

  test('given text ending with a regular tool call when grouping then still folds the whole turn into process group', () => {
    const items = buildAssistantTurnRenderItems([
      text('中间说明'),
      tool('tool-2'),
    ])

    expect(items).toHaveLength(1)
    expect(items[0]?.type).toBe('process-group')
    if (items[0]?.type === 'process-group') {
      expect(items[0].items.map((item) => item.index)).toEqual([0, 1])
    }
  })

  test('given interrupted text followed by trailing thinking when grouping then keeps the final text visible', () => {
    const items = buildAssistantTurnRenderItems([
      text('被中断前的最终正文'),
      thinking(),
    ])

    expect(items.map((item) => item.type)).toEqual(['block', 'block'])
    if (items[0]?.type === 'block') {
      expect(items[0].item.index).toBe(0)
    }
    if (items[1]?.type === 'block') {
      expect(items[1].item.index).toBe(1)
    }
  })
})

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ModelOption } from '@domi/shared'
import { getModelPickerGroups, groupByChannel, nextModelHighlight } from './model-selector-options'

const options: ModelOption[] = [
  { channelId: 'a', channelName: '渠道 A', modelId: 'gpt-6', modelName: 'GPT', provider: 'openai' },
  { channelId: 'a', channelName: '渠道 A', modelId: 'kimi-k3', modelName: 'Kimi', provider: 'openai' },
  { channelId: 'b', channelName: '渠道 B', modelId: 'gpt-6', modelName: 'GPT', provider: 'openai' },
]
const grouped = groupByChannel(options)

describe('模型选择的可见选项', () => {
  test('默认仅展开当前渠道，但其他渠道标题仍可见', () => {
    const result = getModelPickerGroups(grouped, '', 'a')
    expect([...result.groups.keys()]).toEqual(['a', 'b'])
    expect(result.visibleOptions).toEqual(options.slice(0, 2))
  })
  test('切换渠道后键盘只能选择新渠道的模型', () => {
    expect(getModelPickerGroups(grouped, '', 'b').visibleOptions).toEqual([options[2]!])
    expect(getModelPickerGroups(grouped, '', null).visibleOptions).toEqual([])
  })
  test('搜索跨渠道保留同名模型归属，支持 ID、别名和渠道名称', () => {
    expect(getModelPickerGroups(grouped, ' GPT-6 ', null).visibleOptions).toEqual([options[0]!, options[2]!])
    expect(getModelPickerGroups(grouped, 'kimi', 'b').visibleOptions).toEqual([options[1]!])
    expect(getModelPickerGroups(grouped, '渠道 B', 'a').visibleOptions).toEqual([options[2]!])
    expect(getModelPickerGroups(grouped, 'missing', 'a').groups.size).toBe(0)
  })
  test('清空搜索恢复当前渠道，独立调用不修改其他选择器', () => {
    getModelPickerGroups(grouped, 'GPT', 'b')
    expect(getModelPickerGroups(grouped, '', 'a').visibleOptions).toEqual(options.slice(0, 2))
    expect(getModelPickerGroups(grouped, '', 'b').visibleOptions).toEqual([options[2]!])
    expect(grouped.get('a')).toHaveLength(2)
  })
  test('方向键从首尾开始，循环且空列表不选中', () => {
    expect(nextModelHighlight(-1, 2, 'down')).toBe(0)
    expect(nextModelHighlight(-1, 2, 'up')).toBe(1)
    expect(nextModelHighlight(1, 2, 'down')).toBe(0)
    expect(nextModelHighlight(0, 2, 'up')).toBe(1)
    expect(nextModelHighlight(0, 0, 'down')).toBe(-1)
  })
})

describe('共享选择器接线契约（不替代浏览器实测）', () => {
  const source = readFileSync(new URL('./ModelSelector.tsx', import.meta.url), 'utf8')
  test('浮层锚定按钮上方，右对齐并限制可用高度', () => {
    expect(source).toContain("side = 'top'")
    expect(source).toContain('side={side}')
    expect(source).toContain("align = 'end'")
    expect(source).toContain('collisionPadding={12}')
    expect(source).toContain('--radix-popover-content-available-height')
    expect(source).not.toContain('<Dialog')
  })
  test('明确选中态、自动滚动、选择关闭和搜索聚焦仍存在', () => {
    expect(source).toContain('aria-pressed={isSelected}')
    expect(source).toContain('{isSelected && <Check')
    expect(source).toContain("scrollIntoView({ block: 'nearest' })")
    expect(source).toContain('setOpen(false)')
    expect(source).toContain('searchRef.current?.focus()')
    expect(source).toContain('setExpandedChannel(selectedModel?.channelId ?? null)')
  })
  test('Work 保留父卡片，将独立模型列表嵌套在模型行', () => {
    const work = readFileSync(new URL('../agent/AgentView.tsx', import.meta.url), 'utf8')
    const component = work.slice(work.indexOf('function AgentThinkingPopover('), work.indexOf('export function AgentView('))
    expect(component).toContain('const [open, setOpen] = React.useState(false)')
    expect(component).toContain('useAtom(modelSelectorOpenAtom)')
    expect(component).not.toContain('side="left"')
    expect(component).toContain('setModelListOpen(false)')
    expect(component).not.toContain('compactContent')
    const nestedStart = component.indexOf('<ModelSelector')
    const nestedEnd = component.indexOf('/>', nestedStart)
    const nested = component.slice(nestedStart, nestedEnd)
    expect(nestedStart).toBeGreaterThan(component.indexOf('<PopoverContent'))
    expect(component.lastIndexOf('</PopoverContent>')).toBeGreaterThan(nestedEnd)
    expect(nested).not.toContain('restoreFocusOnClose')
    expect(nested).toContain('side="top"')
    expect(nested).toContain('align="end"')
    expect(nested).toContain('flex h-10 w-full')
    expect(source).toContain('sideOffset={8}')
    expect(source).toContain('--radix-popover-content-available-height')
    expect(component.indexOf('checked={isEnabled}')).toBeGreaterThan(nestedEnd)
    expect(source).not.toContain('showModels')
    expect(source).not.toContain('compactContent')
  })
  test('悬停使用 CSS，不写入键盘索引；移动或离开清理键盘背景', () => {
    expect(source).not.toContain('onMouseEnter={() => setHighlightIndex(currentFlatIndex)}')
    expect(source).toContain('onPointerMove={() => setHighlightIndex(-1)}')
    expect(source).toContain('onPointerLeave={() => setHighlightIndex(-1)}')
    expect(source).toContain("'hover:bg-accent'")
    expect(source).toContain("nextModelHighlight(prev, flatOptions.length, 'down')")
    expect(source).toContain('aria-pressed={isSelected}')
  })
  test('侧聊复用共享组件，使用外部模型与回调且不加入主会话打开状态', () => {
    const side = readFileSync(new URL('../agent/side-chat/SideChatPanel.tsx', import.meta.url), 'utf8')
    expect(side).toContain('<ModelSelector')
    expect(side).toContain('externalSelectedModel=')
    expect(side).toContain('onModelSelect=')
    expect(side).not.toContain('useSharedOpenState')
  })
})

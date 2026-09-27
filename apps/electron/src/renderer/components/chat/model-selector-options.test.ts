import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { ModelOption } from '@domi/shared'
import { getModelDisplayName, getModelPickerGroups, groupByChannel, nextModelHighlight } from './model-selector-options'

const options: ModelOption[] = [
  { channelId: 'a', channelName: '渠道 A', modelId: 'gpt-6', modelName: 'GPT', provider: 'openai' },
  { channelId: 'a', channelName: '渠道 A', modelId: 'kimi-k3', modelName: 'Kimi', provider: 'openai' },
  { channelId: 'b', channelName: '渠道 B', modelId: 'gpt-6', modelName: 'GPT', provider: 'openai' },
]
const grouped = groupByChannel(options)

describe('模型显示名称', () => {
  test('未设置别名时将常见 ID 展示为易读名称，不改 ID', () => {
    expect(getModelDisplayName('gpt-6-sol', 'gpt-6-sol')).toBe('GPT-6 Sol')
    expect(getModelDisplayName('glm-5.3-flash', 'glm-5.3-flash')).toBe('GLM-5.3 Flash')
    expect(getModelDisplayName('kimi-k2-code', 'kimi-k2-code')).toBe('Kimi K2 Code')
  })
  test('自定义名称优先；复杂路径或原始模型标识不推断', () => {
    expect(getModelDisplayName('我常用的模型', 'gpt-6-sol')).toBe('我常用的模型')
    expect(getModelDisplayName('vendor/gpt-6-sol', 'vendor/gpt-6-sol')).toBe('vendor/gpt-6-sol')
    expect(getModelDisplayName('gpt-6_sol', 'gpt-6_sol')).toBe('gpt-6_sol')
    expect(getModelDisplayName('claude-opus-4-6', 'claude-opus-4-6')).toBe('claude-opus-4-6')
  })
})

describe('模型选择的可见选项', () => {
  test('默认按渠道顺序展示所有模型，键盘导航覆盖完整列表', () => {
    const result = getModelPickerGroups(grouped, '')
    expect([...result.groups.keys()]).toEqual(['a', 'b'])
    expect(result.visibleOptions).toEqual(options)
  })
  test('搜索跨渠道保留同名模型归属，支持 ID、别名和渠道名称', () => {
    expect(getModelPickerGroups(grouped, ' GPT-6 ').visibleOptions).toEqual([options[0]!, options[2]!])
    expect(getModelPickerGroups(grouped, 'kimi').visibleOptions).toEqual([options[1]!])
    expect(getModelPickerGroups(grouped, '渠道 B').visibleOptions).toEqual([options[2]!])
    expect(getModelPickerGroups(grouped, 'missing').groups.size).toBe(0)
  })
  test('可搜索格式化后的显示名，同时选项仍使用原 ID', () => {
    const entry: ModelOption = { channelId: 'c', channelName: '渠道 C', modelId: 'gpt-6-sol', modelName: 'gpt-6-sol', provider: 'openai' }
    expect(getModelPickerGroups(groupByChannel([entry]), 'GPT-6 Sol').visibleOptions).toEqual([entry])
  })
  test('清空搜索恢复所有渠道，独立调用不修改分组', () => {
    getModelPickerGroups(grouped, 'GPT')
    expect(getModelPickerGroups(grouped, '').visibleOptions).toEqual(options)
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
    expect(source).toContain("getModelPickerGroups(grouped, search)")
    expect(source).not.toContain('setExpandedChannel')
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
  test('渠道使用紧凑标题、模型行无需重复图标，悬停不写入键盘索引', () => {
    expect(source).toContain('tracking-wide text-muted-foreground/70')
    expect(source).not.toContain('uppercase tracking-wider')
    expect(source).not.toContain('getChannelLogo')
    expect(source).not.toContain('getModelLogo')
    expect(source).toContain('getModelDisplayName(option.modelName, option.modelId)')
    expect(source).not.toContain('onMouseEnter={() => setHighlightIndex(currentFlatIndex)}')
    expect(source).toContain('onPointerMove={() => setHighlightIndex(-1)}')
    expect(source).toContain('onPointerLeave={() => setHighlightIndex(-1)}')
    expect(source).toContain("'hover:bg-accent'")
    expect(source).toContain("nextModelHighlight(prev, flatOptions.length, 'down')")
    expect(source).toContain('aria-pressed={isSelected}')
  })
  test('输入区去掉模型 Logo，发送按钮统一使用圆形上箭头', () => {
    const chat = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8')
    const work = readFileSync(new URL('../agent/AgentView.tsx', import.meta.url), 'utf8')
    const styles = readFileSync(new URL('../ai-elements/input-toolbar-styles.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('<BrandLogo')
    expect(work).not.toContain('modelLogo=')
    expect(work).toContain('getModelDisplayName(selectedModelOption.modelName, selectedModelOption.modelId)')
    expect(chat).toContain('<ArrowUp className="size-[17px]"')
    expect(work).toContain('<ArrowUp className="size-[17px]"')
    expect(styles).toContain('rounded-full bg-foreground text-background')
    expect(styles).toContain('rounded-full bg-muted text-muted-foreground/50')
  })
  test('侧聊复用共享组件，使用外部模型与回调且不加入主会话打开状态', () => {
    const side = readFileSync(new URL('../agent/side-chat/SideChatPanel.tsx', import.meta.url), 'utf8')
    expect(side).toContain('<ModelSelector')
    expect(side).toContain('externalSelectedModel=')
    expect(side).toContain('onModelSelect=')
    expect(side).not.toContain('useSharedOpenState')
  })
})

import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  firstEnabledPickerIndex,
  lastEnabledPickerIndex,
  movePickerFocusIndex,
  SlashPickerMenuList,
  type SlashPickerOption,
} from './SlashPickerMenu'

const options: SlashPickerOption[] = [
  { value: 'off', label: 'Off' },
  { value: 'low', label: 'Low' },
  { value: 'disabled-opt', label: '不可选', disabled: true },
  { value: 'high', label: 'High' },
]

describe('movePickerFocusIndex', () => {
  test('空选项返回 -1', () => {
    expect(movePickerFocusIndex(0, 1, [])).toBe(-1)
  })

  test('向下/向上正常移动', () => {
    expect(movePickerFocusIndex(0, 1, options)).toBe(1)
    expect(movePickerFocusIndex(1, -1, options)).toBe(0)
  })

  test('跳过 disabled 项', () => {
    expect(movePickerFocusIndex(1, 1, options)).toBe(3)
    expect(movePickerFocusIndex(3, -1, options)).toBe(1)
  })

  test('到达边界后停止', () => {
    expect(movePickerFocusIndex(0, -1, options)).toBe(0)
    expect(movePickerFocusIndex(3, 1, options)).toBe(3)
  })

  test('当前索引不合法时（-1）向下落到第一个可用项', () => {
    expect(movePickerFocusIndex(-1, 1, options)).toBe(0)
  })
})

describe('firstEnabledPickerIndex / lastEnabledPickerIndex', () => {
  test('返回第一个/最后一个可用项', () => {
    expect(firstEnabledPickerIndex(options)).toBe(0)
    expect(lastEnabledPickerIndex(options)).toBe(3)
  })

  test('全部 disabled 返回 -1', () => {
    const allDisabled = options.map((o) => ({ ...o, disabled: true }))
    expect(firstEnabledPickerIndex(allDisabled)).toBe(-1)
    expect(lastEnabledPickerIndex(allDisabled)).toBe(-1)
  })
})

describe('SlashPickerMenuList', () => {
  const noop = (): void => {}

  function renderList(overrides: Partial<Parameters<typeof SlashPickerMenuList>[0]> = {}): string {
    return renderToStaticMarkup(
      <SlashPickerMenuList
        title="调整推理深度"
        options={options}
        activeValue="high"
        focusIndex={1}
        listboxId="test-listbox"
        onKeyDown={noop}
        onSelect={noop}
        onFocusOption={noop}
        optionRef={noop}
        {...overrides}
      />,
    )
  }

  test('渲染 listbox 与 aria-label', () => {
    const html = renderList()
    expect(html).toContain('role="listbox"')
    expect(html).toContain('aria-label="调整推理深度"')
  })

  test('每个选项带 role=option，选中项 aria-selected=true', () => {
    const html = renderList()
    expect(html).toContain('role="option"')
    // high 是 activeValue
    expect(html).toContain('aria-selected="true"')
    expect(html.match(/role="option"/g)?.length).toBe(options.length)
  })

  test('disabled 选项带 disabled 属性', () => {
    const html = renderList()
    expect(html).toContain('disabled=""')
  })

  test('聚焦项带 focus 高亮类', () => {
    const html = renderList({ focusIndex: 0 })
    // 第一项 Off 应有聚焦高亮
    expect(html).toContain('bg-accent/70')
  })

  test('选中项显示 Check 勾选图标', () => {
    const html = renderList()
    // lucide Check 渲染为 svg
    expect(html).toContain('<svg')
  })
})

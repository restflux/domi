import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { shouldInsetMacCollapsedTabs } from './TabBar'

const source = readFileSync(resolve(import.meta.dir, 'TabBar.tsx'), 'utf8')

test('Given macOS 现代侧栏收起 When 标签显示 Then 标题在顶部开合按钮右侧且不随标签滚动', () => {
  expect(shouldInsetMacCollapsedTabs(true, true, true)).toBe(true)
  expect(shouldInsetMacCollapsedTabs(true, true, false)).toBe(false)
  expect(shouldInsetMacCollapsedTabs(true, false, true)).toBe(false)
  expect(shouldInsetMacCollapsedTabs(false, true, true)).toBe(false)

  const spacer = source.indexOf('insetForWindowControls && <div aria-hidden="true" className="h-full w-[76px] shrink-0" />')
  expect(spacer).toBeGreaterThan(-1)
  expect(spacer).toBeLessThan(source.indexOf('ref={scrollRef}', spacer))
  // 折叠轨道 52px + 预留区 76px，首个标签从 x=128 起；按钮右沿 x=116。
  expect(52 + 76).toBeGreaterThan(88 + 28)
  expect(source).toContain("isMac && insetForWindowControls && 'left-[76px]'")
})

test('现代顶栏标签和右侧操作垂直居中，经典标签结构保持独立', () => {
  expect(source).toContain("isModern ? 'h-[46px] items-center' : 'h-[34px] items-end'")
  expect(source).toContain("isModern ? 'items-center' : 'items-end pb-[3px]'")
})

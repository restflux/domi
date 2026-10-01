import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * 终端主题 token 契约：terminalTheme.ts 读取的每个 --color-terminal-* 变量
 * 必须在 globals.css 的浅色与深色两段中都有定义，否则 xterm 回退到深色 fallback，
 * 浅色模式下出现深色终端块（用户实际报告过的回归）。
 */
const css = readFileSync(new URL('../../../styles/globals.css', import.meta.url), 'utf8')
const themeModule = readFileSync(new URL('./terminalTheme.ts', import.meta.url), 'utf8')

const tokenNames = [...new Set([...themeModule.matchAll(/--color-terminal-[a-z-]+/g)].map((match) => match[0]))]

test('every terminal theme token is defined in globals.css', () => {
  expect(tokenNames.length).toBeGreaterThanOrEqual(22)
  for (const token of tokenNames) {
    const occurrences = css.split(token).length - 1
    // 至少出现两次：:root 浅色块 + .dark 深色块。
    expect(occurrences >= 2, `${token} should be defined for light and dark`).toBe(true)
  }
})

test('light and dark terminal backgrounds differ from the dark fallback', () => {
  const backgrounds = [...css.matchAll(/--color-terminal-bg:\s*([^;]+);/g)].map((match) => match[1]?.trim() ?? '')
  expect(new Set(backgrounds).size).toBe(2)
  expect(backgrounds).toContain('#fafafa')
  expect(backgrounds).toContain('#171717')
})

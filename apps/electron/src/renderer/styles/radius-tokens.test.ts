import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const styles = readFileSync(resolve(import.meta.dir, 'globals.css'), 'utf8')
const tailwind = readFileSync(resolve(import.meta.dir, '../../../tailwind.config.js'), 'utf8')

test('圆角 token 保持统一的语义尺度', () => {
  expect(styles).toContain('--radius-sm: 6px;')
  expect(styles).toContain('--radius-md: 8px;')
  expect(styles).toContain('--radius-lg: 10px;')
  expect(styles).toContain('--radius-xl: 12px;')
  expect(styles).toContain('--radius-2xl: 16px;')
  expect(styles).toContain('--radius-cap: var(--radius-lg);')

  expect(tailwind).toContain("sm: 'var(--radius-sm)'")
  expect(tailwind).toContain("md: 'var(--radius-md)'")
  expect(tailwind).toContain("lg: 'var(--radius-lg)'")
  expect(tailwind).toContain("xl: 'var(--radius-xl)'")
  expect(tailwind).toContain("'2xl': 'var(--radius-2xl)'")
})

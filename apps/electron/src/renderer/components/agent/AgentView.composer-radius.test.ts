import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const styles = readFileSync(resolve(import.meta.dir, '../../styles/globals.css'), 'utf8')

test('现代普通 Work 输入框使用 20px 主输入圆角，Plan 与经典样式不变', () => {
  expect(styles).toContain(':root:not(.ui-classic) .agent-composer-surface {')
  expect(styles).toContain('border-radius: var(--radius-lg);')
  expect(styles).toContain('background-color: hsl(var(--input-surface)) !important;')
  expect(styles).toContain(':root.ui-modern .agent-composer-surface:not(.plan-mode-border)')
  expect(styles).toContain('--radius-input: 20px;')
  expect(styles).toContain('border-radius: var(--radius-input);')
  expect(styles).toContain('.theme-terminal-dark [class*="rounded"]:not(.sticky-return-question-button)')
})
